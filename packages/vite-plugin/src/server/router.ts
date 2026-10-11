import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectFiles } from '../files/project-files.ts';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  parseSyncRequest,
  parseTimeout,
  type SyncBarrier,
} from '../sync/barrier.ts';
import type { EditorSocket } from './editor-socket.ts';
import { editorSessionFor, type RequestGuard } from './guard.ts';
import { errorBody, HttpError, readJson, sendJson } from './http.ts';
import type { ImageProxy } from './image-proxy.ts';

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
 * | `POST /__pix3/api/flush` | step 0 of the barrier on its own (`vite build`, `pix3 check`/`smoke` before they read the disk) |
 * | `GET\|PUT /__pix3/api/keys` | image-gen key status `{set, last4?}` per provider / set or remove one (never echoed) |
 * | `POST /__pix3/api/proxy/{gemini,openai}/…` | the provider's generation endpoint, the key added server-side |
 *
 * `keys` and `proxy` answer the editor page only (`RequestGuard.checkEditorOnly`: the page's
 * session token, its `Referer`, `Sec-Fetch-Site`). No URL with a `.pix3` segment is served at all —
 * the project's `.pix3/` holds `local/keys.json` when `~` is not writable.
 */

export interface RouterDeps {
  readonly base: string;
  readonly guard: RequestGuard;
  readonly files: ProjectFiles;
  readonly socket: EditorSocket;
  readonly barrier: SyncBarrier;
  readonly hello: () => Record<string, unknown>;
  /** `session`: the token for this request's page, or null (`editorSessionFor`). */
  readonly editorPage: (session: string | null) => { status: number; html: string };
  /** Handed to the editor page on a top-level navigation; required by `keys` and `proxy`. */
  readonly sessionToken: string;
  readonly imageProxy: ImageProxy;
  /** The prebuilt editor's stylesheet (`@pix3/editor-core/dist/editor.css`), or null. */
  readonly editorCss: () => Buffer | null;
  readonly log: (line: string) => void;
}

export const createRouter = (deps: RouterDeps) => {
  const prefix = `${deps.base}__pix3`;
  const apiPrefix = `${prefix}/api/`;

  type Handler = (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    head: boolean
  ) => Promise<void> | void;
  /** A handler whose answer is `200` + JSON. */
  const json =
    (answer: (req: IncomingMessage, url: URL) => Promise<Record<string, unknown>>): Handler =>
    async (req, res, url) =>
      sendJson(res, 200, await answer(req, url));
  const { files } = deps;
  const readFile: Handler = (req, res, url, head) => files.readFile(req, res, url, head);
  const historyVersion: Handler = (_req, res, url, head) => files.historyVersion(res, url, head);
  const jsonMutation =
    (op: 'mkdir' | 'delete' | 'move'): Handler =>
    async (req, res) =>
      files.jsonMutation(req, res, op, await readJson(req));
  /** `api path → method → handler`; an unknown pair is a 404. */
  const apiRoutes: Record<string, Partial<Record<string, Handler>>> = {
    hello: { GET: json(async () => deps.hello()) },
    file: { GET: readFile, HEAD: readFile, PUT: (req, res, url) => files.writeFile(req, res, url) },
    manifest: { GET: json(() => files.manifest()) },
    hash: { POST: json(async req => files.hashPaths(await readJson(req))) },
    mkdir: { POST: jsonMutation('mkdir') },
    delete: { POST: jsonMutation('delete') },
    move: { POST: jsonMutation('move') },
    changeset: { POST: (req, res) => files.writeChangeset(req, res) },
    history: { GET: json((_req, url) => files.historyList(url)) },
    'history/version': { GET: historyVersion, HEAD: historyVersion },
    'history/record': {
      POST: json(async req => ({ ...(await files.historyRecord(await readJson(req))) })),
    },
    'history/restore': { POST: (req, res) => files.historyRestore(req, res) },
    'handover/claim': {
      POST: json(async req => {
        const claimed = await files.claim((await readJson(req)).writerId);
        deps.socket.broadcast({ type: 'pix3:writer', writerId: claimed.writerId });
        return claimed;
      }),
    },
    sync: { POST: json(async req => deps.barrier.sync(parseSyncRequest(await readJson(req)))) },
    flush: {
      POST: json(async req =>
        deps.barrier.flush(parseTimeout((await readJson(req)).timeoutMs, DEFAULT_SYNC_TIMEOUT_MS))
      ),
    },
  };

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
      const page = deps.editorPage(editorSessionFor(req, deps.sessionToken));
      res.writeHead(page.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // A window the game opens on the editor gets no handle into it (the session token, the
        // host object): another page's popup with a different policy lands in its own group.
        // `-allow-popups` keeps the editor's own game pop-out scriptable.
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
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

    if (api === 'keys' || api.startsWith('proxy/')) {
      deps.guard.checkEditorOnly(req, `${prefix}/`, deps.sessionToken);
      if (method === 'GET' && api === 'keys') {
        await deps.imageProxy.keyStatus(res);
        return;
      }
      if (method === 'PUT' && api === 'keys') {
        await deps.imageProxy.setKey(req, res);
        return;
      }
      if (api.startsWith('proxy/')) {
        await deps.imageProxy.forward(req, res, api.slice('proxy/'.length));
        return;
      }
      throw new HttpError(405, 'method', 'GET or PUT.');
    }
    const handler = Object.hasOwn(apiRoutes, api) ? apiRoutes[api][method] : undefined;
    if (handler) {
      await handler(req, res, url, method === 'HEAD');
      return;
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  };

  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (isProjectStatePath(url.pathname)) {
      // `.pix3/` is the plugin's and the CLI's state (dev.json, the journal, local keys), not a
      // static asset of the game.
      req.resume();
      sendJson(res, 404, { error: 'not_found', message: 'Not found.' });
      return;
    }
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

/**
 * Any `.pix3` segment, however the browser spelled it (`%2e`, case): the project's own `.pix3/`
 * at the root, by `/@fs/<abs>/.pix3/…`, and `~/.pix3` should `fs.allow` ever reach the home.
 */
const isProjectStatePath = (pathname: string): boolean => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return decoded.split('/').some(segment => segment.toLowerCase() === '.pix3');
};
