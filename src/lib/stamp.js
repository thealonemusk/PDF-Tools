// Drawing helpers that work in "visual" page coordinates (what the reader sees,
// after the page's /Rotate is applied) and handle non-Latin text.
import { StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';
import { canvasToBlob, blobToBytes } from './pdf.js';

// CSS stacks for previews and canvas text. Arial, Times New Roman and Courier New (and their Liberation
// clones on Linux) share the widths of the PDF standard fonts, so on-screen text lines up with the
// saved PDF. Where none is installed (e.g. Android), the metric-compatible web fonts Arimo, Tinos and
// Cousine are loaded instead (see loadFonts) rather than letting the browser pick an unrelated font.
const GROUPS = {
  sans: { css: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif', local: ['Helvetica', 'Arial', 'Liberation Sans'], web: 'Arimo', baseline: 0.947 },
  serif: { css: '"Times New Roman", Times, "Liberation Serif", Tinos, serif', local: ['Times New Roman', 'Times', 'Liberation Serif'], web: 'Tinos', baseline: 0.938 },
  mono: { css: '"Courier New", Courier, "Liberation Mono", Cousine, monospace', local: ['Courier New', 'Courier', 'Liberation Mono'], web: 'Cousine', baseline: 0.867 },
};

const font = (label, std, group, weight, style) => ({ label, std, group, css: GROUPS[group].css, baseline: GROUPS[group].baseline, weight, style });
export const FONTS = {
  helvetica: font('Helvetica', StandardFonts.Helvetica, 'sans'),
  'helvetica-bold': font('Helvetica Bold', StandardFonts.HelveticaBold, 'sans', 'bold'),
  'helvetica-oblique': font('Helvetica Oblique', StandardFonts.HelveticaOblique, 'sans', undefined, 'italic'),
  'helvetica-bold-oblique': font('Helvetica Bold Oblique', StandardFonts.HelveticaBoldOblique, 'sans', 'bold', 'italic'),
  times: font('Times', StandardFonts.TimesRoman, 'serif'),
  'times-bold': font('Times Bold', StandardFonts.TimesRomanBold, 'serif', 'bold'),
  'times-italic': font('Times Italic', StandardFonts.TimesRomanItalic, 'serif', undefined, 'italic'),
  'times-bold-italic': font('Times Bold Italic', StandardFonts.TimesRomanBoldItalic, 'serif', 'bold', 'italic'),
  courier: font('Courier', StandardFonts.Courier, 'mono'),
  'courier-bold': font('Courier Bold', StandardFonts.CourierBold, 'mono', 'bold'),
  'courier-oblique': font('Courier Oblique', StandardFonts.CourierOblique, 'mono', undefined, 'italic'),
  'courier-bold-oblique': font('Courier Bold Oblique', StandardFonts.CourierBoldOblique, 'mono', 'bold', 'italic'),
};

export const fontOf = (key) => FONTS[key] || FONTS.helvetica;

/** CSS `font` shorthand for a font key at `px` pixels (canvas contexts). */
export function cssFont(key, px) {
  const f = fontOf(key);
  return `${f.style || 'normal'} ${f.weight || 'normal'} ${px}px ${f.css}`;
}

/** Inline style properties showing a font key in the DOM. */
export function fontStyles(key) {
  const f = fontOf(key);
  return { fontFamily: f.css, fontWeight: f.weight || 'normal', fontStyle: f.style || 'normal' };
}

let probeCtx;
const probe = () => (probeCtx ??= document.createElement('canvas').getContext('2d'));

/** Whether a font family is installed locally (its glyph widths differ from both generic fallbacks). */
function installed(family) {
  const ctx = probe();
  const sample = 'mmmmmmmmmmlllllllIIIii10OQW@';
  return ['monospace', 'serif'].some((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}

const groupHasLocal = {};
const webLoads = new Map();
/**
 * Make sure the fonts behind these keys are ready before measuring or drawing with them: loads the
 * metric-compatible web font for a group with no local equivalent. Never rejects.
 */
export async function loadFonts(keys = Object.keys(FONTS), text) {
  const jobs = [];
  for (const key of new Set(keys)) {
    const f = fontOf(key);
    const g = GROUPS[f.group];
    groupHasLocal[f.group] ??= g.local.some(installed);
    if (groupHasLocal[f.group] || !document.fonts) continue;
    const spec = `${f.style || 'normal'} ${f.weight || 'normal'} 16px "${g.web}"`;
    const id = `${spec}|${text ?? ''}`;
    if (!webLoads.has(id)) webLoads.set(id, document.fonts.load(spec, text || undefined).catch(() => []));
    jobs.push(webLoads.get(id));
  }
  await Promise.all(jobs);
}

/** Width of `text` in CSS pixels (= points at `sizePt`) as the browser draws it. */
export function measureCanvas(text, sizePt, fontKey) {
  const ctx = probe();
  ctx.font = cssFont(fontKey, sizePt);
  return ctx.measureText(text).width;
}

/**
 * Map characters the standard fonts lack but that have a plain equivalent (special spaces, dashes,
 * tabs), and drop invisible ones, so they don't force the text onto the image fallback.
 */
export function cleanText(text) {
  return String(text)
    .normalize('NFC')
    .replace(/\t/g, '    ')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f]/g, ' ')
    .replace(/[\u2010-\u2012\u2212]/g, '-')
    .replace(/[\r\u200b\u2060\ufeff]/g, '');
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Visual size & mapping for a pdf-lib page. Visual origin is bottom-left, y up. */
export function pageFrame(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = box.width, H = box.height, ox = box.x, oy = box.y;
  const swap = rot === 90 || rot === 270;
  return {
    rot,
    width: swap ? H : W,
    height: swap ? W : H,
    /** Convert a visual point to PDF user-space. */
    toPdf(vx, vy) {
      switch (rot) {
        case 90: return { x: ox + W - vy, y: oy + vx };
        case 180: return { x: ox + W - vx, y: oy + H - vy };
        case 270: return { x: ox + vy, y: oy + H - vx };
        default: return { x: ox + vx, y: oy + vy };
      }
    },
  };
}

const fontCache = new WeakMap();
export async function getFont(doc, key) {
  if (!FONTS[key]) key = 'helvetica';
  if (!fontCache.has(doc)) fontCache.set(doc, {});
  const c = fontCache.get(doc);
  c[key] ??= doc.embedFont(FONTS[key].std);
  return c[key];
}

const charSets = new WeakMap();
/**
 * Whether every character of `text` exists in the font's encoding. (@cantoo/pdf-lib's
 * encodeText silently substitutes "?" for unsupported characters instead of throwing,
 * so check against the font's character set explicitly.)
 */
function canEncode(font, text) {
  if (!charSets.has(font)) charSets.set(font, new Set(font.getCharacterSet()));
  const set = charSets.get(font);
  for (const ch of text) if (!set.has(ch.codePointAt(0))) return false;
  return true;
}

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (text) => (graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (s) => s.segment) : Array.from(text));

/**
 * Split a line into runs the standard font can encode ({ std: true }, drawn as real, selectable text)
 * and runs it can't ({ std: false }, drawn as an image), instead of turning the whole line into an
 * image because of one unsupported character. Whitespace between two image runs joins them so words
 * of the same script are shaped together; right-to-left lines stay one image to keep their visual order.
 */
function segments(font, text) {
  if (canEncode(font, text)) return [{ text, std: true }];
  if (RTL.test(text)) return [{ text, std: false }];
  const runs = [];
  for (const g of graphemes(text)) {
    const std = canEncode(font, g);
    const last = runs.at(-1);
    if (last?.std === std) last.text += g;
    else runs.push({ text: g, std });
  }
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i], prev = out.at(-1), next = runs[i + 1];
    if (r.std && !r.text.trim() && prev && next && !prev.std && !next.std) {
      prev.text += r.text + next.text;
      i++;
    } else out.push(r);
  }
  return out;
}

