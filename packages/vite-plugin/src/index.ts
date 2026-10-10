import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePath,
  searchForWorkspaceRoot,
  version as viteVersion,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { toClassicScriptHtml } from './build/classic-script.ts';
import { toCompressedHtml, type CompressedHtml } from './build/compress.ts';
import {
  collectRuntimeImports,
  RUNTIME_SPECIFIER,
  scanDependencyImports,
} from './build/dependency-imports.ts';
import { EditorUnsyncedError, flushEditorBeforeBuild } from './build/editor-flush.ts';
import {
  EMBEDDED_ASSETS_ID,
  embeddedAssetsSource,
  GLTF_LOADER_SPECIFIER,
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
  SCENE_LIKE_ASSET,
  SCENE_MANIFEST_ID,
  sceneAsJson,
  sceneManifestSource,
  SPINE_ID,
  spineSource,
  YAML_STUB_ID,
  yamlStubSource,
  type EmbeddedAssetsResult,
} from './build/player-modules.ts';
import {
  readProjectManifest,
  stripRes,
  type ProjectManifestInfo,
} from './build/project-manifest.ts';
import { fileDigest, writeBuildRecord } from './build/record.ts';
import {
  buildReportPath,
  classifyModule,
  displayId,
  gzipBytesOf,
  summarizeCode,
  writeBuildReport,
  type ModuleSize,
} from './build/report.ts';
import { isPrefabPath, listProjectFiles, scanProject, type ProjectScan } from './build/scan.ts';
import {
  decideStrip,
  KEEP_HINT,
  runtimeDependents,
  type StripOption,
} from './build/strip-decision.ts';
import {
  buildStrippedModuleSource,
  resolveStrippableRuntimeModules,
} from './build/strippable-runtime-modules.ts';
import { zipDirectory } from './build/zip.ts';
import {
  clearDevInfo,
  findPackageDir,
  installedVersion,
  pluginVersion,
  versionMismatch,
  publicUrlOf,
  writeDevInfo,
  type DevInfo,
  type Versions,
} from './dev-info.ts';
import {
  EDITOR_HOST_ID,
  editorHostSource,
  editorPageHtml,
  SPINE_LOADER_ID,
  versionGatePageHtml,
} from './editor-page.ts';
import { ProjectFiles } from './files/project-files.ts';
import { EditorSocket } from './server/editor-socket.ts';
import { RequestGuard } from './server/guard.ts';
import { createRouter } from './server/router.ts';
import { SyncBarrier } from './sync/barrier.ts';
import {
  BOT_POLICIES_ID,
  EDITOR_SCRIPTS_ID,
  resolvedId,
  rootModuleSource,
  ScriptGraph,
  sha256Hex,
} from './sync/script-graph.ts';

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

/** What `buildStart` learned about the project for this `vite build`, plus what the bundle told. */
interface BuildState {
  readonly format: 'html' | 'zip';
  readonly manifest: ProjectManifestInfo;
  readonly scan: ProjectScan;
  /** Module paths (under the runtime's `src/`) replaced by stubs. */
  readonly stripped: ReadonlySet<string>;
  /** `name a dependency may import → the stripped module it keeps` (the transform net). */
  readonly stubbedNames: ReadonlyMap<string, string>;
  readonly stripReason: string | null;
  readonly stripEnabled: boolean;
  /** Whether `pix3({ strip })` was set at all (the net errors only when it was not). */
  readonly stripConfigured: boolean;
  readonly keep: readonly string[];
  /** N11: what the dependencies that declare the runtime import from it, and how many files. */
  readonly dependencyImports: ReadonlySet<string>;
  readonly dependencyParsed: Record<string, number>;
  /** Real path of the runtime's `src/`, or null when it did not resolve. */
  readonly runtimeSrc: string | null;
  readonly spineInstalled: boolean;
  readonly postprocessingInstalled: boolean;
  /** Scenes ship as JSON and the runtime's `yaml` is `JSON.parse`. */
  readonly stubYaml: boolean;
  /** No model in the project: `GLTFLoader` is a stub. */
  readonly stubGltf: boolean;
  // Filled by the bundle hooks, for the report.
  readonly moduleSizes: ModuleSize[];
  bundleBytes: number;
  assets: EmbeddedAssetsResult | null;
  compressed: CompressedHtml | null;
}

