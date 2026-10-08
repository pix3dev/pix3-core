import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // happy-dom fetches an iframe's `src` for real the moment one is attached; nothing under test
    // wants a loaded frame, so child-frame navigation is off for every spec.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
    // Repairs the ambient `localStorage` when Node hands us an unusable one (see the file).
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/runtime/src/**/*.spec.ts',
      // CLI specs are Node (`// @vitest-environment node` per file).
      'packages/cli/src/**/*.spec.ts',
      'packages/create-pix3/templates/*.spec.ts',
      // packages/editor-core joins once the port makes it compile (plan §G.2).
    ],
    // The default 'forks' pool reports "No test suite found" for every spec on win32-arm64
    // (vitest 4.x); threads run them fine everywhere. Four workers: the run is import-bound, and
    // one per core exhausts memory on high-core machines.
    pool: 'threads',
    maxWorkers: 4,
  },
  resolve: {
    // One three.js: `packages/runtime` lists it as both peer and dev dependency, and a nested copy
    // breaks `instanceof` across the seam.
    dedupe: ['three'],
    alias: {
      '@pix3/runtime': resolve(import.meta.dirname, 'packages/runtime/src'),
      // editor-core's own alias, for the few editor modules template specs load (`parseRoutine`).
      '@': resolve(import.meta.dirname, 'packages/editor-core/src'),
    },
  },
});
