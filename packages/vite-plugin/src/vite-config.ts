import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  return {
    resolve: { dedupe: ['three', '@pix3/runtime'] },
    optimizeDeps: {
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
