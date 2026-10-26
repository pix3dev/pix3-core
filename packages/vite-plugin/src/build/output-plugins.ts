import type { Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { isUnder, realFileOf } from '../module-paths.ts';
import { resolvedId } from '../sync/script-graph.ts';
import { toClassicScriptHtml } from './classic-script.ts';
import { toCompressedHtml } from './compress.ts';
import type { BuildState } from './plan.ts';
import {
  GLTF_LOADER_SPECIFIER,
  GLTF_LOADER_STUB_ID,
  POSTPROCESSING_STUB_ID,
  YAML_STUB_ID,
} from './player-modules.ts';

/**
 * The optional libraries a build leaves out (CLAUDE.md «Playable export size»), part of the
 * strip (`strip: false` keeps them all). `enforce: 'pre'`, because Vite's own resolver runs
 * before a normal plugin's `resolveId`. Every one is stubbed **for the runtime's own importers
 * only** (real paths compared): a project script or a dependency that imports the library
 * itself always gets the real one — and the scan counts that import as a use, so the runtime
 * shares the real copy then too.
 *
 * - `postprocessing` in a single-file build with no PostProcess node and no import of it — the
 *   runtime's `import('postprocessing')` would be inlined whole;
 * - `yaml` — the scenes ship as JSON (`shippedBytes`), so `SceneLoader`'s `parse` is
 *   `JSON.parse` (plan §B.6 item 4, done the 1.x way: no runtime change, no second format);
 * - `GLTFLoader` when no scene, script, library or asset names a model.
 */
export const libraryStubsPlugin = (getBuild: () => BuildState | null): Plugin => ({
  name: 'pix3:library-stubs',
  apply: 'build',
  enforce: 'pre',
  resolveId(id, importer) {
    const build = getBuild();
    if (!build?.stripEnabled || !importer || importer.startsWith('\0')) return null;
    if (id !== 'postprocessing' && id !== 'yaml' && id !== GLTF_LOADER_SPECIFIER) return null;
    if (!isUnder(realFileOf(importer), build.runtimeSrc)) return null;
    if (id === 'postprocessing' && build.format === 'html' && !build.scan.usesPostProcessing) {
      build.applied.postprocessing = true;
      return resolvedId(POSTPROCESSING_STUB_ID);
    }
    if (id === 'yaml' && build.stubYaml) {
      build.applied.yaml = true;
      return resolvedId(YAML_STUB_ID);
    }
    if (id === GLTF_LOADER_SPECIFIER && build.stubGltf) {
      build.applied.gltf = true;
      return resolvedId(GLTF_LOADER_STUB_ID);
    }
    return null;
  },
});

/**
 * `build: 'html'` (only then are these in the plugin list): inline every chunk and stylesheet into `index.html` (plan §B.6 item 5), then
 * make that one script classic, at the end of `<body>` (DeepCore's compatibility plugin), and
 * with `compress` replace it by the gzip payload and its bootstrap (`build/compress.ts`).
 */
export const singleFilePlugins = (options: {
  readonly compress: boolean;
  readonly getBuild: () => BuildState | null;
}): Plugin[] => {
  const singleFile: Plugin = {
    ...(viteSingleFile({
      useRecommendedBuildConfig: false,
      // `modulePreload: false` (vite-config.ts) means there is no preload polyfill to remove — and
      // the removal's regex takes the first IIFE it sees for that polyfill, which in a compressed
      // (`iife`) build is the head of the bundle itself.
      removeViteModuleLoader: false,
    }) as Plugin),
    name: 'pix3:single-file',
    apply: 'build',
  };
  const classicScript: Plugin = {
    name: 'pix3:classic-script',
    apply: 'build',
    enforce: 'post',
    // `order: 'post'` like vite-plugin-singlefile's own hook, and listed after it: a plain hook
    // ran BEFORE singlefile inlined the chunk, so the `import.meta` rewrite never saw the code
    // (a classic script that cannot parse: a black page) and `compress` found no inline bundle.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'asset' || !output.fileName.endsWith('.html')) continue;
          const html =
            typeof output.source === 'string'
              ? output.source
              : Buffer.from(output.source).toString('utf8');
          const classic = toClassicScriptHtml(html);
          const build = options.compress ? options.getBuild() : null;
          if (!build) {
            output.source = classic;
            continue;
          }
          build.compressed = toCompressedHtml(classic);
          output.source = build.compressed.html;
        }
      },
    },
  };
  return [singleFile, classicScript];
};
