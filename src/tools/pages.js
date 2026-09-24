// Page-level tools that share the thumbnail grid: organize, rotate, remove, extract.
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import { el, withBusy, download, toast, field, parseRanges, baseName } from '../lib/ui.js';
import { openForEdit, saveDoc } from '../lib/pdf.js';
import { pageGrid } from '../lib/grid.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

/** Build a new PDF from grid entries ({src, rot}) in order, applying extra rotation. */
async function buildFromEntries(bytes, entries) {
  const src = await openForEdit(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, entries.map((e) => e.src));
  copied.forEach((page, i) => {
    const rot = entries[i].rot || 0;
    if (rot) page.setRotation(degrees((page.getRotation().angle + rot) % 360));
    out.addPage(page);
  });
  return saveDoc(out);
}

export const organize = {
  id: 'organize',
  title: 'Organize PDF',
  desc: 'Reorder, rotate and delete pages. Drag thumbnails to rearrange.',
  color: '#f07b1a',
  icon: 'organize',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      const info = el('p', { class: 'muted' });
      const grid = pageGrid(pdf, { rotate: true, remove: true, sortable: true, onChange: (l) => (info.textContent = `${l.length} page${l.length === 1 ? '' : 's'} in output`) });
      info.textContent = `${pdf.numPages} pages in output`;
      layout.work.append(grid.root);
      layout.side.append(
        panel(
          'Organize',
          el('p', { class: 'muted' }, 'Drag pages to reorder. Use the buttons under each page to rotate or delete it.'),
          info,
          el('div', { class: 'row' },
            el('button', { class: 'btn btn-ghost btn-sm', onClick: () => grid.set([...grid.items].reverse()) }, 'Reverse order'),
            el('button', { class: 'btn btn-ghost btn-sm', onClick: () => grid.set(Array.from({ length: pdf.numPages }, (_, i) => ({ src: i, rot: 0 }))) }, 'Reset'),
          ),
        ),
        actionButton('Save PDF', () => {
          if (!grid.items.length) return toast('The document has no pages left.', 'error');
          return withBusy('Saving…', async () => download(await buildFromEntries(bytes, grid.items), `${baseName(file.name)}_organized.pdf`));
        }),
      );
      return grid.destroy;
    });
  },
};

export const rotate = {
  id: 'rotate',
  title: 'Rotate PDF',
  desc: 'Rotate all pages or just the ones you pick.',
  color: '#8e44ad',
  icon: 'rotate',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
      const grid = pageGrid(pdf, { rotate: true });
      const rotateAll = (d) => {
        grid.items.forEach((p) => (p.rot = (p.rot + d + 360) % 360));
        grid.refresh();
      };
      layout.work.append(grid.root);
      layout.side.append(
        panel(
          'Rotate all pages',
          el('div', { class: 'row' },
            el('button', { class: 'btn btn-ghost', onClick: () => rotateAll(-90) }, '⟲ Left'),
            el('button', { class: 'btn btn-ghost', onClick: () => rotateAll(90) }, '⟳ Right'),
            el('button', { class: 'btn btn-ghost', onClick: () => rotateAll(180) }, '180°'),
          ),
          el('p', { class: 'muted' }, 'Or rotate individual pages with the buttons under each thumbnail.'),
        ),
        actionButton('Rotate PDF', () =>
          withBusy('Saving…', async () => download(await buildFromEntries(bytes, grid.items), `${baseName(file.name)}_rotated.pdf`)),
        ),
      );
      return grid.destroy;
    });
  },
};

/** Shared implementation for "remove pages" and "extract pages": click to select, or type ranges. */
function selectionTool(meta, { verb, keepSelected, suffix }) {
  return {
    ...meta,
    mount(container) {
      return singlePdfTool(container, this, async ({ file, bytes, pdf, layout }) => {
        const n = pdf.numPages;
        const status = el('p', { class: 'muted' });
        const input = el('input', { type: 'text', placeholder: 'e.g. 1, 3-5' });
        const grid = pageGrid(pdf, { select: true, onChange: sync });

        function sync() {
          const sel = grid.items.filter((p) => p.selected).map((p) => p.src + 1);
          status.textContent = `${sel.length} of ${n} pages selected`;
          input.value = compress(sel);
        }
        /** Apply the typed ranges to the selection; false (after telling the user) if they are invalid. */
        function applyInput() {
          try {
            const set = new Set(input.value.trim() ? parseRanges(input.value, n).flat() : []);
            grid.items.forEach((p) => (p.selected = set.has(p.src)));
            grid.refresh();
            sync();
            return true;
          } catch (e) {
            toast(e.message, 'error');
            return false;
          }
        }
        input.addEventListener('change', applyInput);
        sync();

        layout.work.append(grid.root);
        layout.side.append(
          panel(
            `Pages to ${verb}`,
            el('p', { class: 'muted' }, 'Click thumbnails to select pages, or type ranges below.'),
            field('Pages', input),
            status,
            el('div', { class: 'row' },
              el('button', { class: 'btn btn-ghost btn-sm', onClick: () => { grid.items.forEach((p) => (p.selected = true)); grid.refresh(); sync(); } }, 'Select all'),
              el('button', { class: 'btn btn-ghost btn-sm', onClick: () => { grid.items.forEach((p) => (p.selected = false)); grid.refresh(); sync(); } }, 'Clear'),
            ),
          ),
          actionButton(`${verb[0].toUpperCase()}${verb.slice(1)} pages`, () => {
            // An invalid range must not fall back to the previous selection.
            if (!applyInput()) return;
            const keep = grid.items.filter((p) => p.selected === keepSelected);
            if (!grid.items.some((p) => p.selected)) return toast('Select at least one page first.', 'error');
            if (!keep.length) return toast('That would leave no pages in the document.', 'error');
            return withBusy('Saving…', async () => download(await buildFromEntries(bytes, keep), `${baseName(file.name)}_${suffix}.pdf`));
          }),
        );
        return grid.destroy;
      });
    },
  };
}

/** [1,2,3,5] -> "1-3, 5" */
function compress(nums) {
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j;
  }
  return parts.join(', ');
}

export const removePages = selectionTool(
  { id: 'remove', title: 'Remove pages', desc: 'Delete the pages you don’t need from a PDF.', color: '#c0392b', icon: 'remove' },
  { verb: 'remove', keepSelected: false, suffix: 'removed' },
);

export const extractPages = selectionTool(
  { id: 'extract', title: 'Extract pages', desc: 'Pull selected pages out into a new PDF.', color: '#16a085', icon: 'extract' },
  { verb: 'extract', keepSelected: true, suffix: 'extracted' },
);
