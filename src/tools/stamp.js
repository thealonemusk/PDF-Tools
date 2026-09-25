// Watermark and page-number tools.
import { el, withBusy, download, toast, field, select, segmented, parseRanges, baseName } from '../lib/ui.js';
import { openForEdit, saveDoc, renderThumb } from '../lib/pdf.js';
import { FONTS, cssFont, fontStyles, loadFonts, measureCanvas, pageFrame, drawTextVisual, measureText } from '../lib/stamp.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

const fontOptions = Object.entries(FONTS).map(([k, f]) => [k, f.label]);

function range(text, n) {
  return new Set(text.trim() ? parseRanges(text, n).flat() : Array.from({ length: n }, (_, i) => i));
}

/** Parse the page selection, showing a plain error toast (not a crash message) when it is invalid. */
function checkedRange(text, n) {
  try {
    return range(text, n);
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/** Numeric input value clamped to [min, max], or the default when empty/invalid. */
function numberValue(input, def, min, max) {
  const v = Number(input.value);
  return input.value.trim() === '' || !Number.isFinite(v) ? def : Math.min(max, Math.max(min, v));
}

/** Preview of the first page with a live CSS overlay approximating the result. */
async function previewBox(pdf) {
  const canvas = await renderThumb(pdf, 1, 420);
  const overlay = el('div', { class: 'stamp-overlay' });
  const box = el('div', { class: 'stamp-preview' }, canvas, overlay);
  canvas.style.width = '100%';
  const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
  return { box, overlay, pageWidth: vp.width, pageHeight: vp.height };
}

/**
 * Centres (visual pt, y up) of every watermark copy. Tiles form a staggered
 * lattice aligned with the text direction so copies never overlap.
 */
function watermarkCentres(mode, width, height, tw, sz, angle) {
  if (mode !== 'tile') return [[width / 2, height / 2]];
  const rad = (angle * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const stepU = tw + Math.max(sz * 1.5, 40), stepV = Math.max(sz * 3, 60);
  // half extents of one rotated copy, to keep copies that are partly on the page
  const hx = (Math.abs(c) * tw + Math.abs(s) * sz) / 2, hy = (Math.abs(s) * tw + Math.abs(c) * sz) / 2;
  const reach = Math.hypot(width, height) / 2 + tw;
  const nu = Math.ceil(reach / stepU) + 1, nv = Math.ceil(reach / stepV);
  const out = [];
  for (let j = -nv; j <= nv; j++)
    for (let i = -nu; i <= nu; i++) {
      const u = (i + (j % 2 ? 0.5 : 0)) * stepU, v = j * stepV;
      const x = width / 2 + u * c - v * s, y = height / 2 + u * s + v * c;
      if (x > -hx && x < width + hx && y > -hy && y < height + hy) out.push([x, y]);
    }
  return out;
}

/**
 * Height of the text's visual middle above its baseline, in points. Measured from the actual glyphs,
 * so scripts with tall marks or a headline (e.g. Devanagari) centre as well as Latin text.
 */
function inkMiddle(text, sizePt, fontKey) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = cssFont(fontKey, sizePt);
  const m = ctx.measureText(text);
  const mid = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  return Number.isFinite(mid) && mid > 0 ? mid : sizePt * 0.35;
}

export const watermark = {
  id: 'watermark',
  title: 'Add watermark',
  desc: 'Stamp text over your PDF pages — choose font, color, transparency and angle.',
  color: '#2980b9',
  icon: 'watermark',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      const text = el('input', { type: 'text', value: 'CONFIDENTIAL' });
      const font = select(fontOptions, 'helvetica-bold');
      const size = el('input', { type: 'range', min: 10, max: 150, value: 60 });
      const color = el('input', { type: 'color', value: '#e5322d' });
      const opacity = el('input', { type: 'range', min: 5, max: 100, value: 30 });
      const angle = el('input', { type: 'range', min: -90, max: 90, value: 45 });
      const pages = el('input', { type: 'text', placeholder: `All pages (1-${pdf.numPages})` });
      let mode = 'center';

      const prev = await previewBox(pdf);
      function update() {
        const k = prev.box.clientWidth / prev.pageWidth || 0.5;
        const sz = Number(size.value), a = Number(angle.value);
        const tw = measureCanvas(text.value, sz, font.value);
        const centres = text.value ? watermarkCentres(mode, prev.pageWidth, prev.pageHeight, tw, sz, a) : [];
        prev.overlay.className = 'stamp-overlay';
        prev.overlay.replaceChildren(...centres.map(([cx, cy]) =>
          el('span', {
            class: 'stamp-mark',
            style: {
              left: `${cx * k}px`, top: `${(prev.pageHeight - cy) * k}px`,
              ...fontStyles(font.value), fontSize: `${sz * k}px`,
              color: color.value, opacity: opacity.value / 100, transform: `translate(-50%, -50%) rotate(${-a}deg)`,
            },
          }, text.value)));
      }
      [text, font, size, color, opacity, angle].forEach((c) => c.addEventListener('input', update));
      // redraw once a fallback font the preview measures with has loaded
      [text, font].forEach((c) => c.addEventListener('input', () => loadFonts([font.value], text.value).then(update)));
      new ResizeObserver(update).observe(prev.box);

      layout.work.append(prev.box);
      layout.side.append(
        panel('Text', field('Watermark text', text), field('Font', font),
          el('div', { class: 'row' }, field('Color', color), field('Size', size))),
        panel('Appearance',
          segmented([['center', 'Single'], ['tile', 'Tiled']], mode, (v) => { mode = v; update(); }),
          field('Transparency', opacity), field('Angle', angle)),
        panel('Pages', field('Apply to pages', pages)),
        actionButton('Add watermark', () => {
          if (!text.value.trim()) return toast('Enter the watermark text.', 'error');
          const targets = checkedRange(pages.value, pdf.numPages);
          if (!targets) return;
          return withBusy('Adding watermark…', async () => {
            const doc = await openForEdit(bytes);
            await loadFonts([font.value], text.value);
            const sz = Number(size.value), a = Number(angle.value), rad = (a * Math.PI) / 180;
            const tw = await measureText(doc, text.value, sz, font.value);
            const opts = { size: sz, fontKey: font.value, color: color.value, opacity: opacity.value / 100, angle: a };
            // offset from text centre to its baseline-left origin, rotated
            const mid = inkMiddle(text.value, sz, font.value);
            const ox = -(Math.cos(rad) * tw / 2 - Math.sin(rad) * mid);
            const oy = -(Math.sin(rad) * tw / 2 + Math.cos(rad) * mid);
            for (const [i, page] of doc.getPages().entries()) {
              if (!targets.has(i)) continue;
              const { width, height } = pageFrame(page);
              for (const [cx, cy] of watermarkCentres(mode, width, height, tw, sz, a)) await drawTextVisual(doc, page, text.value, { ...opts, vx: cx + ox, vy: cy + oy });
            }
            download(await saveDoc(doc), `${baseName(file.name)}_watermarked.pdf`);
            toast('Watermark added.', 'success');
          });
        }),
      );
      update();
      loadFonts([font.value], text.value).then(update);
    });
  },
};

