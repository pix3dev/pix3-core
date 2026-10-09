import { HostFileError, HostFilesClient } from './host-files.ts';

export { HostFileError, HostFilesClient } from './host-files.ts';

/**
 * Page side of the plugin (plan §B.2 variant B, §B.3 step 4): runs in the editor tab, imported by
 * `virtual:pix3/editor-host`. It owns the `/__pix3/ws` connection, answers the plugin's `sync`
 * and `flush` requests, and is the `EditorHost` the editor mounts against.
 *
 * Contract B (S1, finding 3): nothing in the editor's chain may make Vite inject `/@vite/client`
 * — no `import.meta.hot`, no CSS imports, no non-literal `import()`. The one dynamic import this
 * file needs (re-importing the script roots with a fresh `?t=`) goes through `Function`, which
 * Vite's import analysis does not see.
 */

export interface ScriptRoots {
  readonly editorScripts: RootModule;
  readonly botPolicies: RootModule;
}

export interface RootModule {
  readonly __pix3Revision: number;
  readonly modules: Record<string, Record<string, unknown>>;
}

export interface FsFrame {
  readonly type: 'pix3:fs';
  readonly seq: number;
  readonly revision: string;
  readonly events: readonly {
    readonly op: 'create' | 'modify' | 'delete' | 'rename';
    readonly path: string;
    readonly kind: 'file' | 'dir';
    readonly sha256?: string;
    readonly from?: string;
    readonly author: 'editor' | 'external';
  }[];
  readonly writerId?: string;
}

export type HookReply = { readonly ok: boolean; readonly reason?: string } & Record<
  string,
  unknown
>;

export interface SyncInfo {
  readonly rev: number;
  /** `{path: sha256 | null}` — what the rescan found changed (null = deleted). */
  readonly changed: Record<string, string | null>;
  readonly roots: ScriptRoots;
}

/** What the editor plugs in. Every hook is optional: an absent one is a no-op that succeeds. */
export interface HostSyncHandlers {
  /** Write dirty scenes now (plan §C.1); waits for pointerup up to `timeoutMs`. */
  flush?(timeoutMs: number): Promise<HookReply>;
  /**
   * The roots were re-imported for a sync: register the new script classes, reload changed
   * scenes. While play runs, answer `{ok:false, reason:'stale', playing, pending}` (plan §B.3).
   */
  applySync?(info: SyncInfo): Promise<HookReply>;
}

export interface HostOptions {
  /** Vite `base` (always ends with `/`). */
  readonly base: string;
  /** The roots as the page first imported them (static imports of `editor-host`). */
  readonly roots: ScriptRoots;
}

export interface HostVersions {
  readonly plugin: string;
  readonly runtime: string | null;
  readonly editorCore: string | null;
  readonly vite: string;
}

/** The plugin's `welcome` frame (re-sent after every reconnect). */
export interface Hello {
  readonly tabId: string;
  readonly seq: number;
  readonly revision: string;
  readonly writerId: string | null;
  readonly root: string;
  readonly resRoot: string;
  readonly projectName: string;
  readonly versions: HostVersions;
}

export interface HostInfo {
  readonly base: string;
  readonly root: string;
  readonly resRoot: string;
  readonly projectName: string;
  readonly tabId: string;
  readonly seq: number;
  readonly revision: string;
  readonly versions: HostVersions;
}

export interface HostClaim {
  readonly writerId: string;
  readonly seq: number;
  readonly revision: string;
  readonly hashes: Record<string, string>;
}

type Listener<T> = (value: T) => void;

const subscribe = <T>(set: Set<Listener<T>>, listener: Listener<T>): (() => void) => {
  set.add(listener);
  return () => set.delete(listener);
};

const dynamicImport = new Function('url', 'return import(url)') as (
  url: string
) => Promise<unknown>;

const rootUrl = (base: string, id: string): string =>
  // Vite strips only `t=\d{13}` from a module URL; anything else would not resolve (S1, finding 4).
  `${base}@id/__x00__${id}?t=${String(Date.now()).padStart(13, '0')}`;

