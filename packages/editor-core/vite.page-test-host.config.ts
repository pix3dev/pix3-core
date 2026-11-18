import { resolve } from 'node:path';

import { defineConfig } from 'vite';

/**
 * `dist/page-test-host.js` (plan play-in-page S3, D10): the test host the game's dev page imports
 * by file path (`virtual:pix3/dev`), one self-contained ES module beside the editor's bundle.
 * `@pix3/runtime` and `three` stay external, so Vite hands it the page's own pre-bundled copies
 * and `instanceof` holds; everything else it needs is inlined. `check-dist` proves it reaches no
 * editor service.
 */
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
    dedupe: ['three'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/services/game-test/page-test-host.ts'),
      formats: ['es'],
      fileName: () => 'page-test-host.js',
    },
    rollupOptions: {
      external: id => /^@pix3\/runtime(\/|$)/.test(id) || /^three(\/|$)/.test(id),
      output: { inlineDynamicImports: true },
    },
  },
});
