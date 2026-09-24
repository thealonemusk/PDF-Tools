import { PDFDocument } from '@cantoo/pdf-lib';
import { el, dropzone, toolLayout, withBusy, download, pickFiles, toast, formatBytes } from '../lib/ui.js';
import { readPdfFile, openForRender, openForEdit, saveDoc, renderThumb } from '../lib/pdf.js';
import { cardGrid, iconButton } from '../lib/grid.js';
import { actionButton, panel } from '../lib/tool.js';

export default {
  id: 'merge',
  title: 'Merge PDF',
  desc: 'Combine multiple PDFs into one document in the order you want.',
  color: '#e5322d',
  icon: 'merge',
  mount(container) {
    const layout = toolLayout(container, this);
    let grid;
    let alive = true;

    async function addFiles(files) {
      await withBusy('Reading files…', async (progress) => {
        const added = [];
        for (const [i, file] of files.entries()) {
          if (!alive) return;
          progress(`Reading ${i + 1} of ${files.length}…`);
          try {
            const bytes = await readPdfFile(file);
            if (!bytes) continue; // password prompt cancelled
            const pdf = await openForRender(bytes);
            const thumb = (await renderThumb(pdf, 1, 170)).toDataURL('image/jpeg', 0.85);
            added.push({ file, bytes, pages: pdf.numPages, thumb, id: crypto.randomUUID() });
            pdf.loadingTask.destroy();
          } catch (e) {
            toast(`Skipped "${file.name}": not a readable PDF`, 'error');
          }
        }
        if (!added.length) return;
        if (!grid) buildWorkspace(added);
        else grid.set([...grid.items, ...added]);
      });
    }

    function buildWorkspace(items) {
      layout.open();
      const count = el('span', { class: 'muted' });
      const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
      const updateCount = (list) => (count.textContent = `${plural(list.length, 'file')} · ${plural(list.reduce((s, f) => s + f.pages, 0), 'page')}`);
      grid = cardGrid({
        items,
        onChange: updateCount,
        renderCard(f, i, api) {
          return el(
            'div',
            { class: 'card' },
            el('div', { class: 'thumb-frame' }, el('img', { src: f.thumb, alt: '', draggable: false })),
            el('div', { class: 'card-label', title: f.file.name }, f.file.name),
            el('div', { class: 'card-sub' }, `${f.pages} page${f.pages === 1 ? '' : 's'} · ${formatBytes(f.file.size)}`),
            el(
              'div',
              { class: 'card-actions' },
              iconButton('left', 'Move left', () => api.move(i, i - 1), i === 0),
              iconButton('del', 'Remove file', () => api.remove(i)),
              iconButton('right', 'Move right', () => api.move(i, i + 1), i === api.items.length - 1),
            ),
          );
        },
      });
      updateCount(items);
      layout.work.append(
        el(
          'div',
          { class: 'file-bar' },
          el('span', { class: 'file-name' }, 'Drag cards to reorder'),
          count,
          el('button', { class: 'btn btn-ghost btn-sm', onClick: async () => addFiles(await pickFiles('.pdf,application/pdf')) }, '+ Add more files'),
        ),
        grid.root,
      );
      // Files dragged from the desktop onto the workspace are appended to the list.
      layout.work.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      layout.work.addEventListener('drop', (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const files = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
        if (files.length) addFiles(files);
        else toast('Only PDF files can be merged.', 'error');
      });
      layout.side.append(
        panel(
          'Order',
          el('div', { class: 'row' },
            el('button', { class: 'btn btn-ghost btn-sm', onClick: () => grid.set([...grid.items].sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }))) }, 'Sort A→Z'),
            el('button', { class: 'btn btn-ghost btn-sm', onClick: () => grid.set([...grid.items].reverse()) }, 'Reverse'),
          ),
        ),
        actionButton('Merge PDF', merge),
      );
    }

    async function merge() {
      const files = grid.items;
      if (files.length < 2) return toast('Add at least two PDFs to merge.', 'error');
      await withBusy('Merging…', async (progress) => {
        const out = await PDFDocument.create();
        for (const [i, f] of files.entries()) {
          progress(`Merging ${i + 1} of ${files.length}…`);
          const src = await openForEdit(f.bytes);
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        }
        download(await saveDoc(out), 'merged.pdf');
        toast('Merged PDF downloaded.', 'success');
      });
    }

    layout.intro.append(dropzone({ accept: '.pdf,application/pdf', multiple: true, label: 'Select PDF files', onFiles: addFiles }));
    return () => (alive = false);
  },
};