const newTabId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * True when Vite's HMR client got onto this page — contract B is broken and a `full-reload` can
 * reach the editor. Checked once at load and reported, never silently tolerated.
 */
export const viteClientLoaded = (): boolean =>
  performance
    .getEntriesByType('resource')
    .some(entry => new URL(entry.name, location.href).pathname.endsWith('/@vite/client'));

/**
 * The page's `EditorHost` (`@pix3/editor-core` defines the contract, `.plans/editor-core-port.md`
 * §1): what `mountEditor(el, host)` talks to. Structural — the type lives in editor-core and this
 * package only checks conformance in a spec, so no runtime edge exists between the two.
 */
export class EditorHostConnection {
  readonly tabId = newTabId();
  readonly base: string;
  readonly files: HostFilesClient;
  readonly events: {
    onFs(listener: Listener<FsFrame>): () => void;
    onConnection(listener: Listener<'open' | 'closed'>): () => void;
  };
  readonly scripts: {
    current(): ScriptRoots;
    onChange(listener: Listener<ScriptRoots>): () => void;
  };
  readonly sync: {
    setHandlers(handlers: HostSyncHandlers): void;
    run(options?: { expect?: Record<string, string>; timeoutMs?: number }): Promise<HookReply>;
  };
  readonly writer: {
    readonly id: string | null;
    readonly isSelf: boolean;
    claim(): Promise<HostClaim>;
    onChange(listener: Listener<string | null>): () => void;
  };

  private roots: ScriptRoots;
  private handlers: HostSyncHandlers = {};
  private socket: WebSocket | null = null;
  private hello: Hello | null = null;
  /** Tab the plugin says may write (from `welcome` and `pix3:writer`). */
  private writerTab: string | null = null;
  private readonly helloWaiters: ((hello: Hello) => void)[] = [];
  private readonly fsListeners = new Set<Listener<FsFrame>>();
  private readonly connectionListeners = new Set<Listener<'open' | 'closed'>>();
  private readonly scriptListeners = new Set<Listener<ScriptRoots>>();
  private readonly writerListeners = new Set<Listener<string | null>>();
  private retryMs = 250;
  private closed = false;

  constructor(options: HostOptions) {
    this.base = options.base;
    this.roots = options.roots;
    this.files = new HostFilesClient(this);
    this.events = {
      onFs: listener => subscribe(this.fsListeners, listener),
      onConnection: listener => subscribe(this.connectionListeners, listener),
    };
    this.scripts = {
      current: () => this.roots,
      onChange: listener => subscribe(this.scriptListeners, listener),
    };
    this.sync = {
      setHandlers: handlers => {
        this.handlers = handlers;
      },
      run: options => this.runSync(options),
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const connection = this;
    this.writer = {
      get id() {
        return connection.writerTab;
      },
      get isSelf() {
        return connection.writerTab === connection.tabId;
      },
      claim: () => this.claim(),
      onChange: listener => subscribe(this.writerListeners, listener),
    };
  }

  /** Filled from the plugin's `welcome`; available once {@link ready} resolved. */
  get info(): HostInfo {
    const hello = this.hello;
    if (!hello) throw new Error('The editor host is not connected yet (await host.ready()).');
    return {
      base: this.base,
      root: hello.root,
      resRoot: hello.resRoot,
      projectName: hello.projectName,
      tabId: this.tabId,
      seq: hello.seq,
      revision: hello.revision,
      versions: hello.versions,
    };
  }

  get currentRoots(): ScriptRoots {
    return this.roots;
  }

  /** Resolves with the plugin's `welcome` (re-sent after every reconnect). */
  ready(): Promise<Hello> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise(resolve => this.helloWaiters.push(resolve));
  }

