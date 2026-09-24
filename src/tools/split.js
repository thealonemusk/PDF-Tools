import JSZip from 'jszip';
import { PDFDocument } from '@cantoo/pdf-lib';
import { el, withBusy, download, toast, field, segmented, parseRanges, baseName } from '../lib/ui.js';
import { openForEdit, saveDoc } from '../lib/pdf.js';
import { thumbLoader } from '../lib/grid.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

export default {
  id: 'split',
  title: 'Split PDF',
  desc: 'Split a PDF into separate files by page ranges, fixed chunks or single pages.',
  color: '#e5322d',
  icon: 'split',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      const n = pdf.numPages;
      const thumbs = thumbLoader(pdf, 140);
      let mode = 'ranges';

      const rangesInput = el('input', { type: 'text', value: n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}` : '1' });
      const chunkInput = el('input', { type: 'number', min: 1, max: n, value: Math.min(2, n) });
      const mergeBox = el('input', { type: 'checkbox' });
      const preview = el('div', { class: 'range-preview' });

      const rangesField = field('Page ranges', rangesInput, 'Each comma-separated range becomes its own PDF, e.g. 1-3, 5, 8-');
      const chunkField = field('Pages per file', chunkInput);
      const mergeField = el('label', { class: 'check-row' }, mergeBox, 'Merge all ranges into one PDF');

      function groups() {
        if (mode === 'every') return Array.from({ length: n }, (_, i) => [i]);
        if (mode === 'chunk') {
          const k = Math.max(1, Math.min(n, parseInt(chunkInput.value, 10) || 1));
          const out = [];
          for (let i = 0; i < n; i += k) out.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
          return out;
        }
        return parseRanges(rangesInput.value, n);
      }

      function drawPreview() {
        rangesField.hidden = mode !== 'ranges';
        mergeField.hidden = mode !== 'ranges';
        chunkField.hidden = mode !== 'chunk';
        let gs;
        try {
          gs = groups();
        } catch (e) {
          preview.replaceChildren(el('p', { class: 'error-text' }, e.message));
          return;
        }
        preview.replaceChildren(
          ...gs.slice(0, 60).map((g, i) =>
            el(
              'div',
              { class: 'range-group' },
              el('div', { class: 'range-title' }, `File ${i + 1}`, el('span', { class: 'muted' }, g.length === 1 ? ` · page ${g[0] + 1}` : ` · pages ${g[0] + 1}–${g[g.length - 1] + 1}`)),
              el('div', { class: 'range-thumbs' },
                el('div', { class: 'mini' }, thumbs.thumb(g[0] + 1)),
                g.length > 1 ? el('span', { class: 'dots' }, '…') : null,
                g.length > 1 ? el('div', { class: 'mini' }, thumbs.thumb(g[g.length - 1] + 1)) : null,
              ),
            ),
          ),
          ...(gs.length > 60 ? [el('p', { class: 'muted' }, `…and ${gs.length - 60} more files`)] : []),
        );
      }

      rangesInput.addEventListener('input', drawPreview);
      chunkInput.addEventListener('input', drawPreview);
      // Show the value that will actually be used once the user leaves the field.
      chunkInput.addEventListener('change', () => {
        chunkInput.value = Math.max(1, Math.min(n, parseInt(chunkInput.value, 10) || 1));
        drawPreview();
      });

      layout.work.append(preview);
      layout.side.append(
        panel(
          'Split mode',
          segmented([['ranges', 'Ranges'], ['chunk', 'Fixed'], ['every', 'Every page']], mode, (v) => {
            mode = v;
            drawPreview();
          }),
          rangesField,
          chunkField,
          mergeField,
        ),
        actionButton('Split PDF', () => {
          let gs;
          try {
            gs = groups();
          } catch (e) {
            return toast(e.message, 'error');
          }
          return withBusy('Splitting…', async (progress) => {
            const src = await openForEdit(bytes);
            const name = baseName(file.name);
            const build = async (indices) => {
              const out = await PDFDocument.create();
              (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
              return saveDoc(out);
            };
            if (mode === 'ranges' && mergeBox.checked) {
              download(await build(gs.flat()), `${name}_extracted.pdf`);
            } else if (gs.length === 1) {
              download(await build(gs[0]), `${name}_part1.pdf`);
            } else {
              const zip = new JSZip();
              for (const [i, g] of gs.entries()) {
                progress(`Creating file ${i + 1} of ${gs.length}…`);
                const label = g.length === 1 ? `page${g[0] + 1}` : `pages${g[0] + 1}-${g[g.length - 1] + 1}`;
                zip.file(`${name}_${String(i + 1).padStart(2, '0')}_${label}.pdf`, await build(g));
              }
              progress('Zipping…');
              download(await zip.generateAsync({ type: 'blob' }), `${name}_split.zip`, 'application/zip');
            }
            toast('Done! Your files are downloading.', 'success');
          });
        }),
      );
      drawPreview();
      return thumbs.destroy;
    });
  },
};
