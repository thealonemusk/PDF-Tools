import { defineConfig } from 'vite';

// base: './' makes the build work from any sub-path (GitHub Pages, S3, etc.)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
