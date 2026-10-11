import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { ViteDevServer } from 'vite';

import {
  clearDevInfo,
  findPackageDir,
  publicUrlOf,
  versionMismatch,
  writeDevInfo,
  type DevInfo,
  type Versions,
} from './dev-info.ts';
import { editorPageHtml, versionGatePageHtml } from './editor-page.ts';
import { ProjectFiles } from './files/project-files.ts';
import { EditorSocket } from './server/editor-socket.ts';
import { RequestGuard } from './server/guard.ts';
import { defaultPix3Home, IMAGE_PROVIDERS, ImageKeyStore } from './server/image-keys.ts';
import { DEFAULT_UPSTREAMS, ImageProxy, UPSTREAM_ENV } from './server/image-proxy.ts';
import { createRouter } from './server/router.ts';
import { SyncBarrier } from './sync/barrier.ts';
import type { ScriptGraph } from './sync/script-graph.ts';
import type { Pix3Options } from './index.ts';

export interface EditorServer {
  readonly files: ProjectFiles;
  readonly socket: EditorSocket;
  readonly barrier: SyncBarrier;
}

/**
 * `configureServer` with the editor on: the file API, the editor's socket, the sync barrier, the
 * image-gen proxy and `/__pix3/*`, and `.pix3/dev.json` for as long as the server listens.
 */
export const startEditorServer = async (
  devServer: ViteDevServer,
  options: {
    readonly root: string;
    /** Vite's `base`, ending in `/`. */
    readonly base: string;
    readonly resRoot: string;
    readonly build: Pix3Options['build'];
    readonly allowRemote: boolean;
    readonly imageGen: Pix3Options['imageGen'];
    readonly versions: Versions;
    readonly scripts: ScriptGraph;
    readonly log: (line: string) => void;
  }
): Promise<EditorServer> => {
  const { root, base, resRoot, versions, log } = options;
  const logger = devServer.config.logger;
  const guard = new RequestGuard({
    allowRemote: options.allowRemote,
    allowedHosts: () => devServer.config.server.allowedHosts ?? [],
  });
  const imageProxy = new ImageProxy({
    keys: new ImageKeyStore({
      home: options.imageGen?.home ?? defaultPix3Home(),
      projectRoot: root,
    }),
    upstreams: Object.fromEntries(
      IMAGE_PROVIDERS.map(provider => [
        provider,
        options.imageGen?.upstreams?.[provider] ||
          process.env[UPSTREAM_ENV[provider]] ||
          DEFAULT_UPSTREAMS[provider],
      ])
    ) as Record<(typeof IMAGE_PROVIDERS)[number], string>,
    log,
  });
  const files = new ProjectFiles({
    root,
    log,
    onChange: frame => socket.broadcast({ ...frame }),
  });
  // What both a tab's `welcome` and `GET /__pix3/api/hello` start with.
  const projectState = () => ({
    seq: files.currentSeq,
    revision: files.revision(),
    writerId: files.writerId,
    root,
    resRoot,
    versions,
  });
  const socket = new EditorSocket({
    path: `${base}__pix3/ws`,
    accept: req => guard.checkSocket(req),
    onTabsChanged: () => notePublicUrl(),
    welcome: tab => ({ tabId: tab.tabId, ...projectState(), projectName: basename(root) }),
    log,
  });
  // `dev.json`'s `publicUrl` (Remote SSH, plan §E.3): `PIX3_PUBLIC_URL`, else the newest tab's
  // `Origin` when the browser reached this server through another address (a VS Code port
  // forward that is not 1:1). The agent finds its tab by that prefix.
  let devInfo: DevInfo | null = null;
  const notePublicUrl = (): void => {
    if (!devInfo) return;
    const publicUrl = publicUrlOf({
      env: process.env.PIX3_PUBLIC_URL,
      tabOrigin: socket.tabs().at(-1)?.origin ?? null,
      port: devInfo.port,
      base,
    });
    if (!publicUrl || publicUrl === devInfo.publicUrl) return;
    devInfo = { ...devInfo, publicUrl, publicEditorUrl: `${publicUrl}__pix3/` };
    writeDevInfo(root, devInfo);
    log(`the browser reaches this server at ${publicUrl} (dev.json publicUrl)`);
  };
  const barrier = new SyncBarrier({ files, scripts: options.scripts, socket, log });
  await files.start();

  devServer.httpServer?.on('upgrade', (req, sock, head) => {
    socket.handleUpgrade(req, sock, head);
  });
  devServer.watcher.on('all', (_event, path) => files.noteFsEvent(path));

  const gate = versionMismatch(versions.runtime, versions.editorCore);
  const editorCoreDir = findPackageDir(root, '@pix3/editor-core');
  const editorCss = editorCoreDir ? join(editorCoreDir, 'dist', 'editor.css') : null;
  devServer.middlewares.use(
    createRouter({
      base,
      guard,
      files,
      socket,
      barrier,
      log,
      hello: () => ({
        ...projectState(),
        tabs: socket.tabs().map(tab => tab.tabId),
        build: options.build,
      }),
      editorPage: session =>
        gate
          ? { status: 409, html: versionGatePageHtml(gate) }
          : {
              status: 200,
              html: editorPageHtml(base, {
                css: editorCss !== null && existsSync(editorCss),
                session,
              }),
            },
      // Handed to the editor page on a top-level navigation only (`editorSessionFor`).
      sessionToken: randomBytes(32).toString('base64url'),
      imageProxy,
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
      versions,
      startedAt: new Date().toISOString(),
    };
    writeDevInfo(root, devInfo);
    notePublicUrl();
    logger.info(`\n  Pix3 editor: ${editorUrl}\n`);
    if (gate) logger.warn(`[pix3] ${gate}`);
  });
  httpServer?.on('close', () => {
    clearDevInfo(root);
    socket.close();
    void files.close();
  });
  return { files, socket, barrier };
};