const isUnder = (file: string, dir: string | null): boolean => {
  if (!dir) return false;
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

export function pix3(options: Pix3Options = {}): Plugin[] {
  const settings = {
    resRoot: stripRes(options.resRoot ?? '.').replace(/\/+$/, '') || '.',
    editor: options.editor ?? true,
    build: options.build ?? 'html',
    compress: options.compress ?? false,
    strip: options.strip,
    entryScene: options.entryScene ?? null,
    allowRemote: options.allowRemote ?? false,
  };
  const buildFormat = (): 'html' | 'zip' | false => settings.build;

  let config: ResolvedConfig | null = null;
  let server: ViteDevServer | null = null;
  let files: ProjectFiles | null = null;
  let scripts: ScriptGraph | null = null;
  let barrier: SyncBarrier | null = null;
  let socket: EditorSocket | null = null;
  let versions: Versions | null = null;
  let build: BuildState | null = null;

  const log = (line: string): void => config?.logger.info(`[pix3] ${line}`, { timestamp: true });
  const warn = (line: string): void => config?.logger.warn(`[pix3] ${line}`, { timestamp: true });
  const isBuild = (): boolean => config?.command === 'build' && buildFormat() !== false;
  const root = (): string => config?.root ?? process.cwd();
  const baseUrl = (): string => {
    const base = config?.base ?? '/';
    return base.endsWith('/') ? base : `${base}/`;
  };
  const outDir = (): string =>
    isAbsolute(config?.build.outDir ?? 'dist')
      ? (config?.build.outDir as string)
      : join(root(), config?.build.outDir ?? 'dist');

  /** The module path under the runtime's `src/` of an absolute id, or null. */
  const runtimeModulePath = (id: string): string | null => {
    if (!build?.runtimeSrc) return null;
    const file = id.split('?')[0];
    if (!file.endsWith('.ts')) return null;
    const rel = relative(build.runtimeSrc, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/').replace(/\.ts$/, '');
  };

  /** The bytes an asset ships as: a scene or prefab as JSON when the runtime's `yaml` is a stub. */
  const shippedBytes = (resPath: string, bytes: Buffer): Buffer => {
    if (!build?.stubYaml || !SCENE_LIKE_ASSET.test(resPath)) return bytes;
    try {
      return Buffer.from(sceneAsJson(bytes.toString('utf8')), 'utf8');
    } catch (error) {
      // Not YAML the build can read: ship it as is; the runtime reports it when it loads.
      warn(`${resPath} did not parse as YAML (${String(error)}); shipped as written`);
      return bytes;
    }
  };

  /** Dev: the scene manifest from the disk as it is now. */
  const devSceneManifest = async (): Promise<string> => {
    const manifest = readProjectManifest(root());
    const resRoot = settings.resRoot;
    const wire = await listProjectFiles(root());
    const scenePaths = wire
      .map(path =>
        resRoot === '.'
          ? path
          : path.startsWith(`${resRoot}/`)
            ? path.slice(resRoot.length + 1)
            : null
      )
      .filter(
        (path): path is string =>
          path !== null && path.endsWith('.pix3scene') && !isPrefabPath(path)
      )
      .sort();
    const configured = settings.entryScene
      ? stripRes(settings.entryScene)
      : (manifest.defaultScenePath ?? '');
    const entryScenePath =
      configured && scenePaths.includes(configured)
        ? configured
        : scenePaths.includes('scenes/main.pix3scene')
          ? 'scenes/main.pix3scene'
          : (scenePaths[0] ?? '');
    return sceneManifestSource({
      scenePaths,
      entryScenePath,
      manifest,
      localization: manifest.localization,
      netKindPrefabs: [],
      resourceBase: `${baseUrl()}${resRoot === '.' ? '' : `${resRoot}/`}`,
    });
  };

  const core: Plugin = {
    name: 'pix3',

    config(user, env) {
      const projectRoot = resolve(user.root ?? process.cwd());
      const linkedEditorCore = findPackageDir(projectRoot, '@pix3/editor-core');
      // Vite checks `fs.allow` against real paths; a workspace or pnpm link points elsewhere.
      const editorCoreDir = linkedEditorCore ? realpathSync(linkedEditorCore) : null;
      // An explicit `fs.allow` switches off Vite's workspace-root default; keep it when the user
      // set none, and add this package (the page client and the player are served from it by
      // `/@fs/`) and the prebuilt editor (served from wherever npm put it: hoisted, pnpm, a
      // workspace link).
      const own = [PACKAGE_DIR, ...(editorCoreDir ? [editorCoreDir] : [])];
      const allow = user.server?.fs?.allow ? own : [searchForWorkspaceRoot(projectRoot), ...own];
      const format = env.command === 'build' ? buildFormat() : false;
      // Vite 8 bundles with rolldown, whose output option is `codeSplitting`; Vite 7 (rollup)
      // spells the same thing `inlineDynamicImports`. `this.meta.rolldownVersion` tells them apart.
      const rolldown =
        typeof (this as { meta?: { rolldownVersion?: unknown } }).meta?.rolldownVersion ===
        'string';
      const singleChunk = rolldown ? { codeSplitting: false } : { inlineDynamicImports: true };
      // A compressed build is injected as script text: `iife`, so it declares nothing global.
      const outputFormat =
        settings.compress && format === 'html' ? { format: 'iife' as const } : {};
      return {
        resolve: { dedupe: ['three', '@pix3/runtime'] },
        optimizeDeps: {
          // One runtime and one three for the game and the editor (plan §B.2, S1), plus the bare
          // subpaths the prebuilt editor imports (`dist/optimize-deps.json`).
          include: ['@pix3/runtime', 'three', ...editorOptimizeDeps(editorCoreDir)],
          exclude: ['@pix3/editor-core'],
        },
        server: { fs: { allow } },
        ...(format
          ? {
              // Relative URLs: the artifact runs from `file://`, a subfolder or a sandboxed frame.
              base: './',
              build: {
                ...(format === 'html'
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
                  : {}),
              },
            }
          : {}),
      };
    },

    configResolved(resolved) {
      config = resolved;
      scripts = new ScriptGraph(resolved.root, () => server, [resolved.cacheDir]);
    },

    /**
     * `vite build` only (plan §B.6 items 1–2): flush the editor that `.pix3/dev.json` points at,
     * then one scan of every text source decides what ships and what the stubs replace.
     */
    async buildStart() {
      if (!isBuild()) return;
      const format = buildFormat() as 'html' | 'zip';
      const projectRoot = root();
      try {
        const flushed = await flushEditorBeforeBuild(projectRoot);
        if (flushed.status === 'flushed')
          log(`editor at ${flushed.url} flushed its unsaved scenes`);
        else if (flushed.status === 'no-editor')
          log(`dev server at ${flushed.url}: no editor tab open`);
      } catch (error) {
        if (error instanceof EditorUnsyncedError) this.error(`${error.code}: ${error.message}`);
        throw error;
      }
      const manifest = readProjectManifest(projectRoot);
      const scan = await scanProject({
        root: projectRoot,
        resRoot: settings.resRoot,
        manifest,
        entryScene: settings.entryScene,
      });
      for (const warning of scan.warnings) warn(warning);
      if (!scan.entryScenePath) warn('no .pix3scene found: the player will have nothing to boot');

      const importer = join(projectRoot, 'index.html');
      const runtime = await this.resolve('@pix3/runtime', importer);
      const runtimeSrc = runtime ? dirname(realpathSync(runtime.id.split('?')[0])) : null;
      if (!runtimeSrc) warn('@pix3/runtime did not resolve from the project; nothing is stripped');
      const spineInstalled =
        (await this.resolve('@esotericsoftware/spine-threejs', importer)) !== null;
      const postprocessingInstalled = (await this.resolve('postprocessing', importer)) !== null;
      if (scan.usesSpine && !spineInstalled)
        warn(
          'a scene places a SpineSkeleton2D but @esotericsoftware/spine-threejs is not installed'
        );

      // N11: a dependency that declares the runtime is parsed for what it imports from it.
      const dependents = settings.strip === false ? [] : runtimeDependents(projectRoot);
      const dependencyScan = await scanDependencyImports({
        root: projectRoot,
        packages: dependents,
        parse: code => this.parse(code),
      });
      const decision = decideStrip(settings.strip, dependencyScan);
      const mentions = (name: string): boolean =>
        scan.mentionedNames.has(name) ||
        dependencyScan.names.has(name) ||
        decision.keep.includes(name);
      const stripped = new Set<string>();
      const stubbedNames = new Map<string, string>();
      if (decision.enabled && runtimeSrc) {
        for (const entry of resolveStrippableRuntimeModules(mentions)) {
          stripped.add(entry.modulePath);
          for (const name of entry.keepWhenMentioned) stubbedNames.set(name, entry.modulePath);
        }
      }
      const stubGltf =
        decision.enabled &&
        !mentions('GLTFLoader') &&
        !mentions('glb') &&
        !mentions('gltf') &&
        !scan.assetPaths.some(path => /\.(glb|gltf)$/i.test(path));
      build = {
        format,
        manifest,
        scan,
        stripped,
        stubbedNames,
        stripReason: decision.reason,
        stripEnabled: decision.enabled,
        stripConfigured: settings.strip !== undefined,
        keep: decision.keep,
        dependencyImports: dependencyScan.names,
        dependencyParsed: dependencyScan.parsed,
        runtimeSrc,
        spineInstalled,
        postprocessingInstalled,
        stubYaml: decision.enabled,
        stubGltf,
        moduleSizes: [],
        bundleBytes: 0,
        assets: null,
        compressed: null,
      };
      for (const [name, files] of Object.entries(dependencyScan.parsed)) {
        log(
          `${name} depends on ${RUNTIME_SPECIFIER}: ${files} file(s) parsed` +
            (dependencyScan.names.size > 0
              ? `, keeping ${[...dependencyScan.names].sort().join(', ')}`
              : '')
        );
      }
      log(
        `build ${format}${settings.compress && format === 'html' ? ' (compressed)' : ''}: ` +
          `entry ${scan.entryScenePath || '(none)'}, ${scan.scenePaths.length} scene(s), ` +
          `${scan.assetPaths.length} asset(s), ${scan.textSourceCount} text source(s) scanned; ` +
          (decision.enabled
            ? `strip on (${stripped.size} module(s)${stubGltf ? ', GLTFLoader' : ''}, scenes as JSON)` +
              (decision.reason ? ` — ${decision.reason}` : '')
            : `strip off — ${decision.reason}`)
      );
      if (settings.compress && format === 'zip')
        warn('compress applies to build: "html" only; the zip is written as is');
    },

    /**
     * Vite awaits this in `server.close()` — also on an in-process restart (a `vite.config` edit):
     * every write already accepted finishes before a new server (and a new `ProjectFiles`) starts,
     * so two instances never write the same project at once.
     *
     * In a build it is the last hook: the artifact is final here, so this is where the zip is
     * written and `.pix3/build.json` records what came out.
     */
    async closeBundle() {
      await files?.close();
      files = null;
      if (!build || !isBuild()) return;
      const dir = outDir();
      const htmlPath = join(dir, 'index.html');
      let artifact = htmlPath;
      if (build.format === 'zip') {
        artifact = zipDirectory(
          dir,
          `${build.manifest.projectName.replace(/[\\/:*?"<>|]+/g, '-')}.zip`
        );
      } else if (!existsSync(htmlPath)) {
        warn(`no ${htmlPath} after the build: is index.html the project's entry?`);
        return;
      }
      const digest = fileDigest(artifact);
      const at = new Date().toISOString();
      const stripped = [...build.stripped].sort();
      const reportPath = buildReportPath(artifact, dir);
      const compressed = build.compressed;
      const assets = build.assets;
      writeBuildReport(reportPath, {
        format: build.format,
        path: artifact,
        at,
        entryScene: build.scan.entryScenePath,
        scenes: build.scan.scenePaths.length,
        bytes: digest.bytes,
        gzipBytes: gzipBytesOf(readFileSync(artifact)),
        compress: compressed
          ? {
              enabled: true,
              bundleBytes: compressed.bundleBytes,
              gzipBytes: compressed.gzipBytes,
              base64Bytes: compressed.base64Bytes,
              ratio:
                Math.round((compressed.gzipBytes / Math.max(1, compressed.bundleBytes)) * 1000) /
                1000,
              savedBytes: compressed.bundleBytes - compressed.base64Bytes,
            }
          : { enabled: false },
        code: summarizeCode({ bundleBytes: build.bundleBytes, modules: build.moduleSizes }),
        strip: {
          enabled: build.stripEnabled,
          reason: build.stripReason,
          keep: build.keep,
          stripped,
          dependencies: build.dependencyParsed,
          dependencyImports: [...build.dependencyImports].sort(),
        },
        libraries: {
          yaml: build.stubYaml ? 'stub: scenes and prefabs ship as JSON' : 'bundled',
          GLTFLoader: build.stubGltf ? 'stub: no .glb/.gltf in the project' : 'bundled',
          postprocessing: !build.postprocessingInstalled
            ? 'not installed'
            : build.scan.usesPostProcessing
              ? 'bundled (static import)'
              : build.format !== 'html'
                ? 'lazy chunk (the runtime import())'
                : build.stripEnabled
                  ? 'stub: no PostProcess node'
                  : 'bundled (the runtime import(), inlined; strip is off)',
          spine: !build.scan.usesSpine
            ? 'not bundled: no SpineSkeleton2D'
            : build.spineInstalled
              ? 'bundled (static import)'
              : 'not installed',
          network: build.scan.usesNetwork ? 'bundled (NetworkService installed)' : 'no-op',
        },
        assets: {
          count: build.scan.assetPaths.length,
          rawBytes: assets?.rawBytes ?? 0,
          base64Bytes: assets?.base64Bytes ?? 0,
          entries: assets?.entries ?? [],
        },
        warnings: build.scan.warnings,
      });
      writeBuildRecord(root(), {
        format: build.format,
        path: artifact,
        ...digest,
        at,
        entryScene: build.scan.entryScenePath,
        assets: build.scan.assetPaths.length,
        stripped,
        warnings: build.scan.warnings,
        report: reportPath,
      });
      log(
        `${build.format}: ${relative(root(), artifact)} (${(digest.bytes / 1024).toFixed(1)} KiB` +
          (compressed
            ? `, bundle ${(compressed.bundleBytes / 1024).toFixed(1)} → gzip ${(compressed.gzipBytes / 1024).toFixed(1)} KiB`
            : '') +
          `); report ${relative(root(), reportPath)}`
      );
    },

    async configureServer(devServer) {
      server = devServer;
      if (!settings.editor || !config || !scripts) return;
      const projectRoot = config.root;
      const base = baseUrl();
      versions = {
        plugin: pluginVersion(),
        runtime: installedVersion(projectRoot, '@pix3/runtime'),
        editorCore: installedVersion(projectRoot, '@pix3/editor-core'),
        vite: viteVersion,
      };
      const guard = new RequestGuard({
        allowRemote: settings.allowRemote,
        allowedHosts: () => devServer.config.server.allowedHosts ?? [],
      });
      const projectFiles = new ProjectFiles({
        root: projectRoot,
        log,
        onChange: frame => socket?.broadcast({ ...frame }),
      });
      files = projectFiles;
      const editorSocket = new EditorSocket({
        path: `${base}__pix3/ws`,
        accept: req => {
          guard.checkPeer(req);
          guard.checkSameOrigin(req);
        },
        onTabsChanged: () => notePublicUrl(),
        welcome: tab => ({
          tabId: tab.tabId,
          seq: projectFiles.currentSeq,
          revision: projectFiles.revision(),
          writerId: projectFiles.writerId,
          root: projectRoot,
          projectName: basename(projectRoot),
          resRoot: settings.resRoot,
          versions,
        }),
        log,
      });
      socket = editorSocket;
      // `dev.json`'s `publicUrl` (Remote SSH, plan §E.3): `PIX3_PUBLIC_URL`, else the newest
      // tab's `Origin` when the browser reached this server through another address (a VS Code
      // port forward that is not 1:1). The agent finds its tab by that prefix.
      let devInfo: DevInfo | null = null;
      const notePublicUrl = (): void => {
        if (!devInfo) return;
        const newest = editorSocket.tabs().at(-1);
        const publicUrl = publicUrlOf({
          env: process.env.PIX3_PUBLIC_URL,
          tabOrigin: newest?.origin ?? null,
          port: devInfo.port,
          base,
        });
        if (!publicUrl || publicUrl === devInfo.publicUrl) return;
        devInfo = { ...devInfo, publicUrl, publicEditorUrl: `${publicUrl}__pix3/` };
        writeDevInfo(projectRoot, devInfo);
        log(`the browser reaches this server at ${publicUrl} (dev.json publicUrl)`);
      };
      const syncBarrier = new SyncBarrier({
        files: projectFiles,
        scripts,
        socket: editorSocket,
        log,
      });
      barrier = syncBarrier;
      await projectFiles.start();

      devServer.httpServer?.on('upgrade', (req, sock, head) => {
        editorSocket.handleUpgrade(req, sock, head);
      });
      devServer.watcher.on('all', (_event, path) => projectFiles.noteFsEvent(path));

      const gate = versionMismatch(versions.runtime, versions.editorCore);
      const editorCoreDir = findPackageDir(projectRoot, '@pix3/editor-core');
      const editorCss = editorCoreDir ? join(editorCoreDir, 'dist', 'editor.css') : null;
      devServer.middlewares.use(
        createRouter({
          base,
          guard,
          files: projectFiles,
          socket: editorSocket,
          barrier: syncBarrier,
          log,
          hello: () => ({
            root: projectRoot,
            resRoot: settings.resRoot,
            seq: projectFiles.currentSeq,
            revision: projectFiles.revision(),
            writerId: projectFiles.writerId,
            tabs: editorSocket.tabs().map(tab => tab.tabId),
            versions,
            build: settings.build,
          }),
          editorPage: () =>
            gate
              ? { status: 409, html: versionGatePageHtml(gate) }
              : {
                  status: 200,
                  html: editorPageHtml(base, { css: editorCss !== null && existsSync(editorCss) }),
                },
          editorCss: () => (editorCss && existsSync(editorCss) ? readFileSync(editorCss) : null),
        })
      );

      const httpServer = devServer.httpServer;
      httpServer?.on('listening', () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const protocol = devServer.config.server.https ? 'https' : 'http';
        const url = `${protocol}://localhost:${port}${base}`;
        const editorUrl = `${url}__pix3/`;
        devInfo = {
          url,
          editorUrl,
          port,
          pid: process.pid,
          versions: versions as Versions,
          startedAt: new Date().toISOString(),
        };
        writeDevInfo(projectRoot, devInfo);
        notePublicUrl();
        config?.logger.info(`\n  Pix3 editor: ${editorUrl}\n`);
        if (gate) config?.logger.warn(`[pix3] ${gate}`);
      });
      httpServer?.on('close', () => {
        clearDevInfo(projectRoot);
        editorSocket.close();
        void projectFiles.close();
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
        const modulePath = runtimeModulePath(id);
        if (modulePath !== null && build?.stripped.has(modulePath)) {
          return buildStrippedModuleSource(readFileSync(id.split('?')[0], 'utf8'), modulePath);
        }
        return null;
      }
      const virtual = id.slice(1);
      if (virtual === EDITOR_SCRIPTS_ID || virtual === BOT_POLICIES_ID) {
        return rootModuleSource(virtual, files?.currentSeq ?? 0);
      }
      if (virtual === SPINE_LOADER_ID) {
        // Spine is an optional peer: a literal import() of a package that is not installed kills
        // the importing module outright (S1, finding 6), so the loader is decided here.
        const importer = join(root(), 'index.html');
        const spine = await this.resolve('@esotericsoftware/spine-threejs', importer);
        return spine
          ? `export const loadSpine = () => import('@esotericsoftware/spine-threejs');\n`
          : `export const loadSpine = () => Promise.resolve(null);\n`;
      }
      if (virtual === EDITOR_HOST_ID) {
        const importer = join(root(), 'index.html');
        const editorCore = (await this.resolve('@pix3/editor-core', importer)) !== null;
        const base = baseUrl();
        const clientUrl = `${base}@fs/${normalizePath(CLIENT_ENTRY).replace(/^\//, '')}`;
        return editorHostSource({ base, clientUrl, editorCore });
      }
      // --- the player's modules (plan §B.5) ---
      if (virtual === SCENE_MANIFEST_ID) {
        if (!build) return devSceneManifest();
        return sceneManifestSource({
          scenePaths: build.scan.scenePaths,
          entryScenePath: build.scan.entryScenePath,
          manifest: build.manifest,
          localization: build.scan.localization,
          netKindPrefabs: build.scan.netKindPrefabs,
          resourceBase: './',
        });
      }
      if (virtual === EMBEDDED_ASSETS_ID) {
        if (build?.format !== 'html') return noEmbeddedAssetsSource();
        const embedded = await embeddedAssetsSource({
          root: root(),
          resRoot: settings.resRoot,
          assetPaths: build.scan.assetPaths,
          shippedBytes,
        });
        build.assets = embedded;
        log(
          `embedded ${embedded.count} asset(s), ${(embedded.rawBytes / 1024).toFixed(1)} KiB raw`
        );
        return embedded.source;
      }
      if (virtual === YAML_STUB_ID) return yamlStubSource();
      if (virtual === GLTF_LOADER_STUB_ID) return gltfLoaderStubSource();
      if (virtual === PROJECT_SCRIPTS_ID) return projectScriptsSource();
      if (virtual === SPINE_ID) {
        if (!build) return spineSource('dev');
        return spineSource(build.scan.usesSpine && build.spineInstalled ? 'static' : 'none');
      }
      if (virtual === POSTPROCESSING_ID) {
        const stat =
          build?.format === 'html' &&
          build.scan.usesPostProcessing &&
          build.postprocessingInstalled;
        return postprocessingSource(stat ? 'static' : 'default');
      }
      if (virtual === POSTPROCESSING_STUB_ID) return postprocessingStubSource();
      if (virtual === NETWORK_ID) return networkSource(build ? build.scan.usesNetwork : true);
      return null;
    },

    /**
     * Zip: the assets go beside `index.html`, under their `res://` paths. Every format: the
     * chunks' per-module sizes, for the report.
     */
    generateBundle(_options, bundle) {
      if (!build || !isBuild()) return;
      const classifier = {
        root: root(),
        runtimeSrc: build.runtimeSrc,
        playerDir: PACKAGE_DIR,
        embeddedAssetsId: EMBEDDED_ASSETS_ID,
      };
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        build.bundleBytes += Buffer.byteLength(output.code, 'utf8');
        for (const [id, rendered] of Object.entries(output.modules)) {
          const { group, package: pkg } = classifyModule(id, classifier);
          build.moduleSizes.push({
            id: displayId(id, classifier),
            group,
            package: pkg,
            renderedBytes: rendered.renderedLength,
          });
        }
      }
      if (build.format !== 'zip') return;
      const entries = [];
      for (const resPath of build.scan.assetPaths) {
        const absolute =
          settings.resRoot === '.'
            ? join(root(), ...resPath.split('/'))
            : join(root(), settings.resRoot, ...resPath.split('/'));
        const source = shippedBytes(resPath, readFileSync(absolute));
        entries.push({ path: resPath, rawBytes: source.byteLength, base64Bytes: 0 });
        this.emitFile({ type: 'asset', fileName: resPath, source });
      }
      build.assets = {
        source: '',
        count: entries.length,
        rawBytes: entries.reduce((sum, entry) => sum + entry.rawBytes, 0),
        base64Bytes: 0,
        entries: entries.sort((a, b) => b.rawBytes - a.rawBytes || (a.path < b.path ? -1 : 1)),
      };
    },

    transform(code, id, transformOptions) {
      if (transformOptions?.ssr) return null;
      if (config?.command === 'serve') return scripts ? scripts.stamp(code, id) : null;
      // The N11 safety net: a `node_modules` module the bundle pulls in (a transitive dependency,
      // one that does not declare the runtime) importing something this build stripped.
      if (
        !build ||
        !build.stripEnabled ||
        id.startsWith('\0') ||
        !code.includes(RUNTIME_SPECIFIER) ||
        isUnder(id.split('?')[0], build.runtimeSrc) ||
        isUnder(id.split('?')[0], PACKAGE_DIR) ||
        !(id.includes('/node_modules/') || !isUnder(id.split('?')[0], root()))
      ) {
        return null;
      }
      const label = displayId(id, {
        root: root(),
        runtimeSrc: build.runtimeSrc,
        playerDir: PACKAGE_DIR,
        embeddedAssetsId: EMBEDDED_ASSETS_ID,
      });
      let findings;
      try {
        findings = collectRuntimeImports(this.parse(code), label);
      } catch {
        return null; // not JS the bundler can parse here (it will say so itself)
      }
      const hits = [...findings.names].filter(name => build?.stubbedNames.has(name)).sort();
      if (hits.length > 0) {
        const message =
          `${label} imports ${hits.join(', ')} from ${RUNTIME_SPECIFIER}, which this build ` +
          `stripped (nothing in the project mentions ${hits.length > 1 ? 'them' : 'it'}). ` +
          `Add ${hits.map(name => `'${name}'`).join(', ')} to pix3({ strip: { keep } })` +
          (settings.strip === true ? '' : ', or pass strip: false');
        if (settings.strip === true) warn(message);
        else this.error(message);
      }
      if (findings.opaque.length > 0 && !build.stripConfigured) {
        this.error(
          `${findings.opaque[0]} — the build cannot see which runtime modules it reaches. ` +
            `Name them with ${KEEP_HINT}, or pass strip: false`
        );
      }
      return null;
    },

    async handleHotUpdate(ctx) {
      if (!server || !scripts || !barrier || !socket) return;
      // The player's scene manifest follows `pix3project.yaml` (entry scene, viewport, quality).
      if (ctx.file === join(root(), 'pix3project.yaml')) {
        const manifest = server.moduleGraph.getModuleById(resolvedId(SCENE_MANIFEST_ID));
        if (manifest) {
          server.moduleGraph.invalidateModule(manifest);
          return [...ctx.modules, manifest];
        }
        return;
      }
      const wirePath = scripts.wirePathOf(ctx.file);
      if (wirePath === null || !scripts.isEditorModule(wirePath)) return;
      let sha: string | null;
      try {
        sha = sha256Hex(readFileSync(ctx.file));
      } catch {
        sha = null;
      }
      // A sync already propagated these bytes; the watcher's late echo must not do it twice.
      if (barrier.alreadyPropagated(wirePath, sha)) return [];
      barrier.notePropagated(wirePath, sha);
      // Propagate through the client environment's own nodes (not `ctx.modules`, which are Vite 8's
      // backward-compatible mixed nodes — S1, finding 5), then tell the editor to re-import its
      // roots. Returning [] stops Vite from propagating a second time; the game tab already got
      // its update from `reloadModule`.
      scripts.hardInvalidateRoots();
      await scripts.reload(wirePath);
      socket.broadcast({ type: 'pix3:scripts', path: wirePath });
      return [];
    },
  };

  if (settings.build === false) return [core];

  /**
   * The optional libraries a build leaves out (CLAUDE.md «Playable export size»), part of the
   * strip (`strip: false` keeps them all). `enforce: 'pre'`, because Vite's own resolver runs
   * before a normal plugin's `resolveId`:
   *
   * - `postprocessing` in a single-file build with no PostProcess node — the runtime's
   *   `import('postprocessing')` would be inlined whole;
   * - `yaml` **for the runtime's own importers** — the scenes ship as JSON (`shippedBytes`), so
   *   `SceneLoader`'s `parse` is `JSON.parse`; a project module importing `yaml` keeps the real
   *   one (plan §B.6 item 4, done the 1.x way: no runtime change, no second scene format);
   * - `GLTFLoader` when no scene, script or asset names a model.
   */
  const libraryStubs: Plugin = {
    name: 'pix3:library-stubs',
    apply: 'build',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!build?.stripEnabled) return null;
      if (id === 'postprocessing' && build.format === 'html' && !build.scan.usesPostProcessing) {
        return resolvedId(POSTPROCESSING_STUB_ID);
      }
      if (id === 'yaml' && build.stubYaml && importer && isUnder(importer, build.runtimeSrc)) {
        return resolvedId(YAML_STUB_ID);
      }
      if (id === GLTF_LOADER_SPECIFIER && build.stubGltf) return resolvedId(GLTF_LOADER_STUB_ID);
      return null;
    },
  };

  /** `build: 'html'`: inline every chunk and stylesheet into `index.html` (plan §B.6 item 5). */
  const singleFile: Plugin = {
    ...(viteSingleFile({
      useRecommendedBuildConfig: false,
      // `modulePreload: false` above means there is no preload polyfill to remove — and the
      // removal's regex takes the first IIFE it sees for that polyfill, which in a compressed
      // (`iife`) build is the head of the bundle itself.
      removeViteModuleLoader: false,
    }) as Plugin),
    name: 'pix3:single-file',
    apply: (_user, env) => env.command === 'build' && buildFormat() === 'html',
  };

  /**
   * Then make that one script classic, at the end of `<body>` (DeepCore's compatibility plugin),
   * and with `compress` replace it by the gzip payload and its bootstrap (`build/compress.ts`).
   */
  const classicScript: Plugin = {
    name: 'pix3:classic-script',
    apply: (_user, env) => env.command === 'build' && buildFormat() === 'html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset' || !output.fileName.endsWith('.html')) continue;
        const html =
          typeof output.source === 'string'
            ? output.source
            : Buffer.from(output.source).toString('utf8');
        const classic = toClassicScriptHtml(html);
        if (!settings.compress || !build) {
          output.source = classic;
          continue;
        }
        const compressed = toCompressedHtml(classic);
        build.compressed = compressed;
        output.source = compressed.html;
      }
    },
  };

  return [libraryStubs, core, singleFile, classicScript];
}

export default pix3;
