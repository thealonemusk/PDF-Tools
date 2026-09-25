// Wrappers around pdf.js (rendering) and pdf-lib (writing).
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, EncryptedPDFError, PDFName, PDFDict, PDFRef, PDFRawStream, PDFStream, PDFInvalidObject } from '@cantoo/pdf-lib';
import { promptPassword } from './ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Runtime data pdf.js fetches by file name (copied to /pdfjs/ by the Vite plugin in vite.config.js).
const PDFJS_ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
const RENDER_OPTIONS = {
  isEvalSupported: false,
  cMapUrl: `${PDFJS_ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
  iccUrl: `${PDFJS_ASSETS}iccs/`,
  wasmUrl: `${PDFJS_ASSETS}wasm/`,
};

export { pdfjsLib };

export async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

const ENCRYPT_MARK = [...'/Encrypt'].map((c) => c.charCodeAt(0));

/** Cheap check for an /Encrypt entry (trailer dictionaries are never compressed). */
export function looksEncrypted(bytes) {
  const [first] = ENCRYPT_MARK;
  outer: for (let i = bytes.indexOf(first); i !== -1; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < ENCRYPT_MARK.length; j++) if (bytes[i + j] !== ENCRYPT_MARK[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Remove every trace of encryption from a document that was loaded with its password, so it saves
 * as a plain PDF. Old cross-reference streams also carry /Encrypt and, once "decrypted", can't be parsed.
 */
function stripEncryption(doc) {
  const ctx = doc.context;
  const encRef = ctx.trailerInfo.Encrypt;
  delete ctx.trailerInfo.Encrypt;
  const Encrypt = PDFName.of('Encrypt');
  const head = (data) => String.fromCharCode(...data.subarray(0, 4096)).split('stream')[0];
  let infoRef;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream || obj instanceof PDFRawStream ? obj.dict : null;
    let stale, info;
    if (dict) {
      stale = dict.has(Encrypt);
      info = dict.get(PDFName.of('Info'));
    } else if (obj instanceof PDFInvalidObject) {
      const text = head(obj.data);
      stale = /\/Encrypt\b|\/Type\s*\/XRef\b/.test(text);
      const m = text.match(/\/Info\s+(\d+)\s+(\d+)\s+R/);
      info = m && PDFRef.of(Number(m[1]), Number(m[2]));
    }
    if (!stale) continue;
    ctx.delete(ref);
    // These are the trailers of xref-stream files: keep the newest /Info (title, author…) they point to.
    if (info instanceof PDFRef) infoRef = info;
  }
  if (encRef) ctx.delete(encRef);
  if (!ctx.trailerInfo.Info && infoRef && ctx.lookup(infoRef) instanceof PDFDict) ctx.trailerInfo.Info = infoRef;
}

/** True when the PDF really is encrypted (needs a password or carries permission restrictions). */
export async function isEncryptedPdf(bytes) {
  if (!looksEncrypted(bytes)) return false;
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch (err) {
    if (err instanceof EncryptedPDFError) return true;
    throw err;
  }
}

/**
 * Read a PDF file and return plain (unencrypted) bytes. Encrypted files are unlocked here once,
 * asking for the password when one is needed, so every tool can treat them like normal PDFs.
 * Resolves to null if the user cancels the password prompt.
 */
export async function readPdfFile(file) {
  const bytes = await readFile(file);
  if (!looksEncrypted(bytes)) return bytes;
  let password = ''; // many "secured" PDFs only restrict permissions and open without a password
  let wrong = false;
  for (;;) {
    try {
      const doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
      // not actually encrypted (e.g. the text "/Encrypt" merely appears in the file): keep it untouched
      if (!doc.context.isDecrypted) return bytes;
      stripEncryption(doc);
      return await doc.save({ useObjectStreams: true });
    } catch (err) {
      if (!/password/i.test(String(err?.message))) throw err;
      password = await promptPassword(file.name, wrong);
      if (password == null) return null;
      wrong = true;
    }
  }
}

/** Open a document with pdf.js for rendering. Bytes are copied because pdf.js transfers them to its worker. */
export async function openForRender(bytes) {
  return pdfjsLib.getDocument({ ...RENDER_OPTIONS, data: bytes.slice() }).promise;
}

/** Open a document with pdf-lib for modification. */
export async function openForEdit(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function saveDoc(doc) {
  return doc.save({ useObjectStreams: true });
}

/**
 * Paint annotation appearances, including filled-in form fields, into the canvas. This is the pdf.js
 * default today, but ENABLE_FORMS (forms left to an HTML layer we don't have) would silently drop
 * form values from previews and from every export that rasterizes pages, so it is pinned here.
 */
export const ANNOTATION_MODE = pdfjsLib.AnnotationMode.ENABLE;

/** Lower `scale` for huge pages so the canvas stays within browser limits. */
export function safeScale(page, scale) {
  const vp = page.getViewport({ scale });
  return scale * Math.min(1, 14000 / Math.max(vp.width, vp.height), Math.sqrt(50e6 / (vp.width * vp.height)));
}

/** Render a page into a new canvas. `scale` is relative to 72 dpi (reduced if the canvas would be too big). */
export async function renderPage(pdf, pageNumber, scale, { rotation = 0, background = 'white' } = {}) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: safeScale(page, scale), rotation: (page.rotate + rotation) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background, annotationMode: ANNOTATION_MODE }).promise;
  return { canvas, viewport, page };
}

/** Render a page thumbnail that fits within `maxSize` css px (rendered at device pixel ratio). */
export async function renderThumb(pdf, pageNumber, maxSize = 180) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = (maxSize / Math.max(base.width, base.height)) * Math.min(2, window.devicePixelRatio || 1);
  const { canvas } = await renderPage(pdf, pageNumber, scale);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  );
}

export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
