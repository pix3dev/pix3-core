import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

/**
 * The scripts `pix3 play` evaluates in the game's page:
 *
 * - the **test host** for a built page — editor-core's `src/services/game-test/page-test-host.ts`
 *   (what `pix3_game_run` does, plus the realtime `--bot` run), as one IIFE that sets
 *   `window.__PIX3_PAGE_TEST_HOST__`. A dev page imports the same host itself, prebuilt by
 *   editor-core (`__PIX3_PLAYER__.loadTools()`), so this one is only for pages without it.
 *   Published package: prebuilt into `dist/play/prebuilt/page-test-host.js` at `prepack`
 *   (`scripts/build-play.mjs`); a repo checkout builds it into a temp folder from the sources;
 * - the **debug** script (`--profile`, `--tree`, `--screens`) — `FrameProfile`, `liveTree` and the
 *   gallery's screen checks from the player's debug sources
 *   (`packages/vite-plugin/player/debug/profile.ts`, `tree.ts`, `screen-checks.ts`), one IIFE that sets
 *   `window.__PIX3_PAGE_DEBUG_HOST__`; built beside the host, so a built page is profiled and its
 *   tree read without the player shipping any of it;
 * - the **policy** for a built page — the project's `design/tests/bots/<name>.ts`, compiled at run
 *   time with the project's esbuild into an IIFE that sets `window.__PIX3_BOT_POLICY__`.
 *
 * None carries `@pix3/runtime`: the page already runs one, and a second copy would make every
 * `instanceof NodeBase` false. They get a shim instead: a `NodeBase` that recognises the page's
 * nodes by shape, and — for the host — the few runtime values it calls (`HOST_RUNTIME_SHIM`).
 * `three` is bundled into the host as a second copy: it does vector math there, nothing renders.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const PAGE_TEST_HOST_FILE = 'page-test-host.js';
export const PAGE_DEBUG_FILE = 'page-debug.js';

/** `@pix3/runtime` for code that runs beside the page's own runtime. */
const RUNTIME_SHIM = `export class NodeBase {
  static [Symbol.hasInstance](value) {
    return !!value && typeof value.nodeId === 'string' && Array.isArray(value.components);
  }
}
`;

const RUNTIME_SRC = resolve(here, '..', '..', '..', 'runtime', 'src');

/**
 * `@pix3/runtime` for the test host: the shape `NodeBase` and every other value the host imports.
 * `game-debug.ts` is the runtime's own (its state lives on `globalThis`, so the page's game and the
 * host meet there), as is the renderability lint (its `NodeBase` redirected to the shape one); the
 * rest is two lines each. A new runtime value import in the host fails the build here.
 */
const HOST_RUNTIME_SHIM = `export { NodeBase } from './nodes/NodeBase';
export * from './core/game-debug';
export { collectRenderabilityIssues } from './core/renderability-lint';
export const DEFAULT_FIXED_DELTA_SEC = 1 / 60;
export function isInteractive(value) {
  return typeof value === 'object' && value !== null &&
    typeof value.getInteractions === 'function' && typeof value.invokeInteraction === 'function';
}
`;

const runtimeShim = (host = false): Plugin => ({
  name: 'pix3-play-runtime-shim',
  setup(build) {
    build.onResolve({ filter: /^@pix3\/runtime$/ }, () => ({
      path: host ? 'host-runtime-shim' : 'runtime-shim',
      namespace: 'pix3-play',
    }));
    // The runtime's own modules the host shim re-exports reach `NodeBase` by a relative path.
    build.onResolve({ filter: /\/nodes\/NodeBase$/ }, () => ({
      path: 'runtime-shim',
      namespace: 'pix3-play',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pix3-play' }, args =>
      args.path === 'host-runtime-shim'
        ? { contents: HOST_RUNTIME_SHIM, loader: 'js', resolveDir: RUNTIME_SRC }
        : { contents: RUNTIME_SHIM, loader: 'js' }
    );
  },
});

/** Build the host and debug IIFEs into `outdir` (from the sources of this checkout). */
export const buildPlayBundle = async (
  outdir: string,
  options: { readonly minify?: boolean } = {}
): Promise<void> => {
  const esbuild = await import('esbuild');
  const editorCoreSrc = resolve(here, '..', '..', '..', 'editor-core', 'src');
  await esbuild.build({
    stdin: {
      contents:
        "import { installPageTools } from '@/services/game-test/page-test-host';\n" +
        'window.__PIX3_PAGE_TEST_HOST__ = { installPageTools };\n',
      resolveDir: editorCoreSrc,
      sourcefile: 'page-test-host-entry.ts',
      loader: 'ts',
    },
    outfile: join(outdir, PAGE_TEST_HOST_FILE),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias: { '@': editorCoreSrc },
    minify: options.minify === true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [runtimeShim(true)],
  });
  const playerDebugSrc = resolve(here, '..', '..', '..', 'vite-plugin', 'player', 'debug');
  await esbuild.build({
    stdin: {
      contents:
        "import { startPageProfile } from './profile';\n" +
        "import { liveTree } from './tree';\n" +
        "import { hideCaptions, measureScreen } from './screen-checks';\n" +
        'window.__PIX3_PAGE_DEBUG_HOST__ = { startPageProfile, liveTree, measureScreen, hideCaptions };\n',
      resolveDir: playerDebugSrc,
      sourcefile: 'page-debug-entry.ts',
      loader: 'ts',
    },
    outfile: join(outdir, PAGE_DEBUG_FILE),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: options.minify === true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [runtimeShim()],
  });
};

/** The test host script's text from a bundle folder. */
export const readPlayHost = (bundleDir: string): string =>
  readFileSync(join(bundleDir, PAGE_TEST_HOST_FILE), 'utf8');

/** The debug script's text from a bundle folder. */
export const readPlayDebug = (bundleDir: string): string =>
  readFileSync(join(bundleDir, PAGE_DEBUG_FILE), 'utf8');

/** Compile a policy file to an IIFE that sets `window.__PIX3_BOT_POLICY__`. */
export const compilePolicy = async (esbuildSpecifier: string, file: string): Promise<string> => {
  const esbuild = (await import(esbuildSpecifier)) as typeof import('esbuild');
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__PIX3_BOT_POLICY__',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [runtimeShim()],
  });
  return result.outputFiles[0]?.text ?? '';
};
