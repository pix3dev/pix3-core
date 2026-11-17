import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

import type { ProjectFiles } from '../validate/project.ts';

/**
 * The two scripts `pix3 render` loads into its page:
 *
 * - the **host** — `page-host.ts` with the runtime of this CLI and three.js, one IIFE that sets
 *   `window.__PIX3_RENDER_HOST__`. Published package: prebuilt into `dist/render/prebuilt/` at
 *   `prepack` (`scripts/build-render.mjs`); a repo checkout builds it into a temp folder;
 * - the project's **scripts** — compiled at run time with `@pix3/runtime` and `three` taken from
 *   the host (one runtime in the page, or `instanceof Script` fails), into an IIFE that sets
 *   `window.__PIX3_RENDER_SCRIPTS__` (file → exports) for the host to register as `user:*`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

export const RENDER_HOST_FILE = 'render-host.js';

/** One three.js: every `three` import resolves from this package, whoever imports it. */
const dedupeThree = (): Plugin => ({
  name: 'pix3-render-dedupe-three',
  setup(build) {
    build.onResolve({ filter: /^three(\/.*)?$/ }, async args => {
      if (args.pluginData === 'pix3-render') return undefined;
      const result = await build.resolve(args.path, {
        kind: args.kind,
        resolveDir: packageRoot,
        pluginData: 'pix3-render',
      });
      return result.errors.length > 0 ? undefined : { path: result.path };
    });
  },
});

export const buildRenderBundle = async (
  outdir: string,
  options: { readonly minify?: boolean } = {}
): Promise<void> => {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [join(here, 'page-host.ts')],
    outfile: join(outdir, RENDER_HOST_FILE),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: options.minify === true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [dedupeThree()],
  });
};

export const readRenderHost = (bundleDir: string): string =>
  readFileSync(join(bundleDir, RENDER_HOST_FILE), 'utf8');

/** `@pix3/runtime` / `three` for project scripts: the host's copies. */
const HOST_MODULES: Record<string, string> = {
  '@pix3/runtime': 'module.exports = window.__PIX3_RENDER_HOST__.runtime;',
  three: 'module.exports = window.__PIX3_RENDER_HOST__.three;',
};

/**
 * Compile the project's script entries for the page. A bare import other than the runtime and
 * three is bundled from the project's `node_modules` (three addons included, their own `three`
 * import going to the host's); what resolves nowhere becomes an empty module and is reported.
 */
export const compileRenderScripts = async (
  esbuildSpecifier: string,
  project: ProjectFiles,
  entries: readonly string[]
): Promise<{ code: string; stubbed: string[] }> => {
  if (entries.length === 0) return { code: '', stubbed: [] };
  const esbuild = (await import(esbuildSpecifier)) as typeof import('esbuild');
  const stubbed = new Set<string>();
  const result = await esbuild.build({
    stdin: {
      contents: entries
        .map((file, i) => `export * as __pix3_entry_${i} from ${JSON.stringify(`./${file}`)};`)
        .join('\n'),
      resolveDir: project.root,
      sourcefile: 'pix3-render-scripts.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    target: 'es2022',
    logLevel: 'silent',
    loader: { '.glsl': 'text', '.vert': 'text', '.frag': 'text', '.css': 'empty' },
    define: {
      'import.meta.env.BASE_URL': JSON.stringify('/'),
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': JSON.stringify('production'),
    },
    format: 'iife',
    globalName: '__PIX3_RENDER_SCRIPTS_RAW__',
    platform: 'browser',
    absWorkingDir: project.root,
    plugins: [
      {
        name: 'pix3-render-imports',
        setup(build) {
          build.onResolve({ filter: /^(@pix3\/runtime|three)$/ }, args => ({
            path: args.path,
            namespace: 'pix3-render-host',
          }));
          build.onLoad({ filter: /.*/, namespace: 'pix3-render-host' }, args => ({
            contents: HOST_MODULES[args.path],
            loader: 'js',
          }));
          build.onResolve({ filter: /^[^./]/ }, async args => {
            if (args.kind === 'entry-point' || args.pluginData === 'pix3-render') return undefined;
            const resolved = await build.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              pluginData: 'pix3-render',
            });
            if (resolved.errors.length === 0 && resolved.path) return { path: resolved.path };
            stubbed.add(args.path);
            return { path: args.path, namespace: 'pix3-render-stub' };
          });
          build.onLoad({ filter: /.*/, namespace: 'pix3-render-stub' }, () => ({
            contents: 'module.exports = {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const raw = result.outputFiles?.[0]?.text ?? '';
  const map = entries
    .map(
      (file, index) => `${JSON.stringify(file)}: __PIX3_RENDER_SCRIPTS_RAW__.__pix3_entry_${index}`
    )
    .join(',\n');
  return {
    code: `${raw}\nwindow.__PIX3_RENDER_SCRIPTS__ = {${map}};\n`,
    stubbed: [...stubbed].sort(),
  };
};
