import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex, Readable, Writable } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { cdpProof, readChallenge } from './cdp-proof.ts';
import { CDP_PROOF_HEADER, CDP_PROXY_HEADER, CDP_PROXY_PATH, CDP_PROXY_PROTOCOL } from './paths.ts';

/**
 * The CDP token proxy (plan §D.5). `pix3 editor` owns Chrome through `--remote-debugging-pipe`
 * — Chrome opens no debugging port at all — and this proxy is the only way in:
 *
 * - `ws://127.0.0.1:<port>/pix3` — a browser-level CDP connection (chrome-devtools-mcp's
 *   `--wsEndpoint`); `ws://…/pix3/page/<targetId>` — a page-level one (what `/json/list` hands
 *   out, for raw CDP clients);
 * - `GET /json/version`, `/json/list` (`/json`) — tab discovery, as Chrome answers them;
 * - every request needs `Authorization: Bearer <~/.pix3/cdp-token>`, a loopback `Host` and no
 *   `Origin` (a web page always sends one; CDP clients do not) — otherwise 401/403, and a
 *   WebSocket upgrade is refused before it is accepted;
 * - a request with `X-Pix3-Challenge: <nonce>` gets `X-Pix3-Proof` on its answer, refusals
 *   included (`cdp-proof.ts`): a client proves the listener knows the token before it sends the
 *   token — what a forwarded port on a shared host needs (Remote SSH, plan §E.3).
 *
 * Several clients share the one pipe. Each gets its own root session — the browser target
 * through `Target.attachToBrowserTarget` (its own auto-attach and discovery state, its own child
 * sessions), or the page through `Target.attachToTarget {flatten}` — and the proxy routes by
 * session: a client's message without `sessionId` goes to its root session, a `sessionId` it
 * does not own is refused the way Chrome refuses an unknown one, events go to the client owning
 * their session, and child sessions are learnt from `Target.attachedToTarget` /
 * `Target.detachedFromTarget`. Message ids are remapped to one counter of the pipe and back.
 * A client that disconnects is detached (Chrome detaches its child sessions with it); a page
 * whose target closes closes its client; the pipe closing (Chrome gone) closes every client.
 */

/** A screenshot of a 4K window as base64 JSON is ~30 MB; Chrome itself allows 256 MB. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/** One CDP message, as far as the proxy reads it. */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** The pipe to Chrome: one JSON message per call, and the messages Chrome writes back. */
export interface CdpPipe {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
}

/**
 * Chrome's `--remote-debugging-pipe` framing over its fds 3 (we write) and 4 (we read):
 * UTF-8 JSON messages, each terminated by a NUL byte.
 */
