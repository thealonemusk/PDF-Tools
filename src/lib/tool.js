// Shared scaffolding for tools that operate on a single PDF.
import { el, dropzone, toolLayout, withBusy, formatBytes } from './ui.js';
import { readPdfFile, openForRender } from './pdf.js';

/**
 * Shows the landing drop zone, loads the chosen PDF with pdf.js, then calls
 * onLoad({ file, bytes, pdf, layout }) to build the workspace.
 */
export function singlePdfTool(container, meta, onLoad) {
  const layout = toolLayout(container, meta);
  let cleanup, doc;
  layout.intro.append(
    dropzone({
      accept: '.pdf,application/pdf',
      label: 'Select PDF file',
      onFiles: ([file]) =>
        withBusy('Opening PDF…', async () => {
          const bytes = await readPdfFile(file);
          if (!bytes) return; // password prompt cancelled
          const pdf = (doc = await openForRender(bytes));
          layout.open();
          layout.work.prepend(fileBar(file, pdf.numPages));
          cleanup = await onLoad({ file, bytes, pdf, layout });
        }),
    }),
  );
  return () => {
    cleanup?.();
    doc?.loadingTask.destroy();
  };
}

export function fileBar(file, pages) {
  return el(
    'div',
    { class: 'file-bar' },
    el('span', { class: 'file-name' }, file.name),
    el('span', { class: 'muted' }, `${pages} page${pages === 1 ? '' : 's'} · ${formatBytes(file.size)}`),
    el('a', { href: location.hash, class: 'btn btn-ghost btn-sm', onClick: () => setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange'))) }, 'Start over'),
  );
}

/** The big red action button at the bottom of the side panel. */
export function actionButton(label, onClick) {
  return el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block action', onClick }, label);
}

/** Side panel section with a heading. */
export function panel(title, ...children) {
  return el('div', { class: 'panel' }, title && el('h3', {}, title), ...children);
}
