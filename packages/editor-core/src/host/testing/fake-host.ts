import type {
  EditorHost,
  HookReply,
  HostClaim,
  HostEvents,
  HostFileErrorCode,
  HostFiles,
  HostFsEvent,
  HostFsFrame,
  HostHistory,
  HostHistoryEntry,
  HostInfo,
  HostManifestEntry,
  HostScripts,
  HostSync,
  HostSyncHandlers,
  HostWriteOptions,
  HostWriteResult,
  HostWriter,
  ScriptRoots,
} from '../EditorHost';

/**
 * In-memory {@link EditorHost} for specs: files in a map, sha256 via WebCrypto, a `pix3:fs`
 * frame on every write (`author: 'editor'`) and on {@link FakeHost.externalWrite}
 * (`author: 'external'`). Conditional writes follow the plugin: `If-Match` mismatch and
 * `createOnly` on an existing file fail like a 412.
 */

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

const encode = (data: Uint8Array | string): Uint8Array =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data;

export class FakeHostError extends Error {
  readonly failure: {
    code: HostFileErrorCode;
    status: number;
    message: string;
    currentHash?: string | null;
  };
  constructor(
    code: HostFileErrorCode,
    status: number,
    message: string,
    currentHash?: string | null
  ) {
    super(message);
    this.failure = { code, status, message, ...(currentHash !== undefined ? { currentHash } : {}) };
  }
}

const emptyRoots = (): ScriptRoots => ({
  editorScripts: { __pix3Revision: 0, modules: {} },
  botPolicies: { __pix3Revision: 0, modules: {} },
});

export interface FakeHostOptions {
  readonly files?: Record<string, string | Uint8Array>;
  readonly resRoot?: string;
  readonly projectName?: string;
  readonly roots?: ScriptRoots;
}

export class FakeHost implements EditorHost {
  readonly info: HostInfo;
  readonly files: HostFiles;
  readonly events: HostEvents;
  readonly scripts: HostScripts;
  readonly sync: HostSync;
  readonly writer: HostWriter;
  readonly history: HostHistory;
  /** Journal entries with their text, newest last (only what `history.record` was given). */
  readonly journal: Array<HostHistoryEntry & { text: string }> = [];

  readonly store = new Map<string, { bytes: Uint8Array; sha256: string; mtime: number }>();
  readonly dirs = new Set<string>();
  readonly frames: HostFsFrame[] = [];
  handlers: HostSyncHandlers = {};
  /** How many changesets were written (each is one frame). */
  changesets = 0;
  private seq = 0;
  private roots: ScriptRoots;
  private writerId: string | null = null;
  private readonly fsListeners = new Set<(frame: HostFsFrame) => void>();
  private readonly connectionListeners = new Set<(state: 'open' | 'closed') => void>();
  private readonly scriptListeners = new Set<(roots: ScriptRoots) => void>();
  private readonly writerListeners = new Set<(id: string | null) => void>();
  private readonly ready: Promise<void>;

