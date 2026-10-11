import { withCommandBundle } from '../package-root.ts';

/**
 * Where the smoke bundle (`bundle.ts`) lives, as `index.ts` reaches it — free of runtime imports,
 * so the other commands never load it and `node src/index.ts` can import this file as-is.
 *
 * - published package: `dist/smoke/prebuilt/`, built at `prepack` (`scripts/build-smoke.mjs`);
 * - repo checkout (running the `.ts` sources): the prebuilt bundle is never used, even when a
 *   `dist/` from an earlier build exists (`package-root.ts`); it is built into a temp folder first
 *   (well under a second, needs the repo's `esbuild`), which keeps runtime edits live.
 */

export const SMOKE_WORKER_FILE = 'smoke-worker.mjs';
export const TREE_DEFAULTS_FILE = 'tree-defaults.mjs';

/** Run `fn` with the folder holding the smoke bundle (a temp build is removed afterwards). */
export const withSmokeBundle = <T>(fn: (bundleDir: string) => Promise<T>): Promise<T> =>
  withCommandBundle(
    'smoke',
    SMOKE_WORKER_FILE,
    async outdir => (await import('./bundle.ts')).buildSmokeBundle(outdir),
    fn
  );
