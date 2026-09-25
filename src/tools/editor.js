// Visual PDF editor: add text, images, signatures, shapes, whiteout, highlights and freehand ink,
// and edit text that already exists in the PDF.
// Objects are stored in "visual points" (1/72 inch, top-left origin, y down, as the page is displayed)
// so they're independent of the on-screen zoom level.
import { BlendMode, LineCapStyle, degrees } from '@cantoo/pdf-lib';
import { el, withBusy, download, toast, field, select, baseName, pickFiles } from '../lib/ui.js';
import { openForEdit, openForRender, renderPage, saveDoc, canvasToBlob, blobToBytes, ANNOTATION_MODE } from '../lib/pdf.js';
import { FONTS, fontOf, fontStyles, loadFonts, pageFrame, hexToRgb, drawTextVisual, drawImageVisual, drawRectVisual } from '../lib/stamp.js';
import { pdfImageData, embedImageData } from '../lib/image.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';
import { openSignaturePad } from '../lib/signature.js';

const LINE_HEIGHT = 1.2;

const baselineCache = new Map();
/**
 * Where the browser puts the first baseline of a text box in the given font shown at `px` CSS
 * pixels, as a fraction of the font size, measured with a zero-height inline-block. Browsers round
 * the ascent, descent and half-leading to whole pixels, so this depends on the displayed size
 * (e.g. Times at 100% zoom sits at 0.918em, not the 0.938em its metrics give), and the fonts behind
 * the CSS families differ per OS. Checked against painted pixels in Chrome at DPR 1-3: mean error
 * ~0 (vs ~0.5px, up to 1.5px, for the fixed `baseline` fractions in FONTS, now only a fallback).
 */
function baselineEm(fontKey, px) {
  const key = `${fontKey}|${px.toFixed(3)}`;
  if (!baselineCache.has(key)) {
    const probe = document.createElement('div');
    const mark = document.createElement('span');
    Object.assign(probe.style, {
      position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', whiteSpace: 'pre',
      ...fontStyles(fontKey), fontSize: `${px}px`, lineHeight: LINE_HEIGHT,
    });
    Object.assign(mark.style, { display: 'inline-block', width: '0', height: '0' });
    probe.append('x', mark);
    document.body.append(probe);
    const em = (mark.getBoundingClientRect().bottom - probe.getBoundingClientRect().top) / px;
    probe.remove();
    if (baselineCache.size > 200) baselineCache.clear();
    baselineCache.set(key, em > 0.5 && em < 1.5 ? em : fontOf(fontKey).baseline);
  }
  return baselineCache.get(key);
}

const TOOL_ICONS = {
  select: '<path d="M5 3l14 8-6 2-3 6z"/>',
  text: '<path d="M5 5h14M12 5v14M9 19h6"/>',
  edittext: '<path d="M4 7V5h11v2M9.5 5v12M7.5 17h4"/><path d="m14 20 .8-3.2L19.5 12l2.4 2.4-4.7 4.8z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  signature: '<path d="M3 17c3-1 4-9 7-9s-1 9 2 9 3-4 5-4 2 3 4 3"/><path d="M3 21h18"/>',
  draw: '<path d="M4 20c4 0 4-4 8-4s4 4 8 4"/><path d="m14 4 6 6-8 8H6v-6z"/>',
  whiteout: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M7 10h10M7 14h6" opacity=".35"/>',
  highlight: '<path d="m9 11 6 6"/><path d="M4 20h7l9-9-7-7-9 9z"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
};

// [id, tooltip, short label]
const TOOLS = [
  ['select', 'Select / move', 'Select'],
  ['text', 'Add text', 'Text'],
  ['edittext', 'Edit existing text', 'Edit text'],
  ['image', 'Add image', 'Image'],
  ['signature', 'Signature', 'Sign'],
  ['draw', 'Freehand draw', 'Draw'],
  ['whiteout', 'Whiteout (erase)', 'Whiteout'],
  ['highlight', 'Highlight', 'Highlight'],
  ['rect', 'Rectangle', 'Shape'],
];

