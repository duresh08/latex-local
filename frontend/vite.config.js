import { defineConfig } from 'vite';

// The built UI is committed to latexlab/static so end users never need Node.js.
export default defineConfig({
  base: '/',
  build: {
    outDir: '../latexlab/static',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
