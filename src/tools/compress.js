import { PDFDocument } from '@cantoo/pdf-lib';
import { el, withBusy, download, formatBytes, baseName, toast } from '../lib/ui.js';
import { openForEdit, saveDoc, renderPage, canvasToBlob, blobToBytes } from '../lib/pdf.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

const LEVELS = [
  { id: 'light', label: 'Lossless', sub: 'Re-packs the file structure. Text stays selectable; smaller savings.' },
  { id: 'medium', label: 'Recommended', sub: 'Good quality, strong compression (~120 dpi).', dpi: 120, quality: 0.7 },
  { id: 'strong', label: 'Extreme', sub: 'Smallest file, lower quality (~80 dpi).', dpi: 80, quality: 0.5 },
];

export default {
  id: 'compress',
  title: 'Compress PDF',
  desc: 'Reduce file size while keeping the best quality possible.',
  color: '#27ae60',
  icon: 'compress',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      let level = LEVELS[1];
      const result = el('div', { class: 'result hidden' });
      const options = LEVELS.map((l) => {
        const card = el(
          'button',
          { type: 'button', class: `option-card${l === level ? ' active' : ''}` },
          el('strong', {}, l.label),
          el('span', {}, l.sub),
        );
        card.addEventListener('click', () => {
          level = l;
          options.forEach((o) => o.classList.toggle('active', o === card));
        });
        return card;
      });

      layout.work.append(
        el('div', { class: 'compress-intro' },
          el('div', { class: 'big-stat' }, el('span', { class: 'muted' }, 'Original size'), el('strong', {}, formatBytes(file.size))),
          el('p', { class: 'muted' }, 'Recommended and Extreme modes re-render each page as an optimized image. This gives the biggest reduction for scanned documents and image-heavy PDFs, but text will no longer be selectable.'),
        ),
        result,
      );
      layout.side.append(
        panel('Compression level', ...options),
        actionButton('Compress PDF', () =>
          withBusy('Compressing…', async (progress) => {
            let out;
            if (!level.dpi) {
              const doc = await openForEdit(bytes);
              out = await saveDoc(doc);
            } else {
              const doc = await PDFDocument.create();
              for (let i = 1; i <= pdf.numPages; i++) {
                progress(`Compressing page ${i} of ${pdf.numPages}…`);
                const { canvas, page } = await renderPage(pdf, i, level.dpi / 72);
                const vp = page.getViewport({ scale: 1 });
                const img = await doc.embedJpg(await blobToBytes(await canvasToBlob(canvas, 'image/jpeg', level.quality)));
                const p = doc.addPage([vp.width, vp.height]);
                p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
                canvas.width = canvas.height = 0; // free memory early
              }
              out = await saveDoc(doc);
            }
            const saved = 1 - out.length / file.size; // not bytes.length: encrypted files were decrypted on open
            const name = `${baseName(file.name)}_compressed.pdf`;
            result.classList.remove('hidden');
            if (saved <= 0.01) {
              result.replaceChildren(
                el('h3', {}, 'Already well optimized'),
                el('p', { class: 'muted' }, level.dpi
                  ? `The result (${formatBytes(out.length)}) wasn't smaller than the original. This PDF is mostly text or vector graphics, which is already compact — turning its pages into images would only make it bigger.`
                  : `The result (${formatBytes(out.length)}) wasn't smaller than the original. Try the Recommended or Extreme level.`),
              );
              toast('Could not reduce the size further at this level.', 'info');
              return;
            }
            result.replaceChildren(
              el('h3', {}, `Your PDF is now ${Math.round(saved * 100)}% smaller`),
              el('div', { class: 'size-compare' },
                el('span', {}, formatBytes(file.size)), el('span', { class: 'arrow' }, '→'), el('strong', {}, formatBytes(out.length)),
              ),
              el('button', { class: 'btn btn-primary', onClick: () => download(out, name) }, 'Download compressed PDF'),
            );
            download(out, name);
          }),
        ),
      );
    });
  },
};
