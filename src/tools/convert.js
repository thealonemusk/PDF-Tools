// Image <-> PDF conversions.
import JSZip from 'jszip';
import { PDFDocument } from '@cantoo/pdf-lib';
import { el, dropzone, toolLayout, withBusy, download, pickFiles, toast, field, select, segmented, baseName, parseRanges } from '../lib/ui.js';
import { saveDoc, renderPage, canvasToBlob, blobToBytes } from '../lib/pdf.js';
import { cardGrid, iconButton } from '../lib/grid.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };
const IMAGE_ACCEPT = 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp';

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Read the EXIF orientation tag (1–8) of a JPEG; 1 when absent. */
function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // start of scan: no more metadata
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      if (tiff + 8 > v.byteLength) return 1;
      const le = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, le);
      if (ifd + 2 > v.byteLength) return 1;
      const count = v.getUint16(ifd, le);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > v.byteLength) return 1;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le) || 1;
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

/** Re-encode a decoded image (EXIF orientation already applied by the browser); JPEG unless it has transparency. */
async function reencode(doc, img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = true;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { opaque = false; break; }
  if (opaque) return doc.embedJpg(await blobToBytes(await canvasToBlob(c, 'image/jpeg', 0.92)));
  return doc.embedPng(await blobToBytes(await canvasToBlob(c, 'image/png')));
}

/** Embed any browser-decodable image; JPEG/PNG are embedded as-is when possible, others are re-encoded. */
async function embedImage(doc, file, img) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    // rotated/mirrored camera photos must be re-encoded upright, the PDF would ignore the EXIF tag
    if ((file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) && jpegOrientation(bytes) === 1) return await doc.embedJpg(bytes);
    if (file.type === 'image/png' || /\.png$/i.test(file.name)) return await doc.embedPng(bytes);
  } catch {
    // unusual encoding or wrong extension: fall back to the browser's decoder
  }
  return reencode(doc, img);
}

