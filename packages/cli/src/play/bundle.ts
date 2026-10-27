import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

/**
 * The two scripts `pix3 play --bot` evaluates in the game's page:
 *
 * - the **host** — `BotSession` and the page world from editor-core
 *   (`src/services/game-test/page-bot-host.ts`), as one IIFE that sets
 *   `window.__PIX3_PAGE_BOT_HOST__`. Published package: prebuilt into
 *   `dist/play/prebuilt/page-bot-host.js` at `prepack` (`scripts/build-play.mjs`); a repo checkout
 *   builds it into a temp folder from the editor-core sources;
 * - the **policy** — the project's `design/tests/bots/<name>.ts`, compiled at run time with the
 *   project's esbuild into an IIFE that sets `window.__PIX3_BOT_POLICY__`.
 *
 * Neither carries `@pix3/runtime`: the page already runs one, and a second copy would make every
 * `instanceof NodeBase` false. Both get a shim whose `NodeBase` recognises the page's nodes by
 * shape — the only runtime value the bot world needs.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const PAGE_BOT_HOST_FILE = 'page-bot-host.js';

/** `@pix3/runtime` for code that runs beside the page's own runtime. */
const RUNTIME_SHIM = `export class NodeBase {
  static [Symbol.hasInstance](value) {
    return !!value && typeof value.nodeId === 'string' && Array.isArray(value.components);
  }
}
`;

const runtimeShim = (): Plugin => ({
  name: 'pix3-play-runtime-shim',
  setup(build) {
    build.onResolve({ filter: /^@pix3\/runtime$/ }, () => ({
      path: 'runtime-shim',
      namespace: 'pix3-play',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pix3-play' }, () => ({
      contents: RUNTIME_SHIM,
      loader: 'js',
    }));
  },
});

/** Build the host IIFE into `outdir` (from the editor-core sources of this checkout). */
export const buildPlayBundle = async (
  outdir: string,
  options: { readonly minify?: boolean } = {}
): Promise<void> => {
  const esbuild = await import('esbuild');
  const editorCoreSrc = resolve(here, '..', '..', '..', 'editor-core', 'src');
  await esbuild.build({
    stdin: {
      contents:
        "import { startPageBot } from '@/services/game-test/page-bot-host';\n" +
        'window.__PIX3_PAGE_BOT_HOST__ = { startPageBot };\n',
      resolveDir: editorCoreSrc,
      sourcefile: 'page-bot-host-entry.ts',
      loader: 'ts',
    },
    outfile: join(outdir, PAGE_BOT_HOST_FILE),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias: { '@': editorCoreSrc },
    minify: options.minify === true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [runtimeShim()],
  });
};

/** The host script's text from a bundle folder. */
export const readPlayHost = (bundleDir: string): string =>
  readFileSync(join(bundleDir, PAGE_BOT_HOST_FILE), 'utf8');

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
