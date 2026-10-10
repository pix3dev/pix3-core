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
import { EditorUnsyncedError, flushEditorBeforeBuild } from './build/editor-flush.ts';
import {
  EMBEDDED_ASSETS_ID,
  embeddedAssetsSource,
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
} from './build/player-modules.ts';
import {
  readProjectManifest,
  stripRes,
  type ProjectManifestInfo,
} from './build/project-manifest.ts';
import { fileDigest, writeBuildRecord } from './build/record.ts';
import { isPrefabPath, listProjectFiles, scanProject, type ProjectScan } from './build/scan.ts';
import { decideStrip } from './build/strip-decision.ts';
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
  writeDevInfo,
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
  /** Gzip + inline bootstrap (plan §B.6 item 5, P2 — accepted, not implemented yet). */
  readonly compress?: boolean;
  /**
   * Replace runtime modules nothing in the project mentions with throwing stubs. Default: on
   * unless a dependency depends on `@pix3/runtime` itself (its imports are not scanned yet).
   */
  readonly strip?: boolean;
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

/** What `buildStart` learned about the project for this `vite build`. */
interface BuildState {
  readonly format: 'html' | 'zip';
  readonly manifest: ProjectManifestInfo;
  readonly scan: ProjectScan;
  /** Module paths (under the runtime's `src/`) replaced by stubs. */
  readonly stripped: ReadonlySet<string>;
  readonly stripReason: string | null;
  readonly stripEnabled: boolean;
  /** Real path of the runtime's `src/`, or null when it did not resolve. */
  readonly runtimeSrc: string | null;
  readonly spineInstalled: boolean;
  readonly postprocessingInstalled: boolean;
}

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
                      rollupOptions: { output: singleChunk },
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

      const decision = decideStrip(projectRoot, settings.strip);
      const stripped = new Set<string>();
      if (decision.enabled && runtimeSrc) {
        for (const entry of resolveStrippableRuntimeModules(name => scan.mentionedNames.has(name)))
          stripped.add(entry.modulePath);
      }
      build = {
        format,
        manifest,
        scan,
        stripped,
        stripReason: decision.reason,
        stripEnabled: decision.enabled,
        runtimeSrc,
        spineInstalled,
        postprocessingInstalled,
      };
      log(
        `build ${format}: entry ${scan.entryScenePath || '(none)'}, ${scan.scenePaths.length} scene(s), ` +
          `${scan.assetPaths.length} asset(s), ${scan.textSourceCount} text source(s) scanned; ` +
          (decision.enabled
            ? `strip on (${stripped.size} module(s))${decision.reason ? ` — ${decision.reason}` : ''}`
            : `strip off — ${decision.reason}`)
      );
      if (settings.compress)
        warn('compress is not implemented yet (plan §B.6, P2); building uncompressed');
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
      writeBuildRecord(root(), {
        format: build.format,
        path: artifact,
        ...digest,
        at: new Date().toISOString(),
        entryScene: build.scan.entryScenePath,
        assets: build.scan.assetPaths.length,
        stripped: [...build.stripped].sort(),
        warnings: build.scan.warnings,
      });
      log(
        `${build.format}: ${relative(root(), artifact)} (${(digest.bytes / 1024).toFixed(1)} KiB)`
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
        writeDevInfo(projectRoot, {
          url,
          editorUrl,
          port,
          pid: process.pid,
          versions: versions as Versions,
          startedAt: new Date().toISOString(),
        });
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
        });
        log(
          `embedded ${embedded.count} asset(s), ${(embedded.rawBytes / 1024).toFixed(1)} KiB raw`
        );
        return embedded.source;
      }
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

    /** Zip: the assets go beside `index.html`, under their `res://` paths. */
    generateBundle() {
      if (build?.format !== 'zip') return;
      for (const resPath of build.scan.assetPaths) {
        const absolute =
          settings.resRoot === '.'
            ? join(root(), ...resPath.split('/'))
            : join(root(), settings.resRoot, ...resPath.split('/'));
        this.emitFile({ type: 'asset', fileName: resPath, source: readFileSync(absolute) });
      }
    },

    transform(code, id, transformOptions) {
      if (config?.command !== 'serve' || transformOptions?.ssr || !scripts) return null;
      return scripts.stamp(code, id);
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
   * A single-file build with no PostProcess node: the runtime's `import('postprocessing')` would
   * be inlined whole; point the bare specifier at a stub instead (CLAUDE.md «Playable export
   * size»). Part of the strip (`strip: false` keeps the library). `enforce: 'pre'`, because Vite's
   * own resolver runs before a normal plugin's `resolveId`.
   */
  const postprocessingStub: Plugin = {
    name: 'pix3:postprocessing-stub',
    apply: 'build',
    enforce: 'pre',
    resolveId(id) {
      if (
        id === 'postprocessing' &&
        build?.format === 'html' &&
        build.stripEnabled &&
        !build.scan.usesPostProcessing
      ) {
        return resolvedId(POSTPROCESSING_STUB_ID);
      }
      return null;
    },
  };

  /** `build: 'html'`: inline every chunk and stylesheet into `index.html` (plan §B.6 item 5). */
  const singleFile: Plugin = {
    ...(viteSingleFile({
      useRecommendedBuildConfig: false,
      removeViteModuleLoader: true,
    }) as Plugin),
    name: 'pix3:single-file',
    apply: (_user, env) => env.command === 'build' && buildFormat() === 'html',
  };

  /** Then make that one script classic, at the end of `<body>` (DeepCore's compatibility plugin). */
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
        output.source = toClassicScriptHtml(html);
      }
    },
  };

  return [postprocessingStub, core, singleFile, classicScript];
}

export default pix3;