const textImageCache = new WeakMap();
/** Text images are embedded once per document and reused (e.g. by tiled watermarks on every page). */
function textImage(doc, text, sizePt, fontKey, colorHex) {
  if (!textImageCache.has(doc)) textImageCache.set(doc, new Map());
  const c = textImageCache.get(doc);
  const key = JSON.stringify([text, sizePt, fontKey, colorHex]);
  if (!c.has(key)) c.set(key, renderTextImage(doc, text, sizePt, fontKey, colorHex).catch((err) => { c.delete(key); throw err; }));
  return c.get(key);
}

/** Render text to a transparent PNG (used for scripts the standard PDF fonts can't encode, e.g. Hindi). */
async function renderTextImage(doc, text, sizePt, fontKey, colorHex) {
  await loadFonts([fontKey], text);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = cssFont(fontKey, sizePt);
  // 4x supersampling, reduced for very long text so the canvas stays within browser limits
  const scale = Math.max(0.5, Math.min(4, 16000 / (ctx.measureText(text).width + 4)));
  const font = cssFont(fontKey, sizePt * scale);
  ctx.font = font;
  const m = ctx.measureText(text);
  const em = sizePt * scale;
  // leave room for glyphs that reach above the em box or below the usual descent (e.g. Devanagari matras)
  const ascent = Math.ceil(Math.max(em, (m.actualBoundingBoxAscent || 0) + 2));
  const descent = Math.ceil(Math.max(em * 0.3, (m.actualBoundingBoxDescent || 0) + 2));
  // keeps antialiased edges and left overhangs (italics, leading combining marks) inside the image
  const pad = Math.ceil(Math.max(2, (m.actualBoundingBoxLeft || 0) + 2));
  const w = Math.ceil(Math.max(m.width, m.actualBoundingBoxRight || 0)) + 2 * pad;
  const h = ascent + descent;
  c.width = Math.max(1, w);
  c.height = h;
  ctx.font = font;
  ctx.fillStyle = colorHex;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, ascent);
  const img = await doc.embedPng(await blobToBytes(await canvasToBlob(c, 'image/png')));
  return { img, width: c.width / scale, height: c.height / scale, baselineFromBottom: descent / scale, originFromLeft: pad / scale, advance: m.width / scale };
}

