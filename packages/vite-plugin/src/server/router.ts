import type { IncomingMessage, ServerResponse } from 'node:http';

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
 * | `GET /__pix3/api/hello` | project, versions, `seq`, `revision`, current writer |
 * | `GET\|HEAD\|PUT /__pix3/api/file?path=` | bytes with sha256 ETag; conditional atomic write |
 * | `GET /__pix3/api/manifest` | full rescan + every file with its hash |
 * | `POST /__pix3/api/hash` | `{paths}` → `{hashes}` |
 * | `POST /__pix3/api/{mkdir,delete,move}` | |
 * | `POST /__pix3/api/handover/claim` | `{writerId}` → the disk the new writer starts from |
 * | `POST /__pix3/api/sync` | the barrier (§B.3) |
 * | `POST /__pix3/api/flush` | step 0 of the barrier on its own (the CLI before a build) |
 */

export interface RouterDeps {
  readonly base: string;
  readonly guard: RequestGuard;
  readonly files: ProjectFiles;
  readonly socket: EditorSocket;
  readonly barrier: SyncBarrier;
  readonly hello: () => Record<string, unknown>;
  readonly editorPage: () => { status: number; html: string };
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
