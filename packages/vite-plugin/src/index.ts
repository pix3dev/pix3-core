import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePath,
  searchForWorkspaceRoot,
  version as viteVersion,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite';

import {
  clearDevInfo,
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
  /** Playable build format; `false` leaves `vite build` alone (plan §B.6, not implemented yet). */
  readonly build?: 'html' | 'zip' | false;
  readonly compress?: boolean;
  /** Answer `/__pix3/*` for non-loopback peers too (a dev server started with `--host`). */
  readonly allowRemote?: boolean;
}

const VIRTUAL_IDS = new Set([EDITOR_HOST_ID, EDITOR_SCRIPTS_ID, BOT_POLICIES_ID, SPINE_LOADER_ID]);

/** Directory of this package (`src/` or `dist/` sits under it). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The page client, as source under vitest and as emitted JS from `dist/`. */
const CLIENT_ENTRY = fileURLToPath(
  new URL(`./client/index.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)
);

export function pix3(options: Pix3Options = {}): Plugin {
  const settings = {
    resRoot: options.resRoot ?? '.',
    editor: options.editor ?? true,
    build: options.build ?? 'html',
    compress: options.compress ?? false,
    allowRemote: options.allowRemote ?? false,
  };
  let config: ResolvedConfig | null = null;
  let server: ViteDevServer | null = null;
  let files: ProjectFiles | null = null;
  let scripts: ScriptGraph | null = null;
  let barrier: SyncBarrier | null = null;
  let socket: EditorSocket | null = null;
  let versions: Versions | null = null;

  const log = (line: string): void => config?.logger.info(`[pix3] ${line}`, { timestamp: true });

  return {
    name: 'pix3',

    config(user) {
      const root = resolve(user.root ?? process.cwd());
      // An explicit `fs.allow` switches off Vite's workspace-root default; keep it when the user
      // set none, and add this package (the page client is served from it by `/@fs/`).
      const allow = user.server?.fs?.allow
        ? [PACKAGE_DIR]
        : [searchForWorkspaceRoot(root), PACKAGE_DIR];
      return {
        resolve: { dedupe: ['three', '@pix3/runtime'] },
        optimizeDeps: {
          // One runtime and one three for the game and the editor (plan §B.2, S1).
          include: ['@pix3/runtime', 'three'],
          exclude: ['@pix3/editor-core'],
        },
        server: { fs: { allow } },
      };
    },

    configResolved(resolved) {
      config = resolved;
      scripts = new ScriptGraph(resolved.root, () => server);
    },

    async configureServer(devServer) {
      server = devServer;
      if (!settings.editor || !config || !scripts) return;
      const root = config.root;
      const base = config.base.endsWith('/') ? config.base : `${config.base}/`;
      versions = {
        plugin: pluginVersion(),
        runtime: installedVersion(root, '@pix3/runtime'),
        editorCore: installedVersion(root, '@pix3/editor-core'),
        vite: viteVersion,
      };
      const guard = new RequestGuard({
        allowRemote: settings.allowRemote,
        allowedHosts: () => devServer.config.server.allowedHosts ?? [],
      });
      const projectFiles = new ProjectFiles({
        root,
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
          resRoot: settings.resRoot,
          versions,
        }),
        log,
      });
      socket = editorSocket;
      barrier = new SyncBarrier({ files: projectFiles, scripts, socket: editorSocket, log });
      await projectFiles.start();

      devServer.httpServer?.on('upgrade', (req, sock, head) => {
        editorSocket.handleUpgrade(req, sock, head);
      });
      devServer.watcher.on('all', (_event, path) => projectFiles.noteFsEvent(path));

      const gate = versionMismatch(versions.runtime, versions.editorCore);
      devServer.middlewares.use(
        createRouter({
          base,
          guard,
          files: projectFiles,
          socket: editorSocket,
          barrier,
          log,
          hello: () => ({
            root,
            resRoot: settings.resRoot,
            seq: projectFiles.currentSeq,
            revision: projectFiles.revision(),
            writerId: projectFiles.writerId,
            tabs: editorSocket.tabs().map(tab => tab.tabId),
            versions,
          }),
          editorPage: () =>
            gate
              ? { status: 409, html: versionGatePageHtml(gate) }
              : { status: 200, html: editorPageHtml(base) },
        })
      );

      const httpServer = devServer.httpServer;
      httpServer?.on('listening', () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const protocol = devServer.config.server.https ? 'https' : 'http';
        const url = `${protocol}://localhost:${port}${base}`;
        const editorUrl = `${url}__pix3/`;
        writeDevInfo(root, {
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
        clearDevInfo(root);
        editorSocket.close();
        void projectFiles.close();
      });
    },

    resolveId(id) {
      return VIRTUAL_IDS.has(id) ? resolvedId(id) : null;
    },

    async load(id) {
      if (!id.startsWith('\0')) return null;
      const virtual = id.slice(1);
      if (virtual === EDITOR_SCRIPTS_ID || virtual === BOT_POLICIES_ID) {
        return rootModuleSource(virtual, files?.currentSeq ?? 0);
      }
      if (virtual === SPINE_LOADER_ID) {
        // Spine is an optional peer: a literal import() of a package that is not installed kills
        // the importing module outright (S1, finding 6), so the loader is decided here.
        const importer = join(config?.root ?? process.cwd(), 'index.html');
        const spine = await this.resolve('@esotericsoftware/spine-threejs', importer);
        return spine
          ? `export const loadSpine = () => import('@esotericsoftware/spine-threejs');\n`
          : `export const loadSpine = () => Promise.resolve(null);\n`;
      }
      if (virtual === EDITOR_HOST_ID) {
        const importer = join(config?.root ?? process.cwd(), 'index.html');
        const editorCore = (await this.resolve('@pix3/editor-core', importer)) !== null;
        const base = config?.base.endsWith('/') ? config.base : `${config?.base ?? ''}/`;
        const clientUrl = `${base}@fs/${normalizePath(CLIENT_ENTRY).replace(/^\//, '')}`;
        return editorHostSource({ base, clientUrl, editorCore });
      }
      return null;
    },

    transform(code, id, transformOptions) {
      if (config?.command !== 'serve' || transformOptions?.ssr || !scripts) return null;
      return scripts.stamp(code, id);
    },

    async handleHotUpdate(ctx) {
      if (!server || !scripts || !barrier || !socket) return;
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
}

export default pix3;
