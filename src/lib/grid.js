// Thumbnail grids: a generic sortable card grid plus a page grid built on top of it.
import { el } from './ui.js';
import { renderThumb } from './pdf.js';

const ICONS = {
  rotL: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  rotR: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  left: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
};
export { ICONS as GRID_ICONS };

export function iconButton(icon, title, onClick, disabled = false) {
  return el('button', {
    type: 'button',
    class: 'icon-btn',
    title,
    'aria-label': title,
    disabled,
    html: ICONS[icon] || icon,
    onClick: (e) => {
      e.stopPropagation();
      onClick(e);
    },
  });
}

/**
 * Renders `items` as cards; supports drag-to-reorder when `sortable` is set.
 * renderCard(item, index, api) must return an element.
 */
export function cardGrid({ items, renderCard, sortable = true, onChange }) {
  const root = el('div', { class: 'card-grid' });
  let list = [...items];
  let dragIndex = -1;

  const api = {
    root,
    get items() {
      return list;
    },
    set(next) {
      list = [...next];
      draw();
      onChange?.(list);
    },
    move(from, to) {
      if (to < 0 || to >= list.length || from === to) return;
      const [it] = list.splice(from, 1);
      list.splice(to, 0, it);
      draw();
      onChange?.(list);
    },
    remove(index) {
      list.splice(index, 1);
      draw();
      onChange?.(list);
    },
    refresh: () => draw(),
  };

  function draw() {
    root.replaceChildren();
    list.forEach((item, i) => {
      const card = renderCard(item, i, api);
      if (sortable) {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
          dragIndex = i;
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
        });
        card.addEventListener('dragend', () => {
          dragIndex = -1;
          card.classList.remove('dragging');
          root.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
        });
        card.addEventListener('dragover', (e) => {
          if (dragIndex < 0) return;
          e.preventDefault();
          card.classList.add('drop-target');
        });
        card.addEventListener('dragleave', (e) => !card.contains(e.relatedTarget) && card.classList.remove('drop-target'));
        card.addEventListener('drop', (e) => {
          if (dragIndex < 0) return; // e.g. files dropped from the desktop: let the page handle it
          e.preventDefault();
          card.classList.remove('drop-target');
          const from = dragIndex;
          dragIndex = -1;
          if (from >= 0) api.move(from, i);
        });
      }
      root.append(card);
    });
  }
  draw();
  return api;
}

/** Lazily renders page thumbnails as they scroll into view; caches by page number. */
export function thumbLoader(pdf, size = 170) {
  const cache = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        fill(entry.target);
      }
    },
    { rootMargin: '400px' },
  );
  async function get(pageNumber) {
    if (!cache.has(pageNumber)) {
      cache.set(
        pageNumber,
        renderThumb(pdf, pageNumber, size).then((c) => c.toDataURL('image/jpeg', 0.85)),
      );
    }
    return cache.get(pageNumber);
  }
  async function fill(holder) {
    let url;
    try {
      url = await get(Number(holder.dataset.page));
    } catch {
      return; // document was closed (e.g. user left the tool) before the render finished
    }
    const img = el('img', { src: url, alt: `Page ${holder.dataset.page}`, draggable: false });
    holder.replaceChildren(img);
  }
  return {
    /** Returns a placeholder element that becomes the thumbnail image once visible. */
    thumb(pageNumber) {
      const holder = el('div', { class: 'thumb-holder', 'data-page': pageNumber }, el('div', { class: 'thumb-loading' }));
      if (cache.has(pageNumber)) fill(holder);
      else observer.observe(holder);
      return holder;
    },
    destroy: () => observer.disconnect(),
  };
}

/**
 * Grid of pages of one PDF. Each entry: { src: 0-based page index, rot: extra rotation, selected }.
 * Options toggle features: rotate, remove, select, sortable.
 */
export function pageGrid(pdf, { rotate = false, remove = false, select = false, sortable = false, onChange } = {}) {
  const thumbs = thumbLoader(pdf);
  const pages = Array.from({ length: pdf.numPages }, (_, i) => ({ src: i, rot: 0, selected: false }));

  const grid = cardGrid({
    items: pages,
    sortable,
    onChange,
    renderCard(p, i, api) {
      const t = thumbs.thumb(p.src + 1);
      t.style.transform = `rotate(${p.rot}deg)`;
      const actions = el('div', { class: 'card-actions' });
      if (sortable) {
        actions.append(iconButton('left', 'Move left', () => api.move(i, i - 1), i === 0));
      }
      if (rotate) {
        actions.append(
          iconButton('rotL', 'Rotate left', () => {
            p.rot = (p.rot + 270) % 360;
            api.refresh();
            onChange?.(api.items);
          }),
          iconButton('rotR', 'Rotate right', () => {
            p.rot = (p.rot + 90) % 360;
            api.refresh();
            onChange?.(api.items);
          }),
        );
      }
      if (remove) actions.append(iconButton('del', 'Delete page', () => api.remove(i)));
      if (sortable) actions.append(iconButton('right', 'Move right', () => api.move(i, i + 1), i === api.items.length - 1));

      const card = el(
        'div',
        { class: `card page-card${p.selected ? ' selected' : ''}${select ? ' selectable' : ''}` },
        el('div', { class: 'thumb-frame' }, t),
        el('div', { class: 'card-label' }, `${p.src + 1}`),
        actions.childElementCount ? actions : null,
        select ? el('span', { class: 'check' }, '✓') : null,
      );
      if (select) {
        card.addEventListener('click', () => {
          p.selected = !p.selected;
          card.classList.toggle('selected', p.selected);
          onChange?.(api.items);
        });
      }
      return card;
    },
  });
  grid.destroy = thumbs.destroy;
  return grid;
}