function toolIcon(name) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TOOL_ICONS[name]}</svg>`;
}

function editable(node) {
  try {
    node.contentEditable = 'plaintext-only';
  } catch {
    node.contentEditable = 'true';
  }
}

async function imageFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    // the size shown and the bytes saved must agree: EXIF-rotated JPEGs etc. are re-encoded upright
    const { bytes, mime } = await pdfImageData(file, img);
    return { bytes, mime, url, img, width: img.naturalWidth, height: img.naturalHeight };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// ---------- existing text ----------

/** Multiply two affine matrices [a b c d e f] (same as pdf.js Util.transform). */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * Group pdf.js text items into horizontal runs (one per line segment) in visual points.
 * Each run: { x, base (baseline y), size, w, text, fontName, family, box: {x, y, w, h} }.
 */
function textRuns(content, viewport) {
  const runs = [];
  let cur = null;
  const end = () => {
    if (cur && cur.text.trim()) runs.push({ ...cur, text: cur.text.trimEnd() });
    cur = null;
  };
  for (const item of content.items) {
    if (!('str' in item)) continue; // marked-content markers
    const t = mul(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]);
    // only text that reads left-to-right on screen (after the page's /Rotate) can be edited
    const horizontal = size > 0 && t[0] > 0 && Math.abs(t[1]) < 0.02 * t[0] && Math.abs(t[2]) < 0.02 * size;
    if (!horizontal) {
      end();
      continue;
    }
    if (!item.str) {
      if (item.hasEOL) end();
      continue;
    }
    const x = t[4], base = t[5];
    if (cur) {
      const gap = x - (cur.x + cur.w);
      const sameLine = Math.abs(base - cur.base) < 0.3 * cur.size && Math.abs(size - cur.size) < 0.3 * cur.size;
      if (!sameLine || gap < -0.5 * size || gap > 1.2 * size) end();
      else if (gap > 0.15 * size && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) cur.text += ' ';
    }
    if (!cur) {
      if (!item.str.trim()) continue;
      const style = content.styles[item.fontName] || {};
      cur = { x, base, size, w: 0, text: '', fontName: item.fontName, family: style.fontFamily, ascent: style.ascent, descent: style.descent };
    }
    cur.text += item.str;
    cur.w = Math.max(cur.w, x + item.width * viewport.scale - cur.x);
    if (item.hasEOL) end();
  }
  end();
  return runs.map((r) => {
    const asc = r.ascent > 0.5 && r.ascent < 1.3 ? r.ascent : 0.9;
    const desc = r.descent < 0 && r.descent > -0.6 ? -r.descent : 0.22;
    const pad = r.size * 0.08;
    return { ...r, box: { x: r.x - pad, y: r.base - asc * r.size - pad, w: r.w + pad * 2, h: (asc + desc) * r.size + pad * 2 } };
  });
}

/**
 * Pick the closest standard font for a pdf.js font. The PostScript name decides when it names a known
 * family; otherwise the generic family pdf.js derived from the font's flags (`family`) does. (Words
 * like "Roman" or "Book" are weight names in many sans fonts, e.g. "Frutiger-Roman", so they don't count.)
 */
function guessFont(fontObj, family) {
  const name = String(fontObj?.name || '').replace(/^[A-Z]{6}\+/, ''); // drop the subset tag
  const bold = !!(fontObj?.bold || fontObj?.black) || /bold|black|heavy|semibold|demi/i.test(name);
  const italic = !!fontObj?.italic || /italic|oblique|slanted/i.test(name);
  let group;
  if (/mono|courier|consol|menlo|typewriter/i.test(name) || family === 'monospace') group = 'courier';
  else if (/sans|arial|helvet|verdana|tahoma|calibri|segoe|roboto|frutiger|avenir|futura|gill|franklin|univers|myriad|lato|inter\b/i.test(name)) group = 'helvetica';
  else if (/times|serif|georgia|garamond|cambria|minion|palatino|antiqua|baskerville|bodoni|caslon|century|didot|charter|book ?man/i.test(name)) group = 'times';
  else group = family === 'serif' ? 'times' : 'helvetica';
  const slant = group === 'times' ? 'italic' : 'oblique';
  return [group, bold && 'bold', italic && slant].filter(Boolean).join('-');
}

const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Sample the rendered page: background = most common colour just outside the box, text = the most contrasting pixel inside. */
function sampleColors(info, box) {
  const fallback = { bg: '#ffffff', fg: '#000000' };
  const k = info.canvas.width / info.vw; // canvas px per point
  const m = 2;
  const x0 = Math.max(0, Math.floor(box.x * k) - m), y0 = Math.max(0, Math.floor(box.y * k) - m);
  const x1 = Math.min(info.canvas.width, Math.ceil((box.x + box.w) * k) + m), y1 = Math.min(info.canvas.height, Math.ceil((box.y + box.h) * k) + m);
  const W = x1 - x0, H = y1 - y0;
  if (W < 2 * m + 1 || H < 2 * m + 1) return fallback;
  let data;
  try {
    data = info.canvas.getContext('2d').getImageData(x0, y0, W, H).data;
  } catch {
    return fallback;
  }
  const bins = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= m && x < W - m && y >= m && y < H - m) continue;
      const i = (y * W + x) * 4;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
      bins.set(key, b);
    }
  }
  let top = null;
  for (const b of bins.values()) if (!top || b.n > top.n) top = b;
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n];
  let best = 0, fg = null;
  for (let y = m; y < H - m; y++) {
    for (let x = m; x < W - m; x++) {
      const i = (y * W + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > best) [best, fg] = [d, [data[i], data[i + 1], data[i + 2]]];
    }
  }
  if (!fg || best < 90 || Math.max(...fg) < 60) fg = [0, 0, 0];
  return { bg: toHex(bg), fg: toHex(fg) };
}

function mountEditor(container, meta, { signMode = false } = {}) {
  return singlePdfTool(container, meta, async ({ file, bytes, pdf, layout }) => {
    layout.work.classList.add('editor-work');
    const state = {
      tool: 'select',
      selected: null,
      zoom: 1,
      props: { font: 'helvetica', size: 16, color: '#000000', opacity: 1, stroke: 2 },
    };
    const objects = new Set();
    const history = []; // undo stack: functions that return true if they undid something
    let nextId = 1;

    // ---------- toolbar ----------
    const toolButtons = new Map();
    const toolbar = el('div', { class: 'ed-toolbar' });
    for (const [name, label, short] of TOOLS) {
      const b = el('button', { type: 'button', class: 'ed-tool', title: label, 'aria-label': label, html: toolIcon(name) });
      b.append(el('span', {}, short));
      b.addEventListener('click', () => setTool(name));
      toolButtons.set(name, b);
      toolbar.append(b);
    }
    const zoomLabel = el('span', { class: 'zoom-label' }, '100%');
    toolbar.append(el('span', { class: 'ed-sep' }), el('div', { class: 'ed-controls' },
      el('button', { type: 'button', class: 'ed-tool small', title: 'Undo', 'aria-label': 'Undo', onClick: undo, html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>' }),
      el('button', { type: 'button', class: 'ed-tool small', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => setZoom(state.zoom / 1.2) }, '−'),
      zoomLabel,
      el('button', { type: 'button', class: 'ed-tool small', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => setZoom(state.zoom * 1.2) }, '+'),
    ));

    // ---------- properties panel ----------
    const fontSel = select(Object.entries(FONTS).map(([k, f]) => [k, f.label]), state.props.font);
    const sizeInput = el('input', { type: 'number', min: 4, max: 200, value: state.props.size });
    const colorInput = el('input', { type: 'color', value: state.props.color });
    const opacityInput = el('input', { type: 'range', min: 10, max: 100, value: 100 });
    const strokeInput = el('input', { type: 'range', min: 1, max: 20, value: state.props.stroke });
    const fFont = field('Font', fontSel);
    const fSize = field('Size', sizeInput);
    const fColor = field('Color', colorInput);
    const fOpacity = field('Opacity', opacityInput);
    const fStroke = field('Line width', strokeInput);
    const propsTitle = el('h3', {}, 'Properties');
    const deleteBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm danger', onClick: () => state.selected && deleteObj(state.selected) }, 'Delete selected');
    const propsPanel = el('div', { class: 'panel' }, propsTitle,
      el('div', { class: 'row' }, fFont, fSize), el('div', { class: 'row' }, fColor, fStroke), fOpacity, deleteBtn);

    const hint = el('p', { class: 'muted ed-hint' });
    const HINTS = {
      select: 'Click an item to select it, drag to move, use the corner handle to resize. Press Delete to remove.',
      text: 'Click anywhere on a page to add a text box.',
      edittext: 'Click any highlighted text in the document to change it. Delete it to erase the original text.',
      image: 'Choose an image to place on the current page.',
      signature: 'Create a signature, then drag it into place.',
      draw: 'Draw freely on the page with your mouse, pen or finger.',
      whiteout: 'Drag over content to cover it with white. Add text on top to “replace” it.',
      highlight: 'Drag over text to highlight it.',
      rect: 'Drag to draw a rectangle outline.',
    };

    function refreshProps() {
      const o = state.selected;
      const kind = o ? o.type : state.tool;
      const isText = kind === 'text';
      const hasColor = kind !== 'image';
      fFont.hidden = fSize.hidden = !isText;
      fColor.hidden = !hasColor;
      fStroke.hidden = !(kind === 'draw' || kind === 'ink' || (o ? o.type === 'rect' && o.variant === 'rect' : kind === 'rect'));
      deleteBtn.hidden = !o;
      propsTitle.textContent = o ? `Selected: ${o.orig ? 'existing text' : o.variant || o.type}` : 'Properties';
      if (o) {
        if (o.font) fontSel.value = o.font;
        if (o.size) sizeInput.value = Math.round(o.size);
        colorInput.value = o.color || '#000000';
        opacityInput.value = Math.round((o.opacity ?? 1) * 100);
        if (o.stroke) strokeInput.value = o.stroke;
      } else {
        const p = state.props;
        fontSel.value = p.font;
        sizeInput.value = p.size;
        colorInput.value = kind === 'highlight' ? '#ffe600' : kind === 'whiteout' ? '#ffffff' : kind === 'rect' ? '#e5322d' : p.color;
        opacityInput.value = Math.round((kind === 'highlight' ? 0.45 : p.opacity) * 100);
      }
      hint.textContent = HINTS[state.tool];
      propsPanel.hidden = !o && ['select', 'edittext', 'image', 'signature'].includes(state.tool);
    }

    // property edits on the selected object are grouped into one undo step per control interaction
    let pending = null;
    function commitPending() {
      if (pending && objects.has(pending.o)) recordChange(pending.o, pending.before);
      pending = null;
    }
    function applyProp(key, value) {
      const o = state.selected;
      if (!o) {
        if (key in state.props && !['highlight', 'whiteout', 'rect'].includes(state.tool)) state.props[key] = value;
        return;
      }
      if (pending?.o !== o) {
        commitPending();
        pending = { o, before: snapshot(o) };
      }
      o[key] = value;
      render(o);
    }
    fontSel.addEventListener('change', () => applyProp('font', fontSel.value));
    sizeInput.addEventListener('input', () => applyProp('size', Math.max(4, Number(sizeInput.value) || 12)));
    colorInput.addEventListener('input', () => applyProp('color', colorInput.value));
    opacityInput.addEventListener('input', () => applyProp('opacity', opacityInput.value / 100));
    strokeInput.addEventListener('input', () => applyProp('stroke', Number(strokeInput.value)));
    [fontSel, sizeInput, colorInput, opacityInput, strokeInput].forEach((c) => c.addEventListener('change', commitPending));
    // keep text focus when using the panel
    propsPanel.addEventListener('mousedown', (e) => e.target.tagName === 'DIV' && e.preventDefault());

    function currentStyle() {
      return {
        color: colorInput.value,
        opacity: opacityInput.value / 100,
        stroke: Number(strokeInput.value),
      };
    }

    // ---------- pages ----------
    const pagesBox = el('div', { class: 'ed-pages' });
    layout.work.append(toolbar, pagesBox);
    // Whiteout and edited text only cover the original visually; its text stays extractable unless flattened.
    const redactBox = el('input', { type: 'checkbox', checked: true });
    layout.side.append(
      panel('Tip', hint),
      propsPanel,
      panel('Privacy',
        el('label', { class: 'check-row' }, redactBox, 'Permanently remove covered text'),
        el('small', { class: 'help' }, 'Pages with whiteout or edited text are flattened into images on save, so the hidden text can’t be copied or recovered. Untick to keep those pages as selectable text.')),
      actionButton('Save & download', save),
    );

    // metric-compatible fallback fonts (where needed) must be ready before text is measured or shown
    await loadFonts();
    baselineCache.clear();
    const pages = [];
    const baseWidth = Math.max(280, Math.min(pagesBox.clientWidth - 24, 900));
    for (let i = 1; i <= pdf.numPages; i++) {
      let page;
      try {
        page = await pdf.getPage(i);
      } catch (err) {
        if (!pagesBox.isConnected) return; // left the tool while loading: the document was destroyed
        throw err;
      }
      if (!pagesBox.isConnected) return;
      const vp = page.getViewport({ scale: 1 });
      const canvas = el('canvas', { class: 'ed-canvas' });
      const layer = el('div', { class: 'ed-layer' });
      const wrap = el('div', { class: 'ed-page', 'data-index': i - 1 }, canvas, layer, el('div', { class: 'ed-page-num' }, `${i} / ${pdf.numPages}`));
      const info = { index: i - 1, page, vw: vp.width, vh: vp.height, fit: baseWidth / vp.width, wrap, canvas, layer, renderedAt: 0, token: 0, runs: null };
      pages.push(info);
      pagesBox.append(wrap);
      bindLayer(info);
    }
    const scaleOf = (info) => info.fit * state.zoom;

    const renderObserver = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && renderCanvas(pages[e.target.dataset.index])),
      { root: null, rootMargin: '600px' },
    );

    function layoutPages() {
      for (const info of pages) {
        const s = scaleOf(info);
        info.wrap.style.width = `${info.vw * s}px`;
        info.wrap.style.height = `${info.vh * s}px`;
        renderObserver.unobserve(info.wrap);
        renderObserver.observe(info.wrap);
      }
      objects.forEach(render);
      zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    async function renderCanvas(info) {
      const s = scaleOf(info);
      if (info.renderedAt === s) return;
      info.renderedAt = s;
      const token = ++info.token;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = info.page.getViewport({ scale: s * dpr });
      const off = document.createElement('canvas');
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      await info.page.render({ canvas: off, viewport, annotationMode: ANNOTATION_MODE }).promise;
      if (token !== info.token) return;
      info.canvas.width = off.width;
      info.canvas.height = off.height;
      info.canvas.getContext('2d').drawImage(off, 0, 0);
      // fonts are resolved once the page has rendered, so the text runs can be matched to them
      if (!info.runs) loadRuns(info).catch((err) => console.warn('Could not read page text', err));
    }

    /** Overlay a clickable box on every run of existing text (shown only with the Edit text tool). */
    async function loadRuns(info) {
      info.runs = [];
      const viewport = info.page.getViewport({ scale: 1 });
      const runs = textRuns(await info.page.getTextContent(), viewport);
      const pct = (v, total) => `${(v / total) * 100}%`;
      for (const run of runs) {
        const { box } = run;
        run.el = el('div', {
          class: 'ed-run',
          title: 'Click to edit this text',
          style: { left: pct(box.x, info.vw), top: pct(box.y, info.vh), width: pct(box.w, info.vw), height: pct(box.h, info.vh) },
        });
        run.el.addEventListener('pointerdown', (e) => {
          if (state.tool !== 'edittext' || e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          editRun(info, run);
        });
      }
      info.runs = runs;
      info.layer.prepend(...runs.map((r) => r.el));
    }

    function editRun(info, run) {
      let fontObj = null;
      try {
        if (info.page.commonObjs.has(run.fontName)) fontObj = info.page.commonObjs.get(run.fontName);
      } catch {
        /* font not resolved: fall back to the style's generic family */
      }
      const font = guessFont(fontObj, run.family);
      const { bg, fg } = sampleColors(info, run.box);
      const o = addObj({
        type: 'text', page: info.index, x: run.x, y: run.base - run.size * baselineEm(font, run.size * scaleOf(info)),
        text: run.text, font, size: run.size, color: fg, opacity: 1, orig: { ...run.box, bg }, run,
      });
      o.pristine = JSON.stringify(snapshot(o));
      setTimeout(() => focusText(o));
    }

    function setZoom(z) {
      state.zoom = Math.max(0.4, Math.min(3, z));
      layoutPages();
    }

    function setTool(name) {
      if (name === 'image') return addImage();
      if (name === 'signature') return addSignature();
      state.tool = name;
      toolButtons.forEach((b, k) => b.classList.toggle('active', k === name));
      pagesBox.dataset.tool = name;
      if (name !== 'select') selectObj(null);
      refreshProps();
    }

    function visiblePage() {
      const mid = window.innerHeight / 2;
      let best = pages[0], bestDist = Infinity;
      for (const info of pages) {
        const r = info.wrap.getBoundingClientRect();
        const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
        if (d < bestDist) [best, bestDist] = [info, d];
      }
      return best;
    }

    // ---------- objects ----------
    const GEOMETRY = ['x', 'y', 'w', 'h', 'size', 'text', 'font', 'color', 'opacity', 'stroke'];
    const snapshot = (o) => Object.fromEntries(GEOMETRY.map((k) => [k, o[k]]));

    /** Push an undo step restoring `before`, if anything changed. */
    function recordChange(o, before) {
      if (JSON.stringify(before) === JSON.stringify(snapshot(o))) return;
      history.push(() => {
        if (!objects.has(o)) return false;
        Object.assign(o, before);
        if (o.type === 'text') o.input.textContent = o.text;
        render(o);
        selectObj(o);
        return true;
      });
    }

    function addObj(o, { select: sel = true } = {}) {
      o.id = nextId++;
      objects.add(o);
      const undoAdd = () => objects.has(o) && (removeObj(o, { record: false }), true);
      undoAdd.added = o;
      history.push(undoAdd);
      mountObj(o);
      if (sel) selectObj(o);
      return o;
    }

    function removeObj(o, { record = true } = {}) {
      if (!objects.has(o)) return;
      if (pending?.o === o) commitPending();
      objects.delete(o);
      o.el?.remove();
      o.mask?.remove();
      if (o.run) o.run.el.hidden = false;
      if (state.selected === o) selectObj(null);
      if (record) history.push(() => !objects.has(o) && (restoreObj(o), true));
    }

    function restoreObj(o) {
      const { layer } = pages[o.page];
      objects.add(o);
      if (o.mask) layer.append(o.mask);
      layer.append(o.el);
      if (o.run) o.run.el.hidden = true;
      if (o.type === 'text') o.input.textContent = o.text;
      render(o);
      selectObj(o);
    }

    /** Delete key / × button: existing text is erased first (leaving the cover-up), a second delete restores the original. */
    function deleteObj(o) {
      if (o.orig && o.text) {
        const before = snapshot(o);
        o.text = '';
        o.input.textContent = '';
        recordChange(o, before);
        render(o);
        return;
      }
      removeObj(o);
    }

    function undo() {
      commitPending();
      while (history.length) if (history.pop()()) return;
      toast('Nothing to undo.');
    }

    function selectObj(o) {
      if (state.selected === o) return;
      commitPending();
      state.selected?.el?.classList.remove('selected');
      state.selected = o;
      o?.el?.classList.add('selected');
      refreshProps();
    }

    function mountObj(o) {
      const info = pages[o.page];
      const node = el('div', { class: `ed-obj ed-${o.type}${o.variant ? ` ed-${o.variant}` : ''}` });
      if (o.type === 'text') {
        const t = el('div', { class: 'ed-text-inner', spellcheck: 'false' });
        editable(t);
        t.textContent = o.text || '';
        t.addEventListener('focus', () => (o.before = snapshot(o)));
        t.addEventListener('input', () => (o.text = t.innerText));
        t.addEventListener('blur', () => {
          o.text = t.innerText.replace(/\n+$/, '');
          if (!o.text.trim() && !o.orig) return removeObj(o, { record: false });
          // typing into a box that was only just added is undone together with adding it
          const justAdded = history.at(-1)?.added === o && o.before?.text === (o.orig ? o.orig.text : '');
          if (o.before && !justAdded && objects.has(o)) recordChange(o, o.before);
          o.before = null;
        });
        node.append(t);
        o.input = t;
      } else if (o.type === 'image') {
        node.append(el('img', { src: o.src.url, alt: '', draggable: false }));
      } else if (o.type === 'ink') {
        const d = o.points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
        node.innerHTML = `<svg viewBox="0 0 ${o.w0} ${o.h0}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
      }
      if (o.orig) {
        // covers the original text on screen (and in the saved file) while it's being replaced
        o.orig.text = o.run.text;
        o.mask = el('div', { class: 'ed-mask' });
        o.mask.addEventListener('pointerdown', (e) => {
          if (!['select', 'text', 'edittext'].includes(state.tool) || e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          selectObj(o);
          focusText(o);
        });
        info.layer.append(o.mask);
        o.run.el.hidden = true;
      }
      const handle = el('div', { class: 'ed-handle', title: 'Resize' });
      const del = el('button', { type: 'button', class: 'ed-del', title: 'Delete', onClick: (e) => { e.stopPropagation(); deleteObj(o); } }, '×');
      node.append(handle, del);
      o.el = node;
      info.layer.append(node);
      bindDrag(o, node, handle);
      render(o);
    }

    function render(o) {
      const s = scaleOf(pages[o.page]);
      const n = o.el;
      n.style.left = `${o.x * s}px`;
      n.style.top = `${o.y * s}px`;
      n.style.opacity = o.opacity ?? 1;
      if (o.mask) {
        const b = o.orig;
        Object.assign(o.mask.style, { left: `${b.x * s}px`, top: `${b.y * s}px`, width: `${b.w * s}px`, height: `${b.h * s}px`, background: b.bg });
      }
      if (o.type === 'text') {
        Object.assign(o.input.style, { ...fontStyles(o.font), fontSize: `${o.size * s}px`, color: o.color, lineHeight: LINE_HEIGHT });
        return;
      }
      n.style.width = `${o.w * s}px`;
      n.style.height = `${o.h * s}px`;
      if (o.type === 'rect') {
        n.style.background = o.variant === 'rect' ? 'transparent' : o.color;
        n.style.border = o.variant === 'rect' ? `${o.stroke * s}px solid ${o.color}` : 'none';
      } else if (o.type === 'ink') {
        const path = n.querySelector('path');
        path.setAttribute('stroke', o.color);
        path.setAttribute('stroke-width', o.stroke * s);
      }
    }

    function bindDrag(o, node, handle) {
      node.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.ed-del')) return e.stopPropagation(); // don't let the page deselect before the click lands
        if (!['select', 'text', 'edittext'].includes(state.tool)) return;
        e.stopPropagation();
        const editing = o.type === 'text' && document.activeElement === o.input;
        selectObj(o);
        if (editing && e.target !== handle) return; // let the user place the caret / select text
        e.preventDefault();
        const s = scaleOf(pages[o.page]);
        const resizing = e.target === handle;
        const start = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y, w: o.w, h: o.h, size: o.size, tw: node.offsetWidth / s };
        const before = snapshot(o);
        let moved = false;
        node.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
          const dx = (ev.clientX - start.x) / s, dy = (ev.clientY - start.y) / s;
          if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
          if (resizing) {
            if (o.type === 'text') {
              o.size = Math.max(4, start.size * Math.max(0.1, (start.tw + dx) / start.tw));
              sizeInput.value = Math.round(o.size);
            } else if (o.type === 'image') {
              o.w = Math.max(8, start.w + dx);
              o.h = o.w * (start.h / start.w);
            } else {
              o.w = Math.max(4, start.w + dx);
              o.h = Math.max(4, start.h + dy);
            }
          } else {
            const info = pages[o.page];
            o.x = Math.min(Math.max(start.ox + dx, -(o.w || 0) / 2), info.vw - 5);
            o.y = Math.min(Math.max(start.oy + dy, -(o.h || 0) / 2), info.vh - 5);
          }
          render(o);
        };
        const onUp = () => {
          node.removeEventListener('pointermove', onMove);
          node.removeEventListener('pointerup', onUp);
          node.removeEventListener('pointercancel', onUp);
          if (moved) recordChange(o, before);
          if (!moved && !resizing && o.type === 'text') focusText(o);
        };
        node.addEventListener('pointermove', onMove);
        node.addEventListener('pointerup', onUp);
        node.addEventListener('pointercancel', onUp);
      });
    }

    function focusText(o) {
      o.input.focus();
      const range = document.createRange();
      range.selectNodeContents(o.input);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function bindLayer(info) {
      const { layer } = info;
      const toPts = (e) => {
        const r = layer.getBoundingClientRect();
        const s = scaleOf(info);
        return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
      };
      layer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const tool = state.tool;
        if (tool === 'select' || tool === 'edittext') return selectObj(null);
        e.preventDefault();
        const [x, y] = toPts(e);
        const style = currentStyle();

        if (tool === 'text') {
          const o = addObj({ type: 'text', page: info.index, x, y: y - state.props.size * 0.6, text: '', font: state.props.font, size: state.props.size, color: style.color, opacity: style.opacity });
          setTool('select');
          selectObj(o);
          setTimeout(() => focusText(o));
          return;
        }

        layer.setPointerCapture(e.pointerId);
        const s = scaleOf(info);
        let preview, points;
        if (tool === 'draw') {
          points = [[x, y]];
          preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          preview.setAttribute('class', 'ed-draw-preview');
          preview.innerHTML = `<polyline fill="none" stroke="${style.color}" stroke-width="${style.stroke * s}" stroke-linecap="round" stroke-linejoin="round" opacity="${style.opacity}"/>`;
          layer.append(preview);
        } else {
          preview = el('div', { class: `ed-rubber ed-${tool}` });
          layer.append(preview);
        }
        const onMove = (ev) => {
          const [mx, my] = toPts(ev);
          if (tool === 'draw') {
            points.push([mx, my]);
            preview.firstChild.setAttribute('points', points.map((p) => `${p[0] * s},${p[1] * s}`).join(' '));
          } else {
            Object.assign(preview.style, {
              left: `${Math.min(x, mx) * s}px`, top: `${Math.min(y, my) * s}px`,
              width: `${Math.abs(mx - x) * s}px`, height: `${Math.abs(my - y) * s}px`,
            });
          }
        };
        const onUp = (ev) => {
          layer.removeEventListener('pointermove', onMove);
          layer.removeEventListener('pointerup', onUp);
          layer.removeEventListener('pointercancel', onUp);
          preview.remove();
          const [mx, my] = toPts(ev);
          if (tool === 'draw') {
            if (points.length < 2) points.push([x + 0.1, y + 0.1]);
            addInk(info, points, style);
            return;
          }
          let rx = Math.min(x, mx), ry = Math.min(y, my), w = Math.abs(mx - x), h = Math.abs(my - y);
          if (w < 4 && h < 4) [w, h, rx, ry] = tool === 'highlight' ? [120, 18, x, y - 9] : [140, 40, x, y - 20];
          addObj({
            type: 'rect', variant: tool, page: info.index, x: rx, y: ry, w, h,
            color: style.color, opacity: style.opacity, stroke: style.stroke,
          });
          setTool('select');
        };
        layer.addEventListener('pointermove', onMove);
        layer.addEventListener('pointerup', onUp);
        layer.addEventListener('pointercancel', onUp);
      });
    }

    function addInk(info, points, style) {
      const pad = style.stroke / 2;
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
      const w = Math.max(1, Math.max(...xs) + pad - minX), h = Math.max(1, Math.max(...ys) + pad - minY);
      addObj(
        { type: 'ink', page: info.index, x: minX, y: minY, w, h, w0: w, h0: h, points: points.map(([px, py]) => [px - minX, py - minY]), color: style.color, opacity: style.opacity, stroke: style.stroke },
        { select: false },
      );
    }

    function placeImage(src, maxW = 200) {
      const info = visiblePage();
      const w = Math.min(maxW, info.vw * 0.6);
      const h = w * (src.height / src.width);
      addObj({ type: 'image', page: info.index, x: (info.vw - w) / 2, y: (info.vh - h) / 2, w, h, src, opacity: 1 });
      setTool('select');
    }

    async function addImage() {
      const [f] = await pickFiles('image/*', false);
      if (!f) return;
      try {
        placeImage(await imageFromFile(f), 240);
      } catch {
        toast('Could not read that image.', 'error');
      }
    }

    async function addSignature() {
      const sig = await openSignaturePad();
      if (!sig) return;
      try {
        placeImage(await imageFromFile(sig), 180);
        toast('Signature added — drag it into place.', 'success');
      } catch {
        toast('Could not read that image.', 'error');
      }
    }

    const onKey = (e) => {
      const o = state.selected;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (typing || document.querySelector('.modal-backdrop')) {
        if (e.key === 'Escape' && typing) document.activeElement.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return undo();
      }
      if (!o) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteObj(o);
      } else if (e.key === 'Escape') selectObj(null);
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const before = snapshot(o);
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') o.x -= step;
        if (e.key === 'ArrowRight') o.x += step;
        if (e.key === 'ArrowUp') o.y -= step;
        if (e.key === 'ArrowDown') o.y += step;
        render(o);
        recordChange(o, before);
      }
    };
    document.addEventListener('keydown', onKey);

    // ---------- save ----------
    /** Replace the given pages with 200 dpi images of themselves, so covered content is truly gone. */
    async function flattenPages(pdfBytes, indices, progress) {
      const rendered = await openForRender(pdfBytes);
      try {
        const doc = await openForEdit(pdfBytes);
        for (const i of [...indices].sort((a, b) => a - b)) {
          progress(`Removing covered text on page ${i + 1}…`);
          const page = await rendered.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 });
          const scale = Math.min(200 / 72, 5000 / Math.max(vp.width, vp.height));
          const { canvas } = await renderPage(rendered, i + 1, scale);
          const img = await doc.embedJpg(await blobToBytes(await canvasToBlob(canvas, 'image/jpeg', 0.92)));
          canvas.width = canvas.height = 0;
          const flat = doc.insertPage(i, [vp.width, vp.height]);
          flat.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
          doc.removePage(i + 1);
        }
        return await saveDoc(doc);
      } finally {
        rendered.loadingTask.destroy();
      }
    }

    async function save() {
      document.activeElement?.blur?.();
      commitPending();
      if (!objects.size) return toast('Add something to the document first.', 'error');
      await withBusy('Saving PDF…', async (progress) => {
        const doc = await openForEdit(bytes);
        const docPages = doc.getPages();
        const embedded = new Map();
        const embed = async (src) => {
          if (!embedded.has(src)) embedded.set(src, embedImageData(doc, src, src.img));
          return embedded.get(src);
        };
        // draw in creation order so later items stack on top
        const list = [...objects].sort((a, b) => a.id - b.id);
        const covered = new Set(); // pages whose original content was hidden, flattened if requested
        let drawn = 0;
        for (const o of list) {
          const page = docPages[o.page];
          const info = pages[o.page];
          const frame = pageFrame(page);
          const k = frame.width / info.vw; // pdf.js vs pdf-lib box mismatch guard (normally 1)
          const VH = frame.height;
          const x = o.x * k, y = o.y * k;
          if (!(o.orig && JSON.stringify(snapshot(o)) === o.pristine)) drawn++;
          if (o.type === 'text') {
            if (o.orig) {
              if (JSON.stringify(snapshot(o)) === o.pristine) continue; // opened for editing but left as it was
              const b = o.orig;
              covered.add(o.page);
              drawRectVisual(page, { vx: b.x * k, vy: VH - (b.y + b.h) * k, width: b.w * k, height: b.h * k, color: b.bg });
            }
            const size = o.size * k;
            const lines = (o.text || '').split('\n');
            const base = baselineEm(o.font, o.size * scaleOf(info)); // as previewed at the current zoom
            for (const [i, line] of lines.entries()) {
              const baseline = y + size * (base + LINE_HEIGHT * i);
              await drawTextVisual(doc, page, line, { vx: x, vy: VH - baseline, size, fontKey: o.font, color: o.color, opacity: o.opacity });
            }
          } else if (o.type === 'image') {
            drawImageVisual(page, await embed(o.src), { vx: x, vy: VH - y - o.h * k, width: o.w * k, height: o.h * k, opacity: o.opacity });
          } else if (o.type === 'rect') {
            const isRect = o.variant === 'rect';
            if (o.variant === 'whiteout') covered.add(o.page);
            // PDF strokes are centred on the path; on screen the border sits inside the box, so inset by half
            const bw = isRect ? Math.min(o.stroke * k, (Math.min(o.w, o.h) * k) / 2) : 0;
            drawRectVisual(page, {
              vx: x + bw / 2, vy: VH - y - o.h * k + bw / 2, width: o.w * k - bw, height: o.h * k - bw,
              color: isRect ? undefined : o.color,
              borderColor: isRect ? o.color : undefined,
              borderWidth: bw,
              opacity: o.opacity,
              blendMode: o.variant === 'highlight' ? BlendMode.Multiply : undefined,
            });
          } else if (o.type === 'ink') {
            const sx = (o.w / o.w0) * k, sy = (o.h / o.h0) * k;
            const d = o.points.map((p, i) => `${i ? 'L' : 'M'}${(x + p[0] * sx).toFixed(2)} ${(y + p[1] * sy).toFixed(2)}`).join(' ');
            const origin = frame.toPdf(0, VH); // visual top-left; SVG y runs downward from here
            page.drawSvgPath(d, {
              x: origin.x, y: origin.y, rotate: degrees(frame.rot),
              borderColor: hexToRgb(o.color), borderWidth: o.stroke * k, borderOpacity: o.opacity, borderLineCap: LineCapStyle.Round,
            });
          }
        }
        if (!drawn) return toast('Nothing has changed yet — edit the text or add something first.', 'error');
        let out = await saveDoc(doc);
        if (redactBox.checked && covered.size) out = await flattenPages(out, covered, progress);
        download(out, `${baseName(file.name)}_edited.pdf`);
        toast('Your edited PDF is downloading.', 'success');
      });
    }

    layoutPages();
    setTool('select');
    // cancelled on cleanup so leaving right after loading can't open the dialog on the next page
    const signTimer = signMode && setTimeout(addSignature, 200);

    return () => {
      clearTimeout(signTimer);
      document.removeEventListener('keydown', onKey);
      renderObserver.disconnect();
    };
  });
}

export const editor = {
  id: 'edit',
  title: 'Edit PDF',
  desc: 'Edit existing text, or add text, images, shapes, highlights, freehand drawings and whiteout to any PDF.',
  color: '#e5322d',
  icon: 'edit',
  mount(container) {
    return mountEditor(container, this);
  },
};

export const sign = {
  id: 'sign',
  title: 'Sign PDF',
  desc: 'Draw, type or upload your signature and place it anywhere on the document.',
  color: '#3f51b5',
  icon: 'sign',
  mount(container) {
    return mountEditor(container, this, { signMode: true });
  },
};