  constructor(options: FakeHostOptions = {}) {
    this.roots = options.roots ?? emptyRoots();
    this.info = {
      base: '/',
      root: '/fake/project',
      resRoot: options.resRoot ?? '.',
      projectName: options.projectName ?? 'fake-project',
      tabId: 'fake-tab',
      seq: 0,
      revision: '0'.repeat(64),
      versions: { plugin: '0.0.0', runtime: '0.0.0', editorCore: '0.0.0', vite: '0.0.0' },
    };
    this.ready = (async () => {
      for (const [path, data] of Object.entries(options.files ?? {}))
        await this.put(path, encode(data));
    })();
    // The file API below is a plain object whose methods need the fake's maps.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    this.files = {
      async read(path) {
        await host.ready;
        const entry = host.store.get(path);
        return entry ? { bytes: entry.bytes, sha256: entry.sha256 } : null;
      },
      async readText(path) {
        const read = await this.read(path);
        return read ? new TextDecoder().decode(read.bytes) : null;
      },
      async head(path) {
        await host.ready;
        const entry = host.store.get(path);
        return entry
          ? { sha256: entry.sha256, size: entry.bytes.length, mtime: entry.mtime }
          : null;
      },
      async write(path, data, options: HostWriteOptions = {}): Promise<HostWriteResult> {
        await host.ready;
        const current = host.store.get(path)?.sha256 ?? null;
        if (options.createOnly && current !== null)
          throw new FakeHostError('exists', 412, `${path} already exists.`, current);
        if (options.ifMatch !== undefined) {
          const ok = options.ifMatch === '*' ? current !== null : options.ifMatch === current;
          if (!ok) throw new FakeHostError('base_mismatch', 412, `${path} changed.`, current);
        }
        const bytes = encode(data);
        const existed = current !== null;
        const sha = await host.put(path, bytes);
        const seq = host.emit([
          { op: existed ? 'modify' : 'create', path, kind: 'file', sha256: sha, author: 'editor' },
        ]);
        return { path, sha256: sha, size: bytes.length, seq };
      },
      async writeChangeset(entries) {
        await host.ready;
        for (const entry of entries) {
          const current = host.store.get(entry.path)?.sha256 ?? null;
          const refused =
            (entry.createOnly && current !== null) ||
            (entry.ifMatch !== undefined && entry.ifMatch !== current);
          if (refused) {
            const error = new FakeHostError(
              'base_mismatch',
              412,
              `${entry.path} changed.`,
              current
            );
            Object.assign(error.failure, { path: entry.path });
            throw error;
          }
        }
        const events: HostFsEvent[] = [];
        const files: HostWriteResult[] = [];
        for (const entry of entries) {
          const existed = host.store.has(entry.path);
          const bytes = encode(entry.data);
          const sha = await host.put(entry.path, bytes);
          events.push({
            op: existed ? 'modify' : 'create',
            path: entry.path,
            kind: 'file',
            sha256: sha,
            author: 'editor',
          });
          files.push({ path: entry.path, sha256: sha, size: bytes.length, seq: 0 });
        }
        const seq = host.emit(events);
        host.changesets += 1;
        return { seq, files: files.map(file => ({ ...file, seq })) };
      },
      async mkdir(path) {
        host.addDirs(`${path}/x`);
        host.emit([{ op: 'create', path, kind: 'dir', author: 'editor' }]);
      },
      async delete(path) {
        await host.ready;
        const events: HostFsEvent[] = [];
        for (const key of [...host.store.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) {
            host.store.delete(key);
            events.push({ op: 'delete', path: key, kind: 'file', author: 'editor' });
          }
        }
        if (events.length === 0 && !host.dirs.has(path))
          throw new FakeHostError('not_found', 404, `${path} does not exist.`);
        for (const dir of [...host.dirs])
          if (dir === path || dir.startsWith(`${path}/`)) host.dirs.delete(dir);
        host.emit(events);
      },
      async move(from, to) {
        await host.ready;
        const entry = host.store.get(from);
        if (!entry) throw new FakeHostError('not_found', 404, `${from} does not exist.`);
        host.store.delete(from);
        host.store.set(to, entry);
        host.addDirs(to);
        host.emit([
          { op: 'rename', path: to, from, kind: 'file', sha256: entry.sha256, author: 'editor' },
        ]);
      },
      async manifest() {
        await host.ready;
        const files: HostManifestEntry[] = [
          ...[...host.dirs].map(path => ({ path, kind: 'dir' as const, size: 0, mtime: 0 })),
          ...[...host.store].map(([path, entry]) => ({
            path,
            kind: 'file' as const,
            size: entry.bytes.length,
            mtime: entry.mtime,
            sha256: entry.sha256,
          })),
        ].sort((a, b) => (a.path < b.path ? -1 : 1));
        return { revision: '0'.repeat(64), seq: host.seq, files };
      },
      async hash(paths) {
        await host.ready;
        return Object.fromEntries(paths.map(path => [path, host.store.get(path)?.sha256 ?? null]));
      },
      url: path => `/${path}`,
    };
    this.events = {
      onFs: listener => (this.fsListeners.add(listener), () => this.fsListeners.delete(listener)),
      onConnection: listener => (
        this.connectionListeners.add(listener),
        () => this.connectionListeners.delete(listener)
      ),
    };
    this.scripts = {
      current: () => this.roots,
      onChange: listener => (
        this.scriptListeners.add(listener),
        () => this.scriptListeners.delete(listener)
      ),
    };
    this.sync = {
      setHandlers: handlers => {
        this.handlers = handlers;
      },
      run: async (): Promise<HookReply> => {
        const flushed = this.handlers.flush ? await this.handlers.flush(10_000) : { ok: true };
        if (!flushed.ok) return { ...flushed, ok: false };
        return this.handlers.applySync
          ? this.handlers.applySync({ rev: this.seq, changed: {}, roots: this.roots })
          : { ok: true };
      },
    };
    this.history = this.historyApi();
    this.writer = {
      get id() {
        return host.writerId;
      },
      get isSelf() {
        return host.writerId === host.info.tabId;
      },
      claim: async (): Promise<HostClaim> => {
        this.setWriter(this.info.tabId);
        const hashes: Record<string, string> = {};
        for (const [path, entry] of this.store) hashes[path] = entry.sha256;
        return { writerId: this.info.tabId, seq: this.seq, revision: '0'.repeat(64), hashes };
      },
      onChange: listener => (
        this.writerListeners.add(listener),
        () => this.writerListeners.delete(listener)
      ),
    };
  }

  private historyApi(): HostHistory {
    return {
      list: async path => this.journal.filter(e => e.path === path).reverse(),
      read: async (path, id) =>
        this.journal.find(e => e.path === path && e.id === id)?.text ?? null,
      record: async (path, text, author, note) => {
        const sha = await sha256(encode(text));
        const entry = {
          id: `${Date.now()}-${sha.slice(0, 8)}-${this.journal.length}`,
          path,
          author,
          at: Date.now(),
          sha256: sha,
          size: text.length,
          ...(note ? { note } : {}),
          text,
        };
        this.journal.push(entry);
        return entry;
      },
      restore: async (path, id, options = {}) => {
        const entry = this.journal.find(e => e.path === path && e.id === id);
        if (!entry) throw new FakeHostError('not_found', 404, `${id} not found.`);
        const current = this.store.get(path)?.sha256 ?? null;
        if (options.ifMatch !== undefined && options.ifMatch !== current)
          throw new FakeHostError('base_mismatch', 412, `${path} changed.`, current);
        await this.externalWrite(path, entry.text);
        const stored = this.store.get(path)!;
        return { path, sha256: stored.sha256, size: stored.bytes.length, seq: this.seq };
      },
    };
  }

  /** Resolves once the initial files are hashed. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Another writer (an agent) changes a file on disk. */
  async externalWrite(path: string, data: string | Uint8Array): Promise<void> {
    await this.ready;
    const existed = this.store.has(path);
    const sha = await this.put(path, encode(data));
    this.emit([
      { op: existed ? 'modify' : 'create', path, kind: 'file', sha256: sha, author: 'external' },
    ]);
  }

  setScripts(roots: ScriptRoots): void {
    this.roots = roots;
    for (const listener of this.scriptListeners) listener(roots);
  }

  setWriter(id: string | null): void {
    this.writerId = id;
    for (const listener of this.writerListeners) listener(id);
  }

  setConnection(state: 'open' | 'closed'): void {
    for (const listener of this.connectionListeners) listener(state);
  }

  text(path: string): string | null {
    const entry = this.store.get(path);
    return entry ? new TextDecoder().decode(entry.bytes) : null;
  }

  private async put(path: string, bytes: Uint8Array): Promise<string> {
    const sha = await sha256(bytes);
    this.store.set(path, { bytes, sha256: sha, mtime: Date.now() });
    this.addDirs(path);
    return sha;
  }

  private addDirs(path: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  private emit(events: HostFsEvent[]): number {
    this.seq += 1;
    if (events.length === 0) return this.seq;
    const frame: HostFsFrame = { seq: this.seq, revision: '0'.repeat(64), events };
    this.frames.push(frame);
    for (const listener of this.fsListeners) listener(frame);
    return this.seq;
  }
}