const firstNumber = (input) => (input.value.trim() === '' ? 1 : Math.max(0, Math.floor(Number(input.value)) || 0));

const POSITIONS = [
  ['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'],
  ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right'],
];

export const pageNumbers = {
  id: 'numbers',
  title: 'Add page numbers',
  desc: 'Number your pages with the position, format and style you want.',
  color: '#2c3e50',
  icon: 'numbers',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      let pos = 'bc';
      const posGrid = el('div', { class: 'pos-grid' });
      POSITIONS.forEach(([v, label]) => {
        const b = el('button', { type: 'button', title: label, class: v === pos ? 'active' : '' }, el('span'));
        b.addEventListener('click', () => {
          pos = v;
          [...posGrid.children].forEach((x) => x.classList.toggle('active', x === b));
          update();
        });
        posGrid.append(b);
      });
      const format = select([['{n}', '1'], ['Page {n}', 'Page 1'], ['{n} / {total}', '1 / 10'], ['Page {n} of {total}', 'Page 1 of 10'], ['- {n} -', '- 1 -']], '{n}');
      const start = el('input', { type: 'number', value: 1, min: 0 });
      const size = el('input', { type: 'number', value: 11, min: 5, max: 72 });
      const margin = el('input', { type: 'number', value: 28, min: 0, max: 200 });
      const font = select(fontOptions, 'helvetica');
      const color = el('input', { type: 'color', value: '#000000' });
      const pages = el('input', { type: 'text', placeholder: `All pages (1-${pdf.numPages})` });

      const prev = await previewBox(pdf);
      function update() {
        const k = prev.box.clientWidth / prev.pageWidth || 0.5;
        const m = `${numberValue(margin, 28, 0, 200) * k}px`;
        let count = pdf.numPages;
        try { count = range(pages.value, pdf.numPages).size; } catch { /* invalid range: reported on submit */ }
        const first = firstNumber(start);
        const label = format.value.replace('{n}', first).replace('{total}', first + count - 1);
        prev.overlay.className = 'stamp-overlay';
        const s = el('span', { class: 'num-preview', style: {
          ...fontStyles(font.value), fontSize: `${numberValue(size, 11, 5, 72) * k}px`, color: color.value,
          top: pos[0] === 't' ? m : 'auto', bottom: pos[0] === 'b' ? m : 'auto',
          left: pos[1] === 'l' ? m : pos[1] === 'c' ? '50%' : 'auto', right: pos[1] === 'r' ? m : 'auto',
          transform: pos[1] === 'c' ? 'translateX(-50%)' : 'none',
        } }, label);
        prev.overlay.replaceChildren(s);
      }
      [format, start, size, margin, font, color, pages].forEach((c) => c.addEventListener('input', update));
      font.addEventListener('input', () => loadFonts([font.value]).then(update));
      new ResizeObserver(update).observe(prev.box);

      layout.work.append(prev.box);
      layout.side.append(
        panel('Position', posGrid, field('Margin (pt)', margin)),
        panel('Format', field('Text', format), el('div', { class: 'row' }, field('First number', start), field('Font size', size)),
          el('div', { class: 'row' }, field('Font', font), field('Color', color))),
        panel('Pages', field('Number these pages', pages, 'Numbering counts only the selected pages.')),
        actionButton('Add page numbers', () => {
          const targets = checkedRange(pages.value, pdf.numPages);
          if (!targets) return;
          return withBusy('Numbering pages…', async () => {
            const doc = await openForEdit(bytes);
            const sz = numberValue(size, 11, 5, 72), mg = numberValue(margin, 28, 0, 200);
            let n = firstNumber(start);
            const total = n + targets.size - 1;
            for (const [i, page] of doc.getPages().entries()) {
              if (!targets.has(i)) continue;
              const label = format.value.replace('{n}', n).replace('{total}', total);
              n++;
              const { width, height } = pageFrame(page);
              const tw = await measureText(doc, label, sz, font.value);
              const vx = pos[1] === 'l' ? mg : pos[1] === 'c' ? (width - tw) / 2 : width - mg - tw;
              const vy = pos[0] === 't' ? height - mg - sz * 0.75 : mg;
              await drawTextVisual(doc, page, label, { vx, vy, size: sz, fontKey: font.value, color: color.value });
            }
            download(await saveDoc(doc), `${baseName(file.name)}_numbered.pdf`);
            toast('Page numbers added.', 'success');
          });
        }),
      );
      update();
      loadFonts([font.value]).then(update);
    });
  },
};
