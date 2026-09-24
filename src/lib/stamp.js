// Drawing helpers that work in "visual" page coordinates (what the reader sees,
// after the page's /Rotate is applied) and handle non-Latin text.
import { StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';
import { canvasToBlob, blobToBytes } from './pdf.js';

export const FONTS = {
  helvetica: { label: 'Helvetica', std: StandardFonts.Helvetica, css: 'Helvetica, Arial, sans-serif' },
  'helvetica-bold': { label: 'Helvetica Bold', std: StandardFonts.HelveticaBold, css: 'Helvetica, Arial, sans-serif', weight: 'bold' },
  times: { label: 'Times', std: StandardFonts.TimesRoman, css: '"Times New Roman", Times, serif' },
  'times-bold': { label: 'Times Bold', std: StandardFonts.TimesRomanBold, css: '"Times New Roman", Times, serif', weight: 'bold' },
  courier: { label: 'Courier', std: StandardFonts.Courier, css: '"Courier New", Courier, monospace' },
};

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
  const f = FONTS[fontKey] || FONTS.helvetica;
  const family = f.css;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${f.weight || 'normal'} ${sizePt}px ${family}`;
  // 4x supersampling, reduced for very long text so the canvas stays within browser limits
  const scale = Math.max(0.5, Math.min(4, 16000 / (ctx.measureText(text).width + 4)));
  const font = `${f.weight || 'normal'} ${sizePt * scale}px ${family}`;
  ctx.font = font;
  const m = ctx.measureText(text);
  const em = sizePt * scale;
  // leave room for glyphs that reach above the em box or below the usual descent (e.g. Devanagari matras)
  const ascent = Math.ceil(Math.max(em, (m.actualBoundingBoxAscent || 0) + 2));
  const descent = Math.ceil(Math.max(em * 0.3, (m.actualBoundingBoxDescent || 0) + 2));
  const pad = 2; // keeps antialiased edges and slight left overhangs inside the image
  const w = Math.ceil(Math.max(m.width, m.actualBoundingBoxRight || 0)) + 2 * pad;
  const h = ascent + descent;
  c.width = Math.max(1, w);
  c.height = h;
  ctx.font = font;
  ctx.fillStyle = colorHex;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, ascent);
  const img = await doc.embedPng(await blobToBytes(await canvasToBlob(c, 'image/png')));
  return { img, width: c.width / scale, height: c.height / scale, baselineFromBottom: descent / scale, originFromLeft: pad / scale };
}

/** Measure text width in points (falls back to canvas measurement for unsupported glyphs). */
export async function measureText(doc, text, sizePt, fontKey) {
  const font = await getFont(doc, fontKey);
  if (canEncode(font, text)) return font.widthOfTextAtSize(text, sizePt);
  const ctx = document.createElement('canvas').getContext('2d');
  const f = FONTS[fontKey] || FONTS.helvetica;
  ctx.font = `${f.weight || 'normal'} ${sizePt}px ${f.css}`;
  return ctx.measureText(text).width;
}

/**
 * Draw a single line of text with its baseline-left at visual point (vx, vy),
 * rotated `angle` degrees counter-clockwise in the visual frame.
 */
export async function drawTextVisual(doc, page, text, { vx, vy, size, fontKey = 'helvetica', color = '#000000', opacity = 1, angle = 0 }) {
  if (!text) return;
  const frame = pageFrame(page);
  const font = await getFont(doc, fontKey);
  const rotate = degrees(angle + frame.rot);
  if (canEncode(font, text)) {
    const p = frame.toPdf(vx, vy);
    page.drawText(text, { x: p.x, y: p.y, size, font, color: hexToRgb(color), opacity, rotate });
    return;
  }
  const t = await textImage(doc, text, size, fontKey, color);
  // move from the text origin to the image's bottom-left: back past the left padding along the
  // rotated "right" direction (cos, sin), then down past the descent along "down" (sin, -cos)
  const a = (angle * Math.PI) / 180;
  const bx = vx - Math.cos(a) * t.originFromLeft + Math.sin(a) * t.baselineFromBottom;
  const by = vy - Math.sin(a) * t.originFromLeft - Math.cos(a) * t.baselineFromBottom;
  const p = frame.toPdf(bx, by);
  page.drawImage(t.img, { x: p.x, y: p.y, width: t.width, height: t.height, opacity, rotate });
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
