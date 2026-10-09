import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseBuildRequest, type BuildRunner } from '../build/run-build.ts';
import type { ProjectFiles } from '../files/project-files.ts';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  parseSyncRequest,
  parseTimeout,
  type SyncBarrier,
} from '../sync/barrier.ts';
import type { EditorSocket } from './editor-socket.ts';
import type { RequestGuard } from './guard.ts';
import { errorBody, HttpError, readJson, sendJson } from './http.ts';

/**
 * `/__pix3/*` (plan §B.1): the editor page and the file API. Mounted as a pre-middleware, so it
 * sees `req.url` with Vite's `base` still on it.
 *
 * | Route | |
 * |---|---|
 * | `GET /__pix3/` | the editor page (raw HTML: no `transformIndexHtml`, no `/@vite/client`) |
 * | `GET /__pix3/editor.css` | the prebuilt editor's stylesheet |
 * | `GET /__pix3/api/hello` | project, versions, `seq`, `revision`, current writer |
 * | `GET\|HEAD\|PUT /__pix3/api/file?path=` | bytes with sha256 ETag; conditional atomic write |
 * | `GET /__pix3/api/manifest` | full rescan + every file with its hash |
 * | `POST /__pix3/api/hash` | `{paths}` → `{hashes}` |
 * | `POST /__pix3/api/{mkdir,delete,move}` | |
 * | `POST /__pix3/api/changeset` | `{files: [{path, text\|base64, ifMatch?, createOnly?}]}` as one transaction (§C.4) |
 * | `GET /__pix3/api/history?path=` | `{entries}` of the version journal, newest first |
 * | `GET\|HEAD /__pix3/api/history/version?path=&id=` | one journaled version's raw bytes |
 * | `POST /__pix3/api/history/record` | `{path, text, author: 'rejected-draft', note?}` → the entry (any tab) |
 * | `POST /__pix3/api/history/restore` | `{path, id}` (+ `If-Match`) → written back, seen as `external` |
 * | `POST /__pix3/api/handover/claim` | `{writerId}` → the disk the new writer starts from |
 * | `POST /__pix3/api/sync` | the barrier (§B.3) |
 * | `POST /__pix3/api/flush` | step 0 of the barrier on its own (the CLI before a build) |
 * | `POST /__pix3/api/build` | `{format?, compress?, entryScene?}` → flush, `vite build` in a child, `.pix3/build.json` (§B.6) |
 */

export interface RouterDeps {
  readonly base: string;
  readonly guard: RequestGuard;
  readonly files: ProjectFiles;
  readonly socket: EditorSocket;
  readonly barrier: SyncBarrier;
  /** The build runner, or null when `pix3({ build: false })`. */
  readonly build: BuildRunner | null;
  readonly hello: () => Record<string, unknown>;
  readonly editorPage: () => { status: number; html: string };
  /** The prebuilt editor's stylesheet (`@pix3/editor-core/dist/editor.css`), or null. */
  readonly editorCss: () => Buffer | null;
  readonly log: (line: string) => void;
}

export const createRouter = (deps: RouterDeps) => {
  const prefix = `${deps.base}__pix3`;
  const apiPrefix = `${prefix}/api/`;

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    deps.guard.checkPeer(req);
    if (method !== 'GET' && method !== 'HEAD') deps.guard.checkMutation(req);

    if (path === prefix) {
      res.writeHead(302, { Location: `${prefix}/${url.search}` });
      res.end();
      return;
    }
    if (path === `${prefix}/` || path === `${prefix}/index.html`) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method', 'GET only.');
      const page = deps.editorPage();
      res.writeHead(page.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(method === 'HEAD' ? undefined : page.html);
      return;
    }
    if (path === `${prefix}/editor.css` && (method === 'GET' || method === 'HEAD')) {
      // Served statically, past the project's PostCSS (plan §B.0): no CSS import may reach the
      // editor chain (contract B).
      const css = deps.editorCss();
      if (!css) throw new HttpError(404, 'not_found', '@pix3/editor-core is not installed.');
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(method === 'HEAD' ? undefined : css);
      return;
    }
    if (!path.startsWith(apiPrefix)) throw new HttpError(404, 'not_found', 'Not found.');
    const api = path.slice(apiPrefix.length);

    if (method === 'GET' && api === 'hello') {
      sendJson(res, 200, deps.hello());
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && api === 'file') {
      await deps.files.readFile(req, res, url, method === 'HEAD');
      return;
    }
    if (method === 'PUT' && api === 'file') {
      await deps.files.writeFile(req, res, url);
      return;
    }
    if (method === 'GET' && api === 'manifest') {
      sendJson(res, 200, await deps.files.manifest());
      return;
    }
    if (method === 'POST' && api === 'hash') {
      sendJson(res, 200, await deps.files.hashPaths(await readJson(req)));
      return;
    }
    if (method === 'POST' && (api === 'mkdir' || api === 'delete' || api === 'move')) {
      await deps.files.jsonMutation(req, res, api, await readJson(req));
      return;
    }
    if (method === 'POST' && api === 'changeset') {
      await deps.files.writeChangeset(req, res);
      return;
    }
    if (method === 'GET' && api === 'history') {
      sendJson(res, 200, await deps.files.historyList(url));
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && api === 'history/version') {
      await deps.files.historyVersion(res, url, method === 'HEAD');
      return;
    }
    if (method === 'POST' && api === 'history/record') {
      sendJson(res, 200, { ...(await deps.files.historyRecord(await readJson(req))) });
      return;
    }
    if (method === 'POST' && api === 'history/restore') {
      await deps.files.historyRestore(req, res);
      return;
    }
    if (method === 'POST' && api === 'handover/claim') {
      const body = await readJson(req);
      const claimed = await deps.files.claim(body.writerId);
      deps.socket.broadcast({ type: 'pix3:writer', writerId: claimed.writerId });
      sendJson(res, 200, claimed);
      return;
    }
    if (method === 'POST' && api === 'sync') {
      const request = parseSyncRequest(await readJson(req));
      sendJson(res, 200, await deps.barrier.sync(request));
      return;
    }
    if (method === 'POST' && api === 'flush') {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await deps.barrier.flush(parseTimeout(body.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS))
      );
      return;
    }
    if (method === 'POST' && api === 'build') {
      if (!deps.build) {
        throw new HttpError(400, 'build_disabled', 'pix3({ build: false }): no playable build.');
      }
      const record = await deps.build.run(parseBuildRequest(await readJson(req)));
      sendJson(res, 200, { ok: true, ...record });
      return;
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  };

  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      next();
      return;
    }
    route(req, res, url).catch((error: unknown) => {
      if (!(error instanceof HttpError)) {
        deps.log(
          `500 ${req.method} ${req.url}: ${error instanceof Error ? error.stack : String(error)}`
        );
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const { status, body } = errorBody(error);
      // Drain what the client is still sending, so it reads our answer instead of EPIPE.
      req.resume();
      sendJson(res, status, body);
    });
  };
};
