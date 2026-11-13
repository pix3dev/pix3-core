import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { searchForWorkspaceRoot, type UserConfig } from 'vite';

import { findPackageDir } from './dev-info.ts';

/** `dist/optimize-deps.json` of the installed editor, or nothing. */
const editorOptimizeDeps = (editorCoreDir: string | null): string[] => {
  if (!editorCoreDir) return [];
  try {
    const list = JSON.parse(
      readFileSync(join(editorCoreDir, 'dist', 'optimize-deps.json'), 'utf8')
    ) as unknown;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const newestMtimeMs = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(path) : statSync(path).mtimeMs);
  }
  return newest;
};

/**
 * Whether the prebundled runtime is older than the runtime's sources. Only a **linked** runtime
 * (`file:../pix3-core/packages/runtime`, a workspace) can be: Vite keys its dependency cache on
 * the lockfile and the config, neither of which changes when a linked checkout is edited, so the
 * dev server went on serving `node_modules/.vite/deps/@pix3_runtime.js` from days before (Skyways,
 * 2026-11-13: an engine fix invisible after every reload). An installed copy never is.
 */
export const linkedRuntimeOutdatesCache = (
  runtimeDir: string | null,
  cacheDir: string
): boolean => {
  if (!runtimeDir) return false;
  try {
    const real = realpathSync.native(runtimeDir);
    if (real.split(sep).includes('node_modules')) return false;
    const cached = statSync(join(cacheDir, 'deps', '_metadata.json')).mtimeMs;
    return newestMtimeMs(join(real, 'src')) > cached;
  } catch {
    // No cache yet (Vite builds it anyway) or no `src/`: nothing to force.
    return false;
  }
};

/** The plugin's `config` hook: what it adds to the user's Vite config. */
export const pix3ViteConfig = (options: {
  readonly user: UserConfig;
  /** This package's directory (the page client and the player are served from it). */
  readonly packageDir: string;
  /** The playable build this command makes, or false (dev, `build: false`). */
  readonly format: 'html' | 'zip' | false;
  readonly compress: boolean;
  /** Vite 8 bundles with rolldown (`this.meta.rolldownVersion`), Vite 7 with rollup. */
  readonly rolldown: boolean;
}): UserConfig => {
  const { user, format } = options;
  const projectRoot = resolve(user.root ?? process.cwd());
  const linkedEditorCore = findPackageDir(projectRoot, '@pix3/editor-core');
  // Vite checks `fs.allow` against real paths (`.native`: long names on Windows, as Vite resolves
  // them); a workspace or pnpm link points elsewhere.
  const editorCoreDir = linkedEditorCore ? realpathSync.native(linkedEditorCore) : null;
  // An explicit `fs.allow` switches off Vite's workspace-root default; keep it when the user
  // set none, and add this package (the page client and the player are served from it by
  // `/@fs/`) and the prebuilt editor (served from wherever npm put it: hoisted, pnpm, a
  // workspace link).
  const own = [options.packageDir, ...(editorCoreDir ? [editorCoreDir] : [])];
  const allow = user.server?.fs?.allow ? own : [searchForWorkspaceRoot(projectRoot), ...own];
  // rolldown's output option is `codeSplitting`; rollup spells the same `inlineDynamicImports`.
  const singleChunk = options.rolldown ? { codeSplitting: false } : { inlineDynamicImports: true };
  // A compressed build is injected as script text: `iife`, so it declares nothing global.
  const outputFormat = options.compress && format === 'html' ? { format: 'iife' as const } : {};
  const staleRuntime =
    !format &&
    linkedRuntimeOutdatesCache(
      findPackageDir(projectRoot, '@pix3/runtime'),
      resolve(projectRoot, user.cacheDir ?? 'node_modules/.vite')
    );
  return {
    resolve: { dedupe: ['three', '@pix3/runtime'] },
    optimizeDeps: {
      // A linked runtime edited since the last prebundle: rebuild the cache on this start.
      ...(staleRuntime ? { force: true } : {}),
      // One runtime and one three for the game and the editor (plan §B.2, S1), plus the bare
      // subpaths the prebuilt editor imports (`dist/optimize-deps.json`).
      include: ['@pix3/runtime', 'three', ...editorOptimizeDeps(editorCoreDir)],
      // The installed player imports virtual modules resolved by this plugin's Vite hooks;
      // the dependency optimizer cannot resolve them while prebundling node_modules.
      exclude: ['@pix3/editor-core', '@pix3/vite-plugin/player'],
    },
    server: { fs: { allow } },
    ...(format
      ? {
          // Relative URLs: the artifact runs from `file://`, a subfolder or a sandboxed frame.
          base: './',
          build:
            format === 'html'
              ? {
                  // Everything inlined (the single-file plugin's recommended config, set here
                  // so the chunking flag follows the bundler, not Vite's version string).
                  assetsInlineLimit: () => true,
                  chunkSizeWarningLimit: 100_000_000,
                  cssCodeSplit: false,
                  assetsDir: '',
                  modulePreload: false,
                  rollupOptions: { output: { ...singleChunk, ...outputFormat } },
                }
              : {},
        }
      : {}),
  };
};
