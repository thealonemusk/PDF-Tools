// Preparing user images for embedding in a PDF.
import { canvasToBlob, blobToBytes } from './pdf.js';

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Walk a JPEG's marker segments up to the start of scan, calling visit(marker, offset, length). */
function jpegSegments(bytes, visit) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return; // start of scan: no more metadata
    const len = v.getUint16(off + 2);
    if (visit(marker, off, len, v)) return;
    off += 2 + len;
  }
}

/** Read the EXIF orientation tag (1–8) of a JPEG; 1 when absent. */
export function jpegOrientation(bytes) {
  let orientation = 1;
  jpegSegments(bytes, (marker, off, len, v) => {
    if (marker !== 0xffe1 || off + 10 > v.byteLength || v.getUint32(off + 4) !== 0x45786966) return false;
    const tiff = off + 10;
    if (tiff + 8 > v.byteLength) return true;
    const le = v.getUint16(tiff) === 0x4949;
    const ifd = tiff + v.getUint32(tiff + 4, le);
    if (ifd + 2 > v.byteLength) return true;
    const count = v.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      if (v.getUint16(e, le) === 0x0112) {
        orientation = v.getUint16(e + 8, le) || 1;
        break;
      }
    }
    return true;
  });
  return orientation;
}

/** Number of colour components in a JPEG frame (3 = RGB/YCbCr, 4 = CMYK/YCCK, 1 = grey). */
function jpegComponents(bytes) {
  let n = 0;
  jpegSegments(bytes, (marker, off, len, v) => {
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      if (off + 10 <= v.byteLength) n = v.getUint8(off + 9);
      return true;
    }
    return false;
  });
  return n;
}

/** Re-encode a decoded image (EXIF orientation already applied by the browser): JPEG unless it has transparency. */
async function reencode(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = true;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { opaque = false; break; }
  const mime = opaque ? 'image/jpeg' : 'image/png';
  const bytes = await blobToBytes(await canvasToBlob(c, mime, opaque ? 0.92 : undefined));
  c.width = c.height = 0;
  return { bytes, mime };
}

/**
 * Bytes to embed for an image file, given its decoded <img>. JPEG and PNG are kept as-is when a PDF
 * shows them the way the browser does; otherwise the image is re-encoded from the decoded pixels:
 * - rotated/mirrored camera photos (a PDF ignores the EXIF orientation tag, so they came out sideways
 *   and stretched to the upright size),
 * - CMYK JPEGs (pdf-lib embeds them without the Decode array Adobe files need: colours come out inverted),
 * - other formats (WebP, GIF, BMP…).
 * The file type is detected from its bytes, not its name.
 */
export async function pdfImageData(file, img) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isJpeg(bytes) && jpegOrientation(bytes) === 1 && jpegComponents(bytes) !== 4) return { bytes, mime: 'image/jpeg' };
  if (isPng(bytes)) return { bytes, mime: 'image/png' };
  return reencode(img);
}

/** Embed image data from pdfImageData(), falling back to re-encoding if pdf-lib can't parse the original. */
export async function embedImageData(doc, data, img) {
  try {
    return await (data.mime === 'image/png' ? doc.embedPng(data.bytes) : doc.embedJpg(data.bytes));
  } catch (err) {
    if (!img) throw err;
    const fixed = await reencode(img);
    return fixed.mime === 'image/png' ? doc.embedPng(fixed.bytes) : doc.embedJpg(fixed.bytes);
  }
}
