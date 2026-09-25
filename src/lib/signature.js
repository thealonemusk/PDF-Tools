// Modal for creating a signature by drawing, typing or uploading. Resolves to a PNG File or null.
import { el, segmented, toast } from './ui.js';
import { canvasToBlob } from './pdf.js';

const SCRIPT_FONTS = [
  ['Great Vibes', 'Elegant'],
  ['Dancing Script', 'Flowing'],
  ['Caveat', 'Casual'],
];
const INKS = ['#111111', '#1a3fbf', '#c0392b'];

/** Crop a canvas to its non-transparent pixels (plus a small margin). */
function trim(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const m = 6;
  minX = Math.max(0, minX - m); minY = Math.max(0, minY - m);
  maxX = Math.min(width - 1, maxX + m); maxY = Math.min(height - 1, maxY + m);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function openSignaturePad() {
  return new Promise((resolve) => {
    let mode = 'draw';
    let ink = INKS[0];

    // draw tab
    const pad = el('canvas', { class: 'sig-pad' });
    const drawPane = el('div', { class: 'sig-pane' }, pad,
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm sig-clear', onClick: () => clearPad() }, 'Clear'));
    let strokes = [];
    const ctx = pad.getContext('2d');
    function sizePad() {
      const r = pad.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      pad.width = Math.round(r.width * dpr * 1.5);
      pad.height = Math.round(r.height * dpr * 1.5);
      redraw();
    }
    function redraw() {
      ctx.clearRect(0, 0, pad.width, pad.height);
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = ink;
      ctx.lineWidth = pad.width / 180;
      for (const s of strokes) {
        ctx.beginPath();
        s.forEach(([x, y], i) => {
          const px = x * pad.width, py = y * pad.height;
          if (i === 0) ctx.moveTo(px, py);
          else {
            const [lx, ly] = s[i - 1];
            ctx.quadraticCurveTo(lx * pad.width, ly * pad.height, (px + lx * pad.width) / 2, (py + ly * pad.height) / 2);
          }
        });
        if (s.length === 1) ctx.lineTo(s[0][0] * pad.width + 0.1, s[0][1] * pad.height);
        ctx.stroke();
      }
    }
    function clearPad() {
      strokes = [];
      redraw();
    }
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      const r = pad.getBoundingClientRect();
      const pt = (ev) => [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height];
      const stroke = [pt(e)];
      strokes.push(stroke);
      const move = (ev) => {
        stroke.push(pt(ev));
        redraw();
      };
      const up = () => {
        pad.removeEventListener('pointermove', move);
        pad.removeEventListener('pointerup', up);
        pad.removeEventListener('pointercancel', up);
        redraw();
      };
      pad.addEventListener('pointermove', move);
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
    });

    // type tab
    const nameInput = el('input', { type: 'text', placeholder: 'Type your name', value: '' });
    let typeFont = SCRIPT_FONTS[0][0];
    const fontChoices = el('div', { class: 'sig-fonts' });
    const typePreviews = SCRIPT_FONTS.map(([f, label]) => {
      const b = el('button', { type: 'button', class: `sig-font${f === typeFont ? ' active' : ''}`, style: { fontFamily: `"${f}", cursive` }, title: label }, 'Your Name');
      b.addEventListener('click', () => {
        typeFont = f;
        typePreviews.forEach((x) => x.classList.toggle('active', x === b));
      });
      fontChoices.append(b);
      return b;
    });
    nameInput.addEventListener('input', () => typePreviews.forEach((b) => (b.textContent = nameInput.value || 'Your Name')));
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && done());
    const typePane = el('div', { class: 'sig-pane hidden' }, nameInput, fontChoices);

    // upload tab
    let uploaded = null;
    const upPreview = el('div', { class: 'sig-upload-preview muted' }, 'PNG with a transparent background works best.');
    const upInput = el('input', { type: 'file', accept: 'image/*' });
    upInput.addEventListener('change', () => {
      uploaded = upInput.files[0] || null;
      if (uploaded) upPreview.replaceChildren(el('img', { src: URL.createObjectURL(uploaded), alt: 'Signature preview' }));
    });
    const uploadPane = el('div', { class: 'sig-pane hidden' }, upInput, upPreview);

    const panes = { draw: drawPane, type: typePane, upload: uploadPane };
    const inkRow = el('div', { class: 'sig-inks' },
      ...INKS.map((c) => {
        const b = el('button', { type: 'button', class: `ink${c === ink ? ' active' : ''}`, style: { background: c }, title: 'Ink color' });
        b.addEventListener('click', () => {
          ink = c;
          inkRow.querySelectorAll('.ink').forEach((x) => x.classList.toggle('active', x === b));
          typePreviews.forEach((p) => (p.style.color = c));
          redraw();
        });
        return b;
      }),
    );

    const done = async () => {
      let canvas;
      if (mode === 'upload') {
        if (!uploaded) return toast('Choose an image first.', 'error');
        return close(uploaded);
      }
      if (mode === 'draw') {
        canvas = trim(pad);
        if (!canvas) return toast('Draw your signature first.', 'error');
      } else {
        const text = nameInput.value.trim();
        if (!text) return toast('Type your name first.', 'error');
        const font = `96px "${typeFont}", cursive`;
        // pass the text so the web-font subsets it needs (e.g. latin-ext for "ł", "ő") are loaded too
        await document.fonts.load(font, text).catch(() => {});
        canvas = document.createElement('canvas');
        const c = canvas.getContext('2d');
        c.font = font;
        // size the canvas from the real glyph bounds: script capitals and descenders swing far outside
        // the advance width and the em box, and a fixed 180px-high canvas clipped them
        const m = c.measureText(text);
        const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft || 0));
        const right = Math.ceil(Math.max(m.width, m.actualBoundingBoxRight || 0));
        const ascent = Math.ceil(Math.max(96, m.actualBoundingBoxAscent || 0));
        const descent = Math.ceil(Math.max(40, m.actualBoundingBoxDescent || 0));
        const pad = 24;
        canvas.width = left + right + pad * 2;
        canvas.height = ascent + descent + pad * 2;
        c.font = font;
        c.fillStyle = ink;
        c.textBaseline = 'alphabetic';
        c.fillText(text, pad + left, pad + ascent);
        canvas = trim(canvas) || canvas;
      }
      const blob = await canvasToBlob(canvas, 'image/png');
      close(new File([blob], 'signature.png', { type: 'image/png' }));
    };

    const modal = el('div', { class: 'modal-backdrop' },
      el('div', { class: 'modal', role: 'dialog', 'aria-label': 'Create signature' },
        el('div', { class: 'modal-head' }, el('h2', {}, 'Create your signature'),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => close(null) }, '×')),
        segmented([['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']], mode, (v) => {
          mode = v;
          Object.entries(panes).forEach(([k, p]) => p.classList.toggle('hidden', k !== v));
          inkRow.hidden = v === 'upload';
          if (v === 'draw') sizePad();
        }),
        drawPane, typePane, uploadPane,
        el('div', { class: 'modal-foot' }, inkRow,
          el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancel'),
          el('button', { type: 'button', class: 'btn btn-primary', onClick: done }, 'Use signature')),
      ),
    );
    modal.addEventListener('pointerdown', (e) => e.target === modal && close(null));
    const onKey = (e) => e.key === 'Escape' && close(null);
    document.addEventListener('keydown', onKey);
    // the pad's pixel size follows its CSS size; strokes are stored normalised so they survive a resize
    const onResize = () => mode === 'draw' && sizePad();
    window.addEventListener('resize', onResize);
    // leaving the page (route change) cancels the dialog so nothing is left dangling
    const onLeave = () => close(null);
    window.addEventListener('hashchange', onLeave);

    function close(result) {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onLeave);
      modal.remove();
      resolve(result);
    }

    document.body.append(modal);
    requestAnimationFrame(sizePad);
  });
}