export const imagesToPdf = {
  id: 'img2pdf',
  title: 'JPG to PDF',
  desc: 'Convert JPG, PNG, WebP and other images to a PDF in seconds.',
  color: '#f1c40f',
  icon: 'img2pdf',
  mount(container) {
    const layout = toolLayout(container, this);
    let grid;
    let size = 'a4';
    let orientation = 'portrait';
    const marginSel = select([['0', 'No margin'], ['20', 'Small'], ['40', 'Large']], '0');

    async function addFiles(files) {
      await withBusy('Loading images…', async () => {
        const items = [];
        for (const file of files) {
          try {
            const img = await loadImage(file);
            items.push({ file, img, url: img.src, id: crypto.randomUUID() });
          } catch {
            toast(`Could not read image "${file.name}"`, 'error');
          }
        }
        if (!items.length) return;
        if (grid) return grid.set([...grid.items, ...items]);
        layout.open();
        grid = cardGrid({
          items,
          renderCard(it, i, api) {
            return el('div', { class: 'card' },
              el('div', { class: 'thumb-frame' }, el('img', { src: previewUrl(it), alt: '', draggable: false })),
              el('div', { class: 'card-label', title: it.file.name }, it.file.name),
              el('div', { class: 'card-actions' },
                iconButton('left', 'Move left', () => api.move(i, i - 1)),
                iconButton('del', 'Remove', () => api.remove(i)),
                iconButton('right', 'Move right', () => api.move(i, i + 1)),
              ),
            );
          },
        });
        layout.work.append(
          el('div', { class: 'file-bar' },
            el('span', { class: 'file-name' }, 'Drag to reorder images'),
            el('button', { class: 'btn btn-ghost btn-sm', onClick: async () => addFiles(await pickFiles(IMAGE_ACCEPT)) }, '+ Add more images'),
          ),
          grid.root,
        );
        // "Fit image" sizes each page to its image, so orientation doesn't apply there.
        const orientationPanel = panel('Orientation',
          segmented([['portrait', 'Portrait'], ['landscape', 'Landscape'], ['auto', 'Auto']], orientation, (v) => (orientation = v)),
        );
        orientationPanel.hidden = size === 'fit';
        layout.side.append(
          panel('Page size',
            segmented([['a4', 'A4'], ['letter', 'Letter'], ['fit', 'Fit image']], size, (v) => {
              size = v;
              orientationPanel.hidden = v === 'fit';
            }),
          ),
          orientationPanel,
          panel('Margin', marginSel),
          actionButton('Convert to PDF', convert),
        );
      });
    }

    const previews = new Map();
    function previewUrl(it) {
      if (!previews.has(it.id)) previews.set(it.id, URL.createObjectURL(it.file));
      return previews.get(it.id);
    }

    async function convert() {
      if (!grid.items.length) return toast('Add at least one image.', 'error');
      await withBusy('Creating PDF…', async (progress) => {
        const doc = await PDFDocument.create();
        const margin = Number(marginSel.value);
        for (const [i, it] of grid.items.entries()) {
          progress(`Adding image ${i + 1} of ${grid.items.length}…`);
          const image = await embedImage(doc, it.file, it.img);
          const iw = image.width, ih = image.height;
          let pw, ph;
          if (size === 'fit') {
            // 1 px = 0.75 pt (96 dpi)
            pw = iw * 0.75 + margin * 2;
            ph = ih * 0.75 + margin * 2;
          } else {
            [pw, ph] = PAGE_SIZES[size];
            const landscape = orientation === 'landscape' || (orientation === 'auto' && iw > ih);
            if (landscape) [pw, ph] = [ph, pw];
          }
          const boxW = pw - margin * 2, boxH = ph - margin * 2;
          const s = Math.min(boxW / iw, boxH / ih);
          const w = iw * s, h = ih * s;
          const page = doc.addPage([pw, ph]);
          page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
        download(await saveDoc(doc), grid.items.length === 1 ? `${baseName(grid.items[0].file.name)}.pdf` : 'images.pdf');
        toast('PDF created.', 'success');
      });
    }

    layout.intro.append(dropzone({ accept: IMAGE_ACCEPT, multiple: true, label: 'Select images', onFiles: addFiles }));
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  },
};

/** Lower the render scale for huge pages so the canvas stays within browser limits. */
async function safeScale(pdf, pageNumber, scale) {
  const vp = (await pdf.getPage(pageNumber)).getViewport({ scale });
  const k = Math.min(1, 14000 / Math.max(vp.width, vp.height), Math.sqrt(50e6 / (vp.width * vp.height)));
  return scale * k;
}

export const pdfToImages = {
  id: 'pdf2img',
  title: 'PDF to JPG',
  desc: 'Convert each PDF page into a high-quality JPG or PNG image.',
  color: '#f1c40f',
  icon: 'pdf2img',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, pdf, layout }) => {
      let format = 'jpg';
      const dpiSel = select([['72', 'Low (72 dpi)'], ['150', 'Medium (150 dpi)'], ['300', 'High (300 dpi)']], '150');
      const pagesInput = el('input', { type: 'text', value: `1-${pdf.numPages}` });

      layout.work.append(
        el('div', { class: 'compress-intro' },
          el('p', {}, `Every selected page of this ${pdf.numPages}-page PDF will be converted into an image. Multiple images are downloaded as a ZIP file.`),
        ),
      );
      layout.side.append(
        panel('Image format', segmented([['jpg', 'JPG'], ['png', 'PNG']], format, (v) => (format = v))),
        panel('Quality', dpiSel),
        panel('Pages', field('Page range', pagesInput)),
        actionButton('Convert to images', () => {
          let pages;
          try {
            pages = [...new Set(parseRanges(pagesInput.value, pdf.numPages).flat())];
          } catch (err) {
            return toast(err.message, 'error');
          }
          return withBusy('Converting…', async (progress) => {
            const scale = Number(dpiSel.value) / 72;
            const digits = String(pdf.numPages).length;
            const type = format === 'png' ? 'image/png' : 'image/jpeg';
            const name = baseName(file.name);
            const blobs = [];
            for (const [i, idx] of pages.entries()) {
              progress(`Rendering page ${i + 1} of ${pages.length}…`);
              const { canvas } = await renderPage(pdf, idx + 1, await safeScale(pdf, idx + 1, scale));
              blobs.push([`${name}_page${String(idx + 1).padStart(digits, '0')}.${format}`, await canvasToBlob(canvas, type, 0.92)]);
              canvas.width = canvas.height = 0;
            }
            if (blobs.length === 1) {
              download(blobs[0][1], blobs[0][0], type);
              return toast('Image downloaded.', 'success');
            }
            progress('Zipping…');
            const zip = new JSZip();
            blobs.forEach(([n, b]) => zip.file(n, b));
            download(await zip.generateAsync({ type: 'blob' }), `${name}_images.zip`, 'application/zip');
            toast('Images downloaded.', 'success');
          });
        }),
      );
    });
  },
};