export const pipeFromStreams = (toChrome: Writable, fromChrome: Readable): CdpPipe => {
  const messageListeners: Array<(message: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  let pending: Buffer[] = [];
  let closed = false;
  fromChrome.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end >= 0; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString('utf8');
      pending = [];
      for (const listener of messageListeners) listener(text);
      start = end + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  fromChrome.on('end', close);
  fromChrome.on('close', close);
  fromChrome.on('error', close);
  toChrome.on('error', close);
  return {
    send: message => {
      if (!closed) toChrome.write(`${message}\0`);
    },
    onMessage: listener => void messageListeners.push(listener),
    onClose: listener => void closeListeners.push(listener),
  };
};

interface Client {
  readonly socket: WebSocket;
  /** The session the client's session-less messages go to (browser or page). */
  readonly root: string;
  /** Every session the client may address: the root and the children it attached. */
  readonly sessions: Set<string>;
  closed: boolean;
}

type Pending =
  | { readonly client: Client; readonly id: number }
  | { readonly internal: (message: CdpMessage) => void };

export interface CdpProxyOptions {
  readonly pipe: CdpPipe;
  readonly token: string;
  /** One line per accepted / refused connection (the owner's log). */
  readonly log?: (line: string) => void;
}

type Refusal = { readonly status: number; readonly message: string };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Close with a code, and do not wait on the peer: a client that never answers the close frame
 * (its process is gone) would otherwise keep the owner alive for ws's 30 s close timeout.
 */
const hangUp = (socket: WebSocket, code: number, reason: string): void => {
  socket.close(code, reason);
  setTimeout(() => socket.terminate(), 1_000).unref();
};

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export class CdpProxy {
  readonly #pipe: CdpPipe;
  readonly #tokenDigest: Buffer;
  readonly #token: string;
  readonly #log: (line: string) => void;
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  readonly #pending = new Map<number, Pending>();
  /** Session id → the client owning it. */
  readonly #owners = new Map<string, Client>();
  readonly #clients = new Set<Client>();
  readonly #closeListeners: Array<() => void> = [];
  #nextId = 1;
  #pipeClosed = false;
  #version: Record<string, unknown> | null = null;

  constructor(options: CdpProxyOptions) {
    this.#pipe = options.pipe;
    this.#tokenDigest = digest(options.token);
    this.#token = options.token;
    this.#log = options.log ?? (() => {});
    this.#wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    this.#server = createServer((req, res) => void this.#onHttp(req, res));
    this.#server.on('upgrade', (req, socket, head) => void this.#onUpgrade(req, socket, head));
    this.#pipe.onMessage(message => this.#fromChrome(message));
    this.#pipe.onClose(() => this.#onPipeClosed());
  }

  /** Clients connected now. */
  get clientCount(): number {
    return this.#clients.size;
  }

  /** Listen on loopback; resolves with the port (0 picks a free one). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        const address = this.#server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  /** Called once Chrome's end of the pipe is gone (every client is closed by then). */
  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  /** A CDP command of the proxy itself (its own id, never seen by a client). */
  call(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.#pipeClosed) {
        reject(new Error(`${method}: Chrome is gone`));
        return;
      }
      const id = this.#nextId++;
      this.#pending.set(id, {
        internal: message =>
          message.error
            ? reject(new Error(`${method}: ${message.error.message}`))
            : resolve(message.result ?? {}),
      });
      this.#pipe.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Stop listening and close every client; Chrome and the pipe are the owner's to end. */
  async close(): Promise<void> {
    for (const client of [...this.#clients]) {
      this.#drop(client, !this.#pipeClosed);
      hangUp(client.socket, 1001, 'proxy closing');
    }
    await new Promise<void>(resolve => {
      this.#server.close(() => resolve());
      // Keep-alive discovery requests (fetch keeps its sockets) would hold close() open.
      this.#server.closeAllConnections();
    });
    this.#wss.close();
  }

  // --- auth ------------------------------------------------------------------------------------

  #refusal(req: IncomingMessage): Refusal | null {
    if (req.headers.origin !== undefined) {
      return { status: 403, message: 'CDP is not open to web pages (Origin header present)' };
    }
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1)
      : host.split(':')[0];
    if (!LOOPBACK_HOSTS.has(hostname)) {
      return { status: 403, message: `Host "${host}" is not a loopback address` };
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!match || !timingSafeEqual(digest(match[1]), this.#tokenDigest)) {
      return {
        status: 401,
        message: match
          ? 'wrong token (the proxy expects the one in ~/.pix3/cdp-token)'
          : 'missing "Authorization: Bearer <token>" (the token is in ~/.pix3/cdp-token)',
      };
    }
    return null;
  }

  // --- HTTP discovery --------------------------------------------------------------------------

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = this.#refusal(req);
    const challenge = readChallenge(req.headers);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=UTF-8',
        [CDP_PROXY_HEADER]: String(CDP_PROXY_PROTOCOL),
        ...(challenge ? { [CDP_PROOF_HEADER]: cdpProof(this.#token, challenge) } : {}),
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="pix3"' } : {}),
      });
      res.end(JSON.stringify(body, null, 2));
    };
    if (refusal) {
      this.#log(`refused ${req.method} ${req.url}: ${refusal.message}`);
      reply(refusal.status, { error: refusal.message });
      return;
    }
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
    const wsBase = `ws://${req.headers.host}${CDP_PROXY_PATH}`;
    try {
      if (req.method === 'GET' && path === '/json/version') {
        reply(200, { ...(await this.#browserVersion()), webSocketDebuggerUrl: wsBase });
      } else if (req.method === 'GET' && (path === '/json' || path === '/json/list')) {
        reply(200, await this.#targets(wsBase));
      } else {
        reply(404, { error: `no ${req.method} ${path} here (only /json/version and /json/list)` });
      }
    } catch (error) {
      reply(502, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #browserVersion(): Promise<Record<string, unknown>> {
    if (!this.#version) {
      const v = await this.call('Browser.getVersion');
      this.#version = {
        Browser: v.product,
        'Protocol-Version': v.protocolVersion,
        'User-Agent': v.userAgent,
        'V8-Version': v.jsVersion,
        'WebKit-Version': v.revision,
        'Pix3-Cdp-Proxy': CDP_PROXY_PROTOCOL,
      };
    }
    return this.#version;
  }

  async #targets(wsBase: string): Promise<unknown[]> {
    const { targetInfos } = (await this.call('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string; title: string; url: string }>;
    };
    return (targetInfos ?? [])
      .filter(info => info.type !== 'browser' && info.type !== 'tab')
      .map(info => ({
        description: '',
        id: info.targetId,
        title: info.title,
        type: info.type,
        url: info.url,
        webSocketDebuggerUrl: `${wsBase}/page/${info.targetId}`,
      }));
  }

  // --- WebSocket clients -----------------------------------------------------------------------

  async #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, message: string) => {
      this.#log(`refused WebSocket ${req.url}: ${message}`);
      socket.end(
        `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Gateway'}\r\n` +
          `${CDP_PROXY_HEADER}: ${CDP_PROXY_PROTOCOL}\r\nContent-Type: text/plain\r\nConnection: close\r\n` +
          `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
      );
    };
    const refusal = this.#refusal(req);
    if (refusal) {
      refuse(refusal.status, refusal.message);
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    const page = path.startsWith(`${CDP_PROXY_PATH}/page/`)
      ? decodeURIComponent(path.slice(`${CDP_PROXY_PATH}/page/`.length))
      : null;
    if (path !== CDP_PROXY_PATH && !page) {
      refuse(404, `no WebSocket at ${path} (the browser is at ${CDP_PROXY_PATH})`);
      return;
    }
    let root: string;
    try {
      const attached = page
        ? await this.call('Target.attachToTarget', { targetId: page, flatten: true })
        : await this.call('Target.attachToBrowserTarget');
      root = String(attached.sessionId);
    } catch (error) {
      refuse(page ? 404 : 502, error instanceof Error ? error.message : String(error));
      return;
    }
    if (socket.destroyed) {
      void this.call('Target.detachFromTarget', { sessionId: root }).catch(() => {});
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, ws => this.#adopt(ws, root, page));
  }

  #adopt(socket: WebSocket, root: string, page: string | null): void {
    const client: Client = { socket, root, sessions: new Set([root]), closed: false };
    this.#clients.add(client);
    this.#owners.set(root, client);
    this.#log(`client connected (${page ? `page ${page}` : 'browser'}; ${this.#clients.size} now)`);
    socket.on('message', (raw: RawData) => this.#fromClient(client, raw));
    socket.on('close', () => {
      this.#drop(client, true);
      this.#log(`client gone (${this.#clients.size} left)`);
    });
    socket.on('error', () => socket.terminate());
  }

  #fromClient(client: Client, raw: RawData): void {
    if (client.closed) return;
    let message: CdpMessage;
    try {
      message = JSON.parse(raw.toString()) as CdpMessage;
    } catch {
      this.#send(client, { id: 0, error: { code: -32700, message: 'Message must be valid JSON' } });
      return;
    }
    if (
      !message ||
      typeof message !== 'object' ||
      typeof message.id !== 'number' ||
      typeof message.method !== 'string'
    ) {
      this.#send(client, {
        id: typeof message?.id === 'number' ? message.id : 0,
        error: { code: -32600, message: 'Message must have an integer id and a string method' },
      });
      return;
    }
    if (message.sessionId !== undefined && !client.sessions.has(message.sessionId)) {
      // What Chrome answers for a session it does not know — another client's is not this one's.
      this.#send(client, {
        id: message.id,
        error: { code: -32001, message: 'Session with given id not found.' },
        sessionId: message.sessionId,
      });
      return;
    }
    if (this.#pipeClosed) {
      this.#send(client, { id: message.id, error: { code: -32000, message: 'Chrome is gone' } });
      return;
    }
    const id = this.#nextId++;
    this.#pending.set(id, { client, id: message.id });
    this.#pipe.send(
      JSON.stringify({ ...message, id, sessionId: message.sessionId ?? client.root })
    );
  }

  #fromChrome(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if ('internal' in pending) pending.internal(message);
      else if (!pending.client.closed) this.#send(pending.client, { ...message, id: pending.id });
      return;
    }
    const sessionId = message.sessionId;
    if (sessionId === undefined) {
      this.#rootEvent(message);
      return;
    }
    const client = this.#owners.get(sessionId);
    if (!client) return;
    const child = message.params?.sessionId;
    if (typeof child === 'string') {
      if (message.method === 'Target.attachedToTarget') {
        client.sessions.add(child);
        this.#owners.set(child, client);
      } else if (message.method === 'Target.detachedFromTarget') {
        client.sessions.delete(child);
        this.#owners.delete(child);
      }
    }
    this.#send(client, message);
  }

  /** Events of the pipe's own session: only a client's root going away matters. */
  #rootEvent(message: CdpMessage): void {
    if (message.method !== 'Target.detachedFromTarget') return;
    const sessionId = message.params?.sessionId;
    const client = typeof sessionId === 'string' ? this.#owners.get(sessionId) : undefined;
    if (!client || client.root !== sessionId) return;
    // The page closed (or Chrome detached the browser session): as Chrome closes its own socket.
    this.#drop(client, false);
    hangUp(client.socket, 1000, 'target closed');
  }

  #send(client: Client, message: CdpMessage): void {
    if (client.closed) return;
    const out = message.sessionId === client.root ? { ...message, sessionId: undefined } : message;
    client.socket.send(JSON.stringify(out));
  }

  #drop(client: Client, detach: boolean): void {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
    for (const session of client.sessions) {
      if (this.#owners.get(session) === client) this.#owners.delete(session);
    }
    // Detaching the root detaches every child session it attached (measured on Chrome 155).
    if (detach && !this.#pipeClosed) {
      void this.call('Target.detachFromTarget', { sessionId: client.root }).catch(() => {});
    }
  }

  #onPipeClosed(): void {
    if (this.#pipeClosed) return;
    this.#pipeClosed = true;
    for (const [id, pending] of this.#pending) {
      if ('internal' in pending)
        pending.internal({ id, error: { code: -32000, message: 'Chrome is gone' } });
    }
    this.#pending.clear();
    for (const client of [...this.#clients]) {
      this.#drop(client, false);
      hangUp(client.socket, 1001, 'Chrome closed');
    }
    this.#server.close();
    this.#server.closeAllConnections();
    this.#wss.close();
    for (const listener of this.#closeListeners) listener();
  }
}
