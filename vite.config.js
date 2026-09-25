import { defineConfig } from 'vite';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// pdf.js loads these at runtime by file name: CMaps (CJK and other non-embedded fonts), standard
// font data (non-embedded Helvetica/Times/…), ICC profile (CMYK colours) and wasm image decoders
// (JPEG 2000, JBIG2). Without them such text renders blank or in the wrong font, and images go missing.
const PDFJS_DIR = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'iccs', 'wasm'];
const MIME = { wasm: 'application/wasm', js: 'text/javascript', icc: 'application/vnd.iccprofile' };

function pdfjsAssetFiles() {
  return PDFJS_ASSET_DIRS.flatMap((dir) =>
    readdirSync(PDFJS_DIR + dir)
      .filter((f) => !f.startsWith('quickjs')) // the scripting sandbox is not used
      .map((f) => `${dir}/${f}`),
  );
}

/** Serves pdf.js runtime assets at /pdfjs/ in dev and copies them to dist/pdfjs/ on build. */
function pdfjsAssets() {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      const files = new Set(pdfjsAssetFiles());
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        if (!files.has(rel)) return next();
        res.setHeader('Content-Type', MIME[rel.split('.').pop()] || 'application/octet-stream');
        createReadStream(PDFJS_DIR + rel).pipe(res);
      });
    },
    generateBundle() {
      for (const rel of pdfjsAssetFiles()) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${rel}`, source: readFileSync(PDFJS_DIR + rel) });
      }
    },
  };
}

// base: './' makes the build work from any sub-path (GitHub Pages, S3, etc.)
export default defineConfig({
  base: './',
  plugins: [pdfjsAssets()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
