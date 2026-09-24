import './style.css';
import { el } from './lib/ui.js';
import merge from './tools/merge.js';
import split from './tools/split.js';
import compress from './tools/compress.js';
import { organize, rotate, removePages, extractPages } from './tools/pages.js';
import { imagesToPdf, pdfToImages } from './tools/convert.js';
import { watermark, pageNumbers } from './tools/stamp.js';
import { editor, sign } from './tools/editor.js';
import { protect, unlock } from './tools/security.js';

const GROUPS = [
  ['Organize', [merge, split, organize, removePages, extractPages]],
  ['Optimize & edit', [compress, editor, sign, rotate]],
  ['Convert', [imagesToPdf, pdfToImages]],
  ['Stamp', [watermark, pageNumbers]],
  ['Security', [protect, unlock]],
];
const TOOLS = Object.fromEntries(GROUPS.flatMap(([, list]) => list).map((t) => [t.id, t]));

const ICON_PATHS = {
  merge: '<path d="M8 4v5a4 4 0 0 0 4 4 4 4 0 0 1 4 4v3"/><path d="M16 4v5a4 4 0 0 1-2 3.5"/><path d="m13 17 3 3 3-3"/>',
  split: '<path d="M12 3v18"/><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
  organize: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  remove: '<path d="M6 3h9l4 4v14H6z"/><path d="M9.5 12.5l5 5M14.5 12.5l-5 5"/>',
  extract: '<path d="M6 3h9l4 4v14H6z"/><path d="M12 10v7M9 14l3 3 3-3"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  sign: '<path d="M3 17c3-1 4-9 7-9s-1 9 2 9 3-4 5-4 2 3 4 3"/><path d="M3 21h18"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  img2pdf: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  pdf2img: '<path d="M6 3h9l4 4v14H6z"/><circle cx="10" cy="11" r="1.5"/><path d="m18 18-4-4-6 6"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  protect: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  numbers: '<path d="M6 3h9l4 4v14H6z"/><path d="M10 13h1v5M10 18h2"/>',
};

export function toolIcon(t, size = 28) {
  return el('span', {
    class: 'tool-icon',
    style: { background: t.color },
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="white" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[t.icon]}</svg>`,
  });
}

function home(container) {
  container.append(
    el('section', { class: 'hero' },
      el('h1', {}, 'Every tool you need to work with PDFs'),
      el('p', {}, 'Merge, split, compress, edit, sign and convert PDFs — free, fast and completely private. Files are processed right in your browser and never uploaded.'),
    ),
    ...GROUPS.map(([name, list]) =>
      el('section', { class: 'tool-group' },
        el('h2', {}, name),
        el('div', { class: 'tool-grid' },
          ...list.map((t) =>
            el('a', { class: 'tool-card', href: `#/${t.id}` }, toolIcon(t), el('h3', {}, t.title), el('p', {}, t.desc)),
          ),
        ),
      ),
    ),
  );
}

const app = document.getElementById('app');
let cleanup;

function route() {
  cleanup?.();
  cleanup = undefined;
  document.querySelector('.modal-backdrop')?.remove();
  app.replaceChildren();
  const id = location.hash.replace(/^#\/?/, '').split('?')[0];
  const tool = TOOLS[id];
  document.querySelectorAll('.topnav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${id}`));
  if (!tool) {
    document.title = 'PDF Tools — edit PDFs in your browser';
    home(app);
  } else {
    document.title = `${tool.title} — PDF Tools`;
    const page = el('div', { class: 'tool-page' });
    app.append(page);
    cleanup = tool.mount(page);
  }
  window.scrollTo(0, 0);
}

// A file dropped outside a drop zone would otherwise make the browser navigate away to it.
window.addEventListener('dragover', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('hashchange', route);
route();
