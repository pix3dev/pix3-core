import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { isRecord } from './http.ts';

/**
 * The editor's own WebSocket, `/__pix3/ws` (plan §B.2, variant B): the editor page carries no
 * `/@vite/client`, so neither Vite's `full-reload` nor its reload-after-reconnect ever reaches
 * it. Everything the plugin tells the page — file changes, "re-import your scripts", "flush" —
 * goes over this socket.
 *
 * Client → plugin: `{type:'hello', tabId}` once, then `{type:'reply', id, ...}` answers.
 * Plugin → client: `{type:'welcome', ...}`, broadcast frames (`pix3:fs`, `pix3:writer`,
 * `pix3:scripts`), and requests `{type:'request', id, kind, ...}` that the tab answers by `id`.
 */

export interface EditorTab {
  readonly tabId: string;
  readonly connectedAt: number;
}

export type RequestReply = Record<string, unknown> & { readonly ok: boolean };

interface Pending {
  readonly tabId: string;
  readonly resolve: (reply: RequestReply) => void;
  readonly timer: NodeJS.Timeout;
}

interface Connection {
  readonly socket: WebSocket;
  tab: EditorTab | null;
}

const TAB_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface EditorSocketOptions {
  /** URL path of the socket (`<base>__pix3/ws`). */
  readonly path: string;
  /** Throws to refuse the upgrade (host, peer address, origin — `RequestGuard`). */
  readonly accept: (req: IncomingMessage) => void;
  /** First frame a tab gets after its `hello`. */
  readonly welcome: (tab: EditorTab) => Record<string, unknown>;
  readonly log?: (line: string) => void;
  readonly onTabsChanged?: () => void;
}

export class EditorSocket {
  private readonly options: EditorSocketOptions;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<Connection>();
  private readonly pending = new Map<string, Pending>();

  constructor(options: EditorSocketOptions) {
    this.options = options;
  }

  /** `httpServer.on('upgrade')` handler; returns false for upgrades that are not ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== this.options.path) return false;
    try {
      this.options.accept(req);
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.adopt(ws));
    return true;
  }

  /** Connected editor tabs, oldest first. */
  tabs(): EditorTab[] {
    const out: EditorTab[] = [];
    for (const connection of this.connections) if (connection.tab) out.push(connection.tab);
    return out.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  hasTab(tabId: string): boolean {
    return this.tabs().some(tab => tab.tabId === tabId);
  }

  broadcast(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    for (const connection of this.connections) {
      if (connection.tab) connection.socket.send(text);
    }
  }

  /**
   * Ask one tab to do something and wait for its answer. Never rejects: a missing tab, a closed
   * socket or silence become `{ok:false, reason:'no_tab'|'tab_closed'|'timeout'}`.
   */
  request(
    tabId: string,
    kind: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<RequestReply> {
    const connection = [...this.connections].find(c => c.tab?.tabId === tabId);
    if (!connection) return Promise.resolve({ ok: false, reason: 'no_tab', tabId });
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: 'timeout', tabId });
      }, timeoutMs);
      this.pending.set(id, { tabId, resolve, timer });
      connection.socket.send(JSON.stringify({ type: 'request', id, kind, ...payload }));
    });
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'tab_closed', tabId: pending.tabId });
      this.pending.delete(id);
    }
    for (const connection of this.connections) connection.socket.terminate();
    this.connections.clear();
    this.wss.close();
  }

  private adopt(socket: WebSocket): void {
    const connection: Connection = { socket, tab: null };
    this.connections.add(connection);
    socket.on('message', (raw: RawData) => this.onMessage(connection, raw));
    socket.on('close', () => this.drop(connection));
    socket.on('error', () => this.drop(connection));
  }

  private drop(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    const tabId = connection.tab?.tabId;
    if (!tabId) return;
    for (const [id, pending] of this.pending) {
      if (pending.tabId !== tabId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ ok: false, reason: 'tab_closed', tabId });
    }
    this.options.log?.(`editor tab ${tabId} disconnected`);
    this.options.onTabsChanged?.();
  }

  private onMessage(connection: Connection, raw: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === 'hello') {
      const tabId = message.tabId;
      if (connection.tab || typeof tabId !== 'string' || !TAB_ID_PATTERN.test(tabId)) return;
      connection.tab = { tabId, connectedAt: Date.now() };
      connection.socket.send(
        JSON.stringify({ type: 'welcome', ...this.options.welcome(connection.tab) })
      );
      this.options.log?.(`editor tab ${tabId} connected`);
      this.options.onTabsChanged?.();
      return;
    }
    if (message.type === 'reply' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending || pending.tabId !== connection.tab?.tabId) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const { type: _type, id: _id, ...rest } = message;
      pending.resolve({ ...rest, ok: rest.ok === true });
    }
  }
}
