# PDF Tools

A fast, free, privacy-first PDF toolkit in the style of iLovePDF, but **entirely client-side**. Every operation runs in your browser; files are never uploaded anywhere.

Built with [Vite](https://vite.dev), vanilla JavaScript, [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (a maintained pdf-lib fork with encryption support), [pdf.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist` v6) and [JSZip](https://stuk.github.io/jszip/).

## Features

| Tool | What it does |
| --- | --- |
| Merge PDF | Combine several PDFs into one, in any order |
| Split PDF | Split by custom ranges, fixed-size chunks or single pages (ZIP for multiple files) |
| Organize PDF | Reorder, rotate and delete pages visually |
| Remove pages | Delete selected pages |
| Extract pages | Copy selected pages into a new PDF |
| Compress PDF | Reduce file size (Lossless / Recommended / Extreme) |
| Edit PDF | Edit existing text, add text, images, shapes, whiteout, highlights and freehand drawing, with undo and zoom |
| Sign PDF | Draw, type (signature fonts) or upload a signature and place it |
| Rotate PDF | Rotate all or selected pages |
| JPG to PDF | Convert images into a PDF |
| PDF to JPG | Render pages to JPG images (ZIP for multiple pages) |
| Watermark | Stamp a single or tiled text watermark with font, colour, opacity and angle |
| Page numbers | Add page numbers with position and format options |
| Protect PDF | Encrypt with a password (AES-256) and restrict printing, copying and editing |
| Unlock PDF | Remove the password and restrictions from a PDF you know the password for |

Password-protected PDFs can be opened in every tool: you are asked for the password and the file is decrypted locally.

Routing is hash-based (`#/merge`, `#/split`, ...), so the app works on any static host without server rewrites.

## Privacy model

- All PDF parsing, rendering and writing happens locally, in the browser tab (pdf.js runs in a Web Worker).
- No backend, no uploads, no analytics, no cookies.
- The only external requests are for **Google Fonts** (Inter, the signature fonts, and Arimo / Tinos / Cousine — metric-compatible stand-ins for the PDF standard fonts, downloaded only on devices without Arial / Times New Roman / Courier New), loaded from `index.html`. To be fully offline or third-party-free, self-host the fonts and remove the Google Fonts `<link>` tags (then drop the `fonts.googleapis.com` / `fonts.gstatic.com` entries from the CSP).
- The shipped Content-Security-Policy (see below) blocks connections to any other origin.

## Running locally

Requirements: Node.js 20 or later.

```bash
npm install
npm run dev        # dev server with hot reload at http://localhost:5173
```

## Building

```bash
npm run build      # outputs static files to dist/
npm run preview    # serve dist/ locally to check the production build
```

`vite.config.js` uses `base: './'`, so the build uses relative asset paths and works from the domain root **or any sub-path** (for example `https://user.github.io/pdf-tools/`). The output is plain static files: `index.html`, `assets/*.js`, `assets/*.css`, the pdf.js worker `assets/pdf.worker.min-*.mjs`, and `pdfjs/` — the pdf.js runtime data (CMaps for CJK and other non-embedded fonts, standard font data, an ICC profile for CMYK colours and the JPEG 2000 / JBIG2 wasm decoders). A small plugin in `vite.config.js` copies `pdfjs/` from `node_modules/pdfjs-dist` on build and serves it in dev; deploy it along with everything else or such PDFs render with blank text or missing images.

## Deployment

### Netlify

`netlify.toml` is included (build command `npm run build`, publish dir `dist`, Node 20). Connect the repository in Netlify, or deploy manually:

```bash
npm run build
npx netlify-cli deploy --prod --dir=dist
```

Security headers are applied from `public/_headers` (copied into `dist/`).

### Vercel

`vercel.json` is included (Vite framework preset, output `dist`, security headers). Import the repository in Vercel, or:

```bash
npx vercel --prod
```

### GitHub Pages

`.github/workflows/deploy.yml` builds on every push to `main` and publishes with `actions/deploy-pages`.

1. Push the repository to GitHub.
2. In **Settings > Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually). The site is served at `https://<user>.github.io/<repo>/`; the relative `base` makes the sub-path work without changes.

Note: GitHub Pages cannot set custom HTTP headers, so the CSP in `_headers` is not applied there.

### Cloudflare Pages

Create a Pages project from the repository with:

- Build command: `npm run build`
- Build output directory: `dist`
- Environment variable: `NODE_VERSION=20`

Or deploy directly: `npx wrangler pages deploy dist`. Cloudflare Pages reads `dist/_headers` automatically.

### Any other static host (S3, Nginx, Apache, Firebase Hosting, ...)

Upload the contents of `dist/`. Make sure the server:

- serves `.mjs` files as JavaScript (`text/javascript`); otherwise the pdf.js worker fails to load (older Nginx/Apache `mime.types` may lack `.mjs`),
- serves `.wasm` files (if present) as `application/wasm`,
- ideally sends the headers listed in `public/_headers`.

No rewrite rules are required because routing is hash-based.

## Security headers

`public/_headers` (Netlify / Cloudflare Pages) and `vercel.json` (Vercel) send the same policy:

- `Content-Security-Policy`: `default-src 'self'`; scripts from self (plus `'wasm-unsafe-eval'` for pdf.js image decoders and `blob:`); `worker-src 'self' blob:`; styles from self, inline and Google Fonts; fonts from self, `data:` and `fonts.gstatic.com`; images, media and fetches from self, `data:` and `blob:`; `object-src 'none'`; `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and `Cross-Origin-Opener-Policy: same-origin`.
- Long-lived immutable caching for hashed files under `/assets/`, and explicit content types for `.mjs` and `.wasm`.

If you add features that load resources from other origins, update both files.

## Known limitations

- **Editing existing text** covers the original line with its background colour and draws the replacement in the closest standard font (Helvetica / Times / Courier, keeping bold and italic), so the width may differ slightly from the original and anything directly behind the line (e.g. a grid line) is covered too. Rotated or vertical text lines can't be edited.
- **Compress "Recommended" and "Extreme" rasterize pages** into images. Output is much smaller, but text is no longer selectable or searchable. "Lossless" keeps the original content but usually saves little.
- **Non-Latin text** (e.g. Devanagari, CJK, Arabic) added in Edit, Watermark or Page numbers is drawn as an image, because the standard PDF fonts only cover Latin characters. Only those parts of a line become images; Latin words on the same line stay real, selectable text (right-to-left lines are kept as one image to preserve their order).
- Very large files are limited by the browser's memory, since everything is processed in the tab.
