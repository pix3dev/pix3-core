import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePath,
  version as viteVersion,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite';

import { emitZipAssets, recordModuleSizes, strippedImportError } from './build/bundle-hooks.ts';
import { devSceneManifestSource } from './build/dev-manifest.ts';
import { finishBuild } from './build/finish.ts';
import { libraryStubsPlugin, singleFilePlugins } from './build/output-plugins.ts';
import {
  flushEditor,
  planBuild,
  runtimeModulePath,
  shippedBytes,
  type BuildState,
} from './build/plan.ts';
import {
  EMBEDDED_ASSETS_ID,
  embeddedAssetsSource,
  GLTF_LOADER_STUB_ID,
  gltfLoaderStubSource,
  NETWORK_ID,
  networkSource,
  noEmbeddedAssetsSource,
  PLAYER_VIRTUAL_IDS,
  POSTPROCESSING_ID,
  POSTPROCESSING_STUB_ID,
  postprocessingSource,
  postprocessingStubSource,
  PROJECT_SCRIPTS_ID,
  projectScriptsSource,
  SCENE_MANIFEST_ID,
  sceneManifestSource,
  SPINE_ID,
  spineSource,
  YAML_STUB_ID,
  yamlStubSource,
} from './build/player-modules.ts';
import { normalizeResRoot } from './build/project-manifest.ts';
import type { StripOption } from './build/strip-decision.ts';
import { buildStrippedModuleSource } from './build/strippable-runtime-modules.ts';
import { installedVersion, pluginVersion } from './dev-info.ts';
import { startEditorServer, type EditorServer } from './dev-server.ts';
import { EDITOR_HOST_ID, editorHostSource, SPINE_LOADER_ID } from './editor-page.ts';
import { fileOf } from './module-paths.ts';
import { scriptHotUpdate } from './sync/hot-update.ts';
import {
  BOT_POLICIES_ID,
  EDITOR_SCRIPTS_ID,
  resolvedId,
  rootModuleSource,
  ScriptGraph,
} from './sync/script-graph.ts';
import { pix3ViteConfig } from './vite-config.ts';

/**
 * `@pix3/vite-plugin`: the editor at `/__pix3/` with the file API and the sync barrier
 * (`dev-server.ts`), the scripts' hot path (`sync/`), the player's `virtual:pix3/*` modules and
 * the playable build (`build/`). This file wires the hooks; each concern lives in its module.
 */

export interface Pix3Options {
  /** Where `res://` points, relative to the Vite root (DeepCore: `'src/assets'`). */
  readonly resRoot?: string;
  /** Serve the editor and the file API at `/__pix3/` (default true). */
  readonly editor?: boolean;
  /**
   * Playable build format (plan §B.6): `'html'` (default) — one self-contained `dist/index.html`;
   * `'zip'` — `dist/<name>.zip` of the plain build with the assets beside it; `false` leaves
   * `vite build` alone.
   */
  readonly build?: 'html' | 'zip' | false;
  /**
   * `build: 'html'` only: ship the bundle gzip'd (`iife`, base64) behind a bootstrap that
   * inflates it with `DecompressionStream` and injects it as a classic script's text (plan §B.6
   * item 5). About two thirds off the file; a wash over a gzip channel, +21% over brotli
   * (CLAUDE.md «Playable export size»). Needs Chrome 80+ / Safari 16.4+ / Firefox 113+.
   */
  readonly compress?: boolean;
  /**
   * Replace runtime modules nothing in the project mentions with throwing stubs (and `yaml`,
   * `GLTFLoader`, `postprocessing` when unused). On by default; a dependency that declares
   * `@pix3/runtime` has its imports parsed (N11), and one the build cannot follow (`import * as`,
   * a dynamic import) turns strip off with a message. `{ keep: ['GeometryMesh', …] }` names
   * what such a dependency uses and keeps strip on; `false` strips nothing; `true` strips
   * regardless of what the dependencies import.
   */
  readonly strip?: StripOption;
  /** The scene a build boots into (`res://`-relative); default `defaultExportScenePath`. */
  readonly entryScene?: string;
  /** Answer `/__pix3/*` for non-loopback peers too (a dev server started with `--host`). */
  readonly allowRemote?: boolean;
  /**
   * The image-generation proxy (plan §B.1). `home` replaces `~/.pix3` as the place of
   * `keys.json` (default `PIX3_HOME`, else `~/.pix3`); `upstreams` replace the providers' API
   * origins (default `PIX3_PROXY_GEMINI_URL` / `PIX3_PROXY_OPENAI_URL`, else the real ones) — a
   * local mock in a test.
   */
  readonly imageGen?: {
    readonly home?: string;
    readonly upstreams?: { readonly gemini?: string; readonly openai?: string };
  };
}

/** Bare specifier of the player entry a project's `src/main.ts` imports. */
export const PLAYER_SPECIFIER = '@pix3/vite-plugin/player';

