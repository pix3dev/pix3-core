import type { SavedSceneDocument } from '@pix3/runtime';
import { inject, injectable } from '@/fw/di';
import {
  isEmptyFlushLedger,
  type FlushedKey,
  type FlushedNode,
  type FlushLedger,
} from '@/core/scene-patch/scene-merge';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { SceneMergeService } from '@/services/project/SceneMergeService';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';

/** The flush ledger of one scene as kept between sessions, with the version it ended with. */
export interface LedgerRecord {
  /** `<projectId>\0<path>`. */
  readonly key: string;
  readonly projectId: string;
  readonly path: string;
  /** Sha of the editor's last write the ledger covers (the baseline after it). */
  readonly sha: string;
  /** Norm of that write: an added node an external version dropped is restored from it. */
  readonly norm: SavedSceneDocument;
  readonly keys: ReadonlyArray<readonly [string, FlushedKey]>;
  readonly nodes: ReadonlyArray<readonly [string, FlushedNode]>;
  readonly at: number;
}

/** Where ledgers live; resolves once the write is durable. */
export interface LedgerStore {
  put(record: LedgerRecord): Promise<void>;
  get(key: string): Promise<LedgerRecord | null>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'pix3-flush-ledgers';
const STORE = 'ledgers';

export class IndexedDbLedgerStore implements LedgerStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest
  ): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve((request.result as T | undefined) ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('ledger transaction aborted'));
    });
  }

  async put(record: LedgerRecord): Promise<void> {
    await this.run('readwrite', store => store.put(record));
  }

  get(key: string): Promise<LedgerRecord | null> {
    return this.run<LedgerRecord>('readonly', store => store.get(key));
  }

  async delete(key: string): Promise<void> {
    await this.run('readwrite', store => store.delete(key));
  }
}

/** For specs and for a browser without IndexedDB. */
export class MemoryLedgerStore implements LedgerStore {
  readonly records = new Map<string, LedgerRecord>();
  async put(record: LedgerRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record));
  }
  async get(key: string): Promise<LedgerRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }
  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

/**
 * The flush ledger (W17, W25) outlives the tab (1.x kept its protected set in
 * `.pix3/protected.json`): an agent that writes a stale read after the tab was closed or reloaded
 * is still caught.
 *
 * - The writer tab stores a scene's ledger after every flush that records into it, with the sha
 *   and norm of that write; an external version that spends the ledger deletes it.
 * - When a scene gets its baseline (opened in this tab), its stored ledger is looked up: the disk
 *   still holds that write → the ledger is adopted and goes on as if the tab had never closed;
 *   the disk holds something else → it came while no tab had the scene, and the opened version is
 *   checked like any external one ("An agent overwrote your edit [Restore my edit]"), then the
 *   stored ledger is spent.
 *
 * A read-only tab neither stores nor adopts: the writer owns the ledger.
 */
@injectable()
export class FlushLedgerStoreService {
  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @inject(SceneMergeService)
  private readonly merges!: SceneMergeService;

  private store: LedgerStore = FlushLedgerStoreService.defaultStore();
  /** Paths whose stored ledger was looked at since they got their baseline. */
  private readonly opened = new Set<string>();
  /** Per path: the last store operation (the lookup on open first), so writes land in order. */
  private readonly queue = new Map<string, Promise<void>>();
  private disposers: Array<() => void> = [];

  static defaultStore(): LedgerStore {
    return typeof indexedDB === 'undefined' ? new MemoryLedgerStore() : new IndexedDbLedgerStore();
  }

  /** Specs: an in-memory store. */
  useStore(store: LedgerStore): void {
    this.store = store;
  }

  start(): void {
    if (this.disposers.length > 0) return;
    this.disposers.push(
      this.baselines.onLedgerChange(path => this.save(path)),
      this.baselines.subscribe(() => this.checkOpenedScenes()),
      subscribe(appState.scenes, () => this.checkOpenedScenes())
    );
    this.checkOpenedScenes();
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.opened.clear();
  }

  /** Resolves when every store operation queued so far has finished (specs). */
  async idle(): Promise<void> {
    while (this.queue.size > 0) await Promise.all([...this.queue.values()]);
  }

  private enqueue(path: string, work: () => Promise<void>): void {
    const previous = this.queue.get(path) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch(error => console.warn('[FlushLedgerStoreService]', path, error))
      .finally(() => {
        if (this.queue.get(path) === next) this.queue.delete(path);
      });
    this.queue.set(path, next);
  }

  private save(path: string): void {
    const projectId = appState.project.id;
    if (!projectId || appState.project.host.writer === 'other') return;
    // What the ledger is now, and the write it ended with — taken now, stored in order.
    const ledger = this.baselines.flushLedger(path);
    const baseline = this.baselines.get(path);
    const key = ledgerKey(projectId, path);
    this.enqueue(path, () =>
      isEmptyFlushLedger(ledger) || !baseline
        ? this.store.delete(key)
        : this.store.put({
            key,
            projectId,
            path,
            sha: baseline.sha,
            norm: baseline.norm,
            keys: [...ledger.keys],
            nodes: [...ledger.nodes],
            at: Date.now(),
          })
    );
  }

  private checkOpenedScenes(): void {
    for (const path of [...this.opened]) if (!this.baselines.get(path)) this.opened.delete(path);
    const projectId = appState.project.id;
    if (!projectId || appState.project.host.writer === 'other') return;
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      if (!descriptor.filePath.startsWith('res://')) continue;
      const path = toProjectPath(descriptor.filePath);
      const opened = this.baselines.get(path);
      if (this.opened.has(path) || !opened) continue;
      this.opened.add(path);
      const sceneId = descriptor.id;
      this.enqueue(path, async () => {
        const key = ledgerKey(projectId, path);
        const record = await this.store.get(key);
        if (!record) return;
        const ledger: FlushLedger = { keys: new Map(record.keys), nodes: new Map(record.nodes) };
        if (record.sha === opened.sha) {
          this.baselines.adoptFlushLedger(path, ledger);
          return;
        }
        const scene = appState.scenes.descriptors[sceneId];
        if (scene) this.merges.offerStaleRestore(scene, ledger, record.norm);
        await this.store.delete(key);
      });
    }
  }
}

const ledgerKey = (projectId: string, path: string): string => `${projectId}\u0000${path}`;