/** Measure text width in points, exactly as drawTextVisual lays it out. */
export async function measureText(doc, text, sizePt, fontKey) {
  text = cleanText(text);
  const font = await getFont(doc, fontKey);
  const segs = segments(font, text);
  if (segs.some((s) => !s.std)) await loadFonts([fontKey], text);
  let width = 0;
  for (const s of segs) width += s.std ? font.widthOfTextAtSize(s.text, sizePt) : measureCanvas(s.text, sizePt, fontKey);
  return width;
}

/**
 * Draw a single line of text with its baseline-left at visual point (vx, vy),
 * rotated `angle` degrees counter-clockwise in the visual frame.
 */
export async function drawTextVisual(doc, page, text, { vx, vy, size, fontKey = 'helvetica', color = '#000000', opacity = 1, angle = 0 }) {
  text = cleanText(text || '');
  if (!text.trim()) return;
  const frame = pageFrame(page);
  const font = await getFont(doc, fontKey);
  const rotate = degrees(angle + frame.rot);
  const a = (angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  let pen = 0; // distance advanced along the baseline
  for (const seg of segments(font, text)) {
    const ox = vx + cos * pen, oy = vy + sin * pen;
    if (seg.std) {
      const p = frame.toPdf(ox, oy);
      page.drawText(seg.text, { x: p.x, y: p.y, size, font, color: hexToRgb(color), opacity, rotate });
      pen += font.widthOfTextAtSize(seg.text, size);
      continue;
    }
    const t = await textImage(doc, seg.text, size, fontKey, color);
    // move from the text origin to the image's bottom-left: back past the left padding along the
    // rotated "right" direction (cos, sin), then down past the descent along "down" (sin, -cos)
    const bx = ox - cos * t.originFromLeft + sin * t.baselineFromBottom;
    const by = oy - sin * t.originFromLeft - cos * t.baselineFromBottom;
    const p = frame.toPdf(bx, by);
    page.drawImage(t.img, { x: p.x, y: p.y, width: t.width, height: t.height, opacity, rotate });
    pen += t.advance;
  }
}

/** Draw an embedded image whose bottom-left corner is at visual point (vx, vy). */
export function drawImageVisual(page, img, { vx, vy, width, height, opacity = 1, angle = 0 }) {
  const frame = pageFrame(page);
  const p = frame.toPdf(vx, vy);
  page.drawImage(img, { x: p.x, y: p.y, width, height, opacity, rotate: degrees(angle + frame.rot) });
}

export function drawRectVisual(page, { vx, vy, width, height, color, opacity = 1, borderColor, borderWidth = 0, blendMode }) {
  const frame = pageFrame(page);
  const p = frame.toPdf(vx, vy);
  page.drawRectangle({
    x: p.x,
    y: p.y,
    width,
    height,
    rotate: degrees(frame.rot),
    color: color ? hexToRgb(color) : undefined,
    opacity,
    borderColor: borderColor ? hexToRgb(borderColor) : undefined,
    borderWidth,
    borderOpacity: opacity,
    blendMode,
  });
}