const VIRTUAL_IDS = new Set([
  EDITOR_HOST_ID,
  EDITOR_SCRIPTS_ID,
  BOT_POLICIES_ID,
  SPINE_LOADER_ID,
  ...PLAYER_VIRTUAL_IDS,
]);

/** Directory of this package (`src/` or `dist/` sits under it). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const FROM_SOURCE = import.meta.url.endsWith('.ts');
/** The page client, as source under vitest and as emitted JS from `dist/`. */
const CLIENT_ENTRY = fileURLToPath(
  new URL(`./client/index.${FROM_SOURCE ? 'ts' : 'js'}`, import.meta.url)
);
/** The player (`player/` beside `src/`; `dist/player/` once built). */
const PLAYER_ENTRY = fileURLToPath(
  new URL(FROM_SOURCE ? '../player/index.ts' : './player/index.js', import.meta.url)
);

export function pix3(options: Pix3Options = {}): Plugin[] {
  const settings = {
    resRoot: normalizeResRoot(options.resRoot ?? '.'),
    editor: options.editor ?? true,
    build: options.build ?? 'html',
    compress: options.compress ?? false,
    strip: options.strip,
    entryScene: options.entryScene ?? null,
    allowRemote: options.allowRemote ?? false,
  };

  let config: ResolvedConfig | null = null;
  let server: ViteDevServer | null = null;
  let scripts: ScriptGraph | null = null;
  /** The dev server's editor side, once `configureServer` started it (editor on). */
  let editor: EditorServer | null = null;
  let build: BuildState | null = null;

  const log = (line: string): void => config?.logger.info(`[pix3] ${line}`, { timestamp: true });
  const warn = (line: string): void => config?.logger.warn(`[pix3] ${line}`, { timestamp: true });
  const isBuild = (): boolean => config?.command === 'build' && settings.build !== false;
  const root = (): string => config?.root ?? process.cwd();
  const baseUrl = (): string => {
    const base = config?.base ?? '/';
    return base.endsWith('/') ? base : `${base}/`;
  };
  const outDir = (): string => {
    const dir = config?.build.outDir ?? 'dist';
    return isAbsolute(dir) ? dir : join(root(), dir);
  };

  const core: Plugin = {
    name: 'pix3',

    config(user, env) {
      return pix3ViteConfig({
        user,
        packageDir: PACKAGE_DIR,
        format: env.command === 'build' ? settings.build : false,
        compress: settings.compress,
        rolldown:
          typeof (this as { meta?: { rolldownVersion?: unknown } }).meta?.rolldownVersion ===
          'string',
      });
    },

    configResolved(resolved) {
      config = resolved;
      scripts = new ScriptGraph(resolved.root, () => server, [resolved.cacheDir]);
    },

    /** `vite build` only (plan §B.6 items 1–2): flush the editor, then plan what ships. */
    async buildStart() {
      if (config?.command !== 'build' || settings.build === false) return;
      await flushEditor(root(), log, message => this.error(message));
      const importer = join(root(), 'index.html');
      build = await planBuild({
        root: root(),
        format: settings.build,
        resRoot: settings.resRoot,
        entryScene: settings.entryScene,
        strip: settings.strip,
        compress: settings.compress,
        packageDir: PACKAGE_DIR,
        resolve: async specifier => (await this.resolve(specifier, importer))?.id ?? null,
        parse: code => this.parse(code),
        log,
        warn,
      });
    },

    /**
     * Vite awaits this in `server.close()` — also on an in-process restart (a `vite.config` edit):
     * every write already accepted finishes before a new server (and a new `ProjectFiles`) starts,
     * so two instances never write the same project at once.
     *
     * In a build it is the last hook: the artifact is final here (`build/finish.ts`).
     */
    async closeBundle() {
      await editor?.files.close();
      editor = null;
      if (build && isBuild()) finishBuild(build, { root: root(), outDir: outDir(), log, warn });
    },

    async configureServer(devServer) {
      server = devServer;
      if (!settings.editor || !config || !scripts) return;
      const projectRoot = config.root;
      editor = await startEditorServer(devServer, {
        root: projectRoot,
        base: baseUrl(),
        resRoot: settings.resRoot,
        build: settings.build,
        allowRemote: settings.allowRemote,
        imageGen: options.imageGen,
        versions: {
          plugin: pluginVersion(),
          runtime: installedVersion(projectRoot, '@pix3/runtime'),
          editorCore: installedVersion(projectRoot, '@pix3/editor-core'),
          vite: viteVersion,
        },
        scripts,
        log,
      });
    },

    resolveId(id) {
      if (VIRTUAL_IDS.has(id)) return resolvedId(id);
      // The player ships in this package; resolved here so a workspace link, pnpm or a project
      // without the package in its own `node_modules` all find the same file.
      if (id === PLAYER_SPECIFIER) return PLAYER_ENTRY;
      return null;
    },

    async load(id) {
      if (!id.startsWith('\0')) {
        // Plan §B.6 item 2: an unmentioned runtime module becomes a stub with the same exports.
        const modulePath = runtimeModulePath(build, id);
        if (modulePath === null || !build?.stripped.has(modulePath)) return null;
        build.applied.modules.add(modulePath);
        return buildStrippedModuleSource(readFileSync(fileOf(id), 'utf8'), modulePath);
      }
      const virtual = id.slice(1);
      const importer = join(root(), 'index.html');
      switch (virtual) {
        case EDITOR_SCRIPTS_ID:
        case BOT_POLICIES_ID:
          return rootModuleSource(virtual, editor?.files.currentSeq ?? 0);
        case SPINE_LOADER_ID:
          // Spine is an optional peer: a literal import() of a package that is not installed
          // kills the importing module outright (S1, finding 6), so the loader is decided here.
          return (await this.resolve('@esotericsoftware/spine-threejs', importer))
            ? `export const loadSpine = () => import('@esotericsoftware/spine-threejs');\n`
            : `export const loadSpine = () => Promise.resolve(null);\n`;
        case EDITOR_HOST_ID: {
          const base = baseUrl();
          return editorHostSource({
            base,
            clientUrl: `${base}@fs/${normalizePath(CLIENT_ENTRY).replace(/^\//, '')}`,
            editorCore: (await this.resolve('@pix3/editor-core', importer)) !== null,
          });
        }
        // --- the player's modules (plan §B.5) ---
        case SCENE_MANIFEST_ID:
          return build
            ? sceneManifestSource({
                scenePaths: build.scan.scenePaths,
                entryScenePath: build.scan.entryScenePath,
                manifest: build.manifest,
                localization: build.scan.localization,
                netKindPrefabs: build.scan.netKindPrefabs,
                resourceBase: './',
              })
            : devSceneManifestSource({
                root: root(),
                resRoot: settings.resRoot,
                entryScene: settings.entryScene,
                base: baseUrl(),
                warn,
              });
        case EMBEDDED_ASSETS_ID: {
          if (build?.format !== 'html') return noEmbeddedAssetsSource();
          const current = build;
          const embedded = await embeddedAssetsSource({
            root: root(),
            resRoot: settings.resRoot,
            assetPaths: current.scan.assetPaths,
            shippedBytes: (resPath, bytes) => shippedBytes(current, resPath, bytes, warn),
          });
          current.assets = embedded;
          log(
            `embedded ${embedded.count} asset(s), ${(embedded.rawBytes / 1024).toFixed(1)} KiB raw`
          );
          return embedded.source;
        }
        case YAML_STUB_ID:
          return yamlStubSource();
        case GLTF_LOADER_STUB_ID:
          return gltfLoaderStubSource();
        case PROJECT_SCRIPTS_ID:
          return projectScriptsSource();
        case SPINE_ID:
          if (!build) return spineSource('dev');
          return spineSource(build.scan.usesSpine && build.spineInstalled ? 'static' : 'none');
        case POSTPROCESSING_ID:
          return postprocessingSource(
            build?.format === 'html' &&
              build.scan.usesPostProcessing &&
              build.postprocessingInstalled
              ? 'static'
              : 'default'
          );
        case POSTPROCESSING_STUB_ID:
          return postprocessingStubSource();
        case NETWORK_ID:
          return networkSource(build ? build.scan.usesNetwork : true);
        default:
          return null;
      }
    },

    /** Every format: the chunks' per-module sizes, for the report; zip: the assets beside it. */
    generateBundle(_options, bundle) {
      if (!build || !isBuild()) return;
      recordModuleSizes(build, bundle);
      if (build.format !== 'zip') return;
      emitZipAssets(build, {
        root: root(),
        resRoot: settings.resRoot,
        emit: (fileName, source) => this.emitFile({ type: 'asset', fileName, source }),
        warn,
      });
    },

    transform(code, id, transformOptions) {
      if (transformOptions?.ssr) return null;
      if (config?.command === 'serve') return scripts ? scripts.stamp(code, id) : null;
      if (!build) return null;
      const error = strippedImportError(build, code, id, {
        root: root(),
        packageDir: PACKAGE_DIR,
        forced: settings.strip === true,
        parse: source => this.parse(source),
        warn,
      });
      if (error) this.error(error);
      return null;
    },

    async hotUpdate(update) {
      if (!scripts || !editor) return;
      return scriptHotUpdate(update, this.environment, { root: root(), scripts, editor });
    },
  };

  if (settings.build === false) return [core];
  const getBuild = (): BuildState | null => build;
  return [
    libraryStubsPlugin(getBuild),
    core,
    ...(settings.build === 'html'
      ? singleFilePlugins({ compress: settings.compress, getBuild })
      : []),
  ];
}

export default pix3;