  connect(): void {
    if (this.closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}${this.base}__pix3/ws`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.retryMs = 250;
      socket.send(JSON.stringify({ type: 'hello', tabId: this.tabId }));
    });
    socket.addEventListener('message', event => {
      void this.onMessage(String(event.data));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.emit(this.connectionListeners, 'closed');
      if (this.closed) return;
      // The dev server died or restarted: keep editing in memory and try again (plan §C.3).
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5_000);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  /** `fetch` against `/__pix3/api/<route>` with the headers mutations need. */
  async api(route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('X-Pix3', '1');
      headers.set('X-Pix3-Writer', this.tabId);
    }
    return fetch(`${this.base}__pix3/api/${route}`, { ...init, headers });
  }

  /** Become the writer (plan §C.3 step 2): the plugin answers with the disk to start from. */
  private async claim(): Promise<HostClaim> {
    const response = await this.api('handover/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writerId: this.tabId }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new HostFileError({
        code: 'other',
        status: response.status,
        message: typeof body.message === 'string' ? body.message : 'Claim refused.',
      });
    }
    this.setWriter(this.tabId);
    return body as unknown as HostClaim;
  }

  /**
   * `pix3_sync` from this tab: flush first (this tab's own handler), then the plugin's barrier
   * with this tab as the one that confirms.
   */
  private async runSync(
    options: { expect?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<HookReply> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const flushed = this.handlers.flush ? await this.handlers.flush(timeoutMs) : { ok: true };
    if (!flushed.ok) return { ...flushed, ok: false, step: 'flush' };
    const response = await this.api('sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect: options.expect, timeoutMs, tabId: this.tabId }),
    });
    return (await response.json()) as HookReply;
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('[pix3] host listener failed', error);
      }
    }
  }

  private setWriter(writerId: string | null): void {
    if (writerId === this.writerTab) return;
    this.writerTab = writerId;
    this.emit(this.writerListeners, writerId);
  }

  private async reimportRoots(): Promise<ScriptRoots> {
    const [editorScripts, botPolicies] = await Promise.all([
      dynamicImport(rootUrl(this.base, 'virtual:pix3/editor-scripts')),
      dynamicImport(rootUrl(this.base, 'virtual:pix3/bot-policies')),
    ]);
    this.roots = {
      editorScripts: editorScripts as RootModule,
      botPolicies: botPolicies as RootModule,
    };
    return this.roots;
  }

  private executed(): Record<string, string> {
    const stamps = (globalThis as { __pix3Executed?: Record<string, string> }).__pix3Executed;
    return { ...(stamps ?? {}) };
  }

  private reply(id: string, body: HookReply): void {
    this.socket?.send(JSON.stringify({ type: 'reply', id, ...body }));
  }

  private async onMessage(text: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'welcome': {
        const hello = { ...message, tabId: this.tabId } as unknown as Hello;
        this.hello = hello;
        this.setWriter(hello.writerId);
        this.emit(this.connectionListeners, 'open');
        for (const waiter of this.helloWaiters.splice(0)) waiter(hello);
        return;
      }
      case 'pix3:fs':
        this.emit(this.fsListeners, message as unknown as FsFrame);
        return;
      case 'pix3:writer':
        this.setWriter(typeof message.writerId === 'string' ? message.writerId : null);
        return;
      case 'pix3:scripts':
        this.emit(this.scriptListeners, await this.reimportRoots());
        return;
      case 'request':
        await this.onRequest(message);
        return;
      default:
        return;
    }
  }

  private async onRequest(message: Record<string, unknown>): Promise<void> {
    const id = String(message.id);
    try {
      if (message.kind === 'flush') {
        const timeoutMs = typeof message.timeoutMs === 'number' ? message.timeoutMs : 10_000;
        this.reply(id, this.handlers.flush ? await this.handlers.flush(timeoutMs) : { ok: true });
        return;
      }
      if (message.kind === 'sync') {
        const roots = await this.reimportRoots();
        const changed = (message.changed ?? {}) as Record<string, string | null>;
        const rev = roots.editorScripts.__pix3Revision;
        const applied = this.handlers.applySync
          ? await this.handlers.applySync({ rev, changed, roots })
          : { ok: true };
        this.reply(id, { ...applied, rev, executed: this.executed() });
        return;
      }
      this.reply(id, { ok: false, reason: 'unknown_request' });
    } catch (error) {
      this.reply(id, {
        ok: false,
        reason: 'page_error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
