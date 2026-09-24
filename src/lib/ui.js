// Small DOM + UI helpers shared by every tool.

/** An expected, user-facing problem (bad input etc.): shown as-is, not logged as a crash. */
export class UserError extends Error {}

// Enumerated attributes where false is meaningful and must be written out as "false".
const ENUMERATED = new Set(['draggable', 'spellcheck', 'contenteditable', 'translate']);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (v === false) {
      if (ENUMERATED.has(k) || k.startsWith('aria-')) node.setAttribute(k, 'false');
      continue;
    }
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function toast(message, type = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  // The same message may be raised twice at once (e.g. a field's change event and a button click).
  if ([...box.children].some((t) => t.textContent === message && !t.classList.contains('out'))) return;
  const t = el('div', { class: `toast toast-${type}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

export function download(data, filename, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Drag & drop / click-to-pick file area.
 * onFiles receives an array of File objects filtered by `accept`.
 */
export function dropzone({ accept, multiple = false, label, hint, onFiles, compact = false }) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  const zone = el(
    'div',
    { class: `dropzone${compact ? ' compact' : ''}`, tabindex: 0 },
    el('div', { class: 'dz-icon', html: ICON_UPLOAD }),
    el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, label || (multiple ? 'Select files' : 'Select file')),
    el('p', { class: 'dz-hint' }, hint || 'or drop them here'),
    input,
  );
  const exts = accept.split(',').map((s) => s.trim().toLowerCase());
  const matches = (f) =>
    exts.some((a) => (a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a));
  const handle = (list) => {
    let files = [...list].filter(matches);
    if (!files.length) return toast('That file type is not supported here.', 'error');
    if (!multiple) files = files.slice(0, 1);
    onFiles(files);
  };
  zone.addEventListener('click', () => input.click());
  // The input lives inside the zone: keep its own click from bubbling back into the zone handler.
  input.addEventListener('click', (e) => e.stopPropagation());
  zone.addEventListener('keydown', (e) => {
    // Only when the zone itself is focused; the inner button already turns Enter/Space into a click.
    if (e.target !== zone || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    input.click();
  });
  input.addEventListener('change', () => {
    handle(input.files);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => !zone.contains(e.relatedTarget) && zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    handle(e.dataTransfer.files);
  });
  return zone;
}

/** Hidden file picker triggered by a button (for "add more" actions). */
export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => resolve([...input.files]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Ask for a PDF's password. Resolves to the entered string, or null if cancelled. */
export function promptPassword(fileName, wrong = false) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'off' });
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onLeave);
      backdrop.remove();
      resolve(value);
    };
    const submit = () => input.value && finish(input.value);
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter') submit();
      else return;
      e.stopPropagation();
    };
    const onLeave = () => finish(null);
    const backdrop = el('div', { class: 'modal-backdrop modal-top' },
      el('form', { class: 'modal modal-sm', role: 'dialog', 'aria-label': 'Enter PDF password', onSubmit: (e) => { e.preventDefault(); submit(); } },
        el('div', { class: 'modal-head' }, el('h2', {}, '🔒 Password required')),
        el('p', { class: 'muted' }, `“${fileName}” is protected. Enter its password to open it. The password never leaves your device.`),
        wrong ? el('p', { class: 'error-text' }, 'Incorrect password — please try again.') : null,
        input,
        el('div', { class: 'modal-foot' },
          el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => finish(null) }, 'Cancel'),
          el('button', { type: 'submit', class: 'btn btn-primary' }, 'Unlock')),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onLeave);
    document.body.append(backdrop);
    input.focus();
  });
}

/** Run an async action while showing a busy overlay with optional progress text. */
export async function withBusy(message, fn) {
  const text = el('div', { class: 'busy-text' }, message);
  const overlay = el('div', { class: 'busy' }, el('div', { class: 'spinner' }), text);
  document.body.append(overlay);
  const progress = (msg) => (text.textContent = msg);
  try {
    return await fn(progress);
  } catch (err) {
    // pdf.js aborts in-flight work when the user leaves a tool mid-load; nothing to report then
    if (/Transport destroyed|Worker was destroyed|Loading aborted/i.test(String(err?.message))) return undefined;
    if (!(err instanceof UserError)) console.error(err);
    toast(friendlyError(err), 'error', 6000);
    return undefined;
  } finally {
    overlay.remove();
  }
}

export function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err instanceof UserError) return msg;
  if (err?.name === 'PasswordException' || /encrypt|password/i.test(msg)) return 'This PDF is password-protected or encrypted and cannot be processed.';
  if (/Invalid PDF|No PDF header|Failed to parse/i.test(msg)) return 'This file does not look like a valid PDF.';
  return `Something went wrong: ${msg}`;
}

/**
 * Standard two-column tool layout: a work area on the left, options + action on the right.
 */
export function toolLayout(container, { title, desc }) {
  const work = el('section', { class: 'work' });
  const side = el('aside', { class: 'side' });
  const header = el('div', { class: 'tool-head' }, el('h1', {}, title), el('p', {}, desc));
  const intro = el('div', { class: 'tool-intro' }, header);
  const body = el('div', { class: 'tool-body hidden' }, work, side);
  container.append(intro, body);
  return {
    intro,
    work,
    side,
    /** Switch from the landing drop zone to the workspace view. */
    open() {
      intro.classList.add('hidden');
      body.classList.remove('hidden');
    },
  };
}

export function field(labelText, control, help) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, labelText), control, help && el('small', { class: 'help' }, help));
}

export function select(options, value) {
  const s = el('select', {});
  for (const [v, label] of options) s.append(el('option', { value: v, selected: v === value }, label));
  return s;
}

export function segmented(options, value, onChange) {
  const wrap = el('div', { class: 'segmented' });
  let current = value;
  const buttons = options.map(([v, label]) => {
    const b = el('button', { type: 'button', class: v === value ? 'active' : '' }, label);
    b.addEventListener('click', () => {
      current = v;
      buttons.forEach((x) => x.classList.toggle('active', x === b));
      onChange?.(v);
    });
    wrap.append(b);
    return b;
  });
  wrap.getValue = () => current;
  return wrap;
}

/**
 * Parse "1-3, 5, 8-" style page ranges (1-based, inclusive) into arrays of 0-based indices.
 * Returns one array per comma-separated group.
 */
export function parseRanges(text, pageCount) {
  const groups = [];
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let from, to;
    if (m) {
      from = m[1] ? parseInt(m[1], 10) : 1;
      to = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(part)) {
      from = to = parseInt(part, 10);
    } else {
      throw new UserError(`"${part}" is not a valid page range`);
    }
    if (from < 1 || to > pageCount || from > to) throw new UserError(`Range "${part}" is outside 1–${pageCount}`);
    const g = [];
    for (let i = from; i <= to; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new UserError('Please enter at least one page range');
  return groups;
}

export const ICON_UPLOAD =
  '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
