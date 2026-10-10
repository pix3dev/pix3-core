import { inject, injectable } from '@/fw/di';
import { HostNoticeService } from '@/host/HostNoticeService';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { FlushService } from '@/services/project/FlushService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { SceneJournalService } from '@/services/project/SceneJournalService';
import { SceneMergeService } from '@/services/project/SceneMergeService';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';

/** One checkpoint: the text a flush would write, against the disk version it was made from. */
export interface DraftRecord {
  /** `<projectId>\0<path>` — one draft per scene, the newest checkpoint wins. */
  readonly key: string;
  readonly projectId: string;
  readonly path: string;
  readonly baselineSha: string;
  /**
   * Shas of flushes of this scene that got no answer before the checkpoint: the disk may hold one
   * of them instead of `baselineSha`, and the draft (made on top of them) applies to any.
   */
  readonly unconfirmedShas?: readonly string[];
  readonly text: string;
  /** `nodeDataChangeSignal` of the snapshot. */
  readonly revision: number;
  readonly at: number;
}

/** Where drafts live; resolves only once the write is durable (`transaction.oncomplete`). */
export interface DraftStore {
  put(record: DraftRecord): Promise<void>;
  get(key: string): Promise<DraftRecord | null>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'pix3-drafts';
const STORE = 'drafts';

/** IndexedDB: survives closing the window, unlike `sessionStorage` (plan §C.1). */
export class IndexedDbDraftStore implements DraftStore {
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
    work: (store: IDBObjectStore) => IDBRequest | null
  ): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve((request?.result as T | undefined) ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('draft transaction aborted'));
    });
  }

  async put(record: DraftRecord): Promise<void> {
    await this.run('readwrite', store => store.put(record));
  }

  get(key: string): Promise<DraftRecord | null> {
    return this.run<DraftRecord>('readonly', store => store.get(key));
  }

  async delete(key: string): Promise<void> {
    await this.run('readwrite', store => store.delete(key));
  }
}

/** For specs and for a browser without IndexedDB (private mode can refuse it). */
export class MemoryDraftStore implements DraftStore {
  readonly records = new Map<string, DraftRecord>();
  async put(record: DraftRecord): Promise<void> {
    this.records.set(record.key, record);
  }
  async get(key: string): Promise<DraftRecord | null> {
    return this.records.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

/**
 * The draft of plan §C.1: a recovery copy of what a flush would write, for when the tab dies
 * before the flush (closed window, crashed browser, dead dev server). Not a document.
 *
 * - **Checkpoint** every {@link CHECKPOINT_MS} while a scene is dirty, plus on `pagehide` and
 *   `visibilitychange` → hidden. The guarantee is only the last checkpoint whose transaction
 *   completed; a transaction in flight may be cut by the browser shutting down.
 * - **On open** a draft is offered only if the disk still holds the version it was made from
 *   (`sha` of the disk = the draft's baseline sha, or the sha of a flush that was sent but never
 *   answered — the dev server stopped after writing it); "Restore" applies it and writes it.
 *   Otherwise it goes to the journal as `rejected-draft` with a notice.
 * - A scene flushed clean drops its draft.
 */
@injectable()
export class SceneDraftService {
  @inject(FlushService)
  private readonly flush!: FlushService;

  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @inject(SceneMergeService)
  private readonly merges!: SceneMergeService;

  @inject(SceneJournalService)
  private readonly journal!: SceneJournalService;

  @inject(HostNoticeService)
  private readonly notices!: HostNoticeService;

  static readonly CHECKPOINT_MS = 2_000;

  private store: DraftStore = SceneDraftService.defaultStore();
  /** sceneId → revision of the last durable checkpoint (or of the last flush that cleaned it). */
  private readonly confirmed = new Map<string, number>();
  /** Paths whose stored draft was already looked at this session. */
  private readonly checked = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposers: Array<() => void> = [];
  private checkpointing: Promise<void> | null = null;

  static defaultStore(): DraftStore {
    return typeof indexedDB === 'undefined' ? new MemoryDraftStore() : new IndexedDbDraftStore();
  }

  /** Specs: an in-memory store. */
  useStore(store: DraftStore): void {
    this.store = store;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkpointAll(), SceneDraftService.CHECKPOINT_MS);
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void this.checkpointAll();
    };
    const onPageHide = (): void => void this.checkpointAll();
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onHidden);
    this.disposers.push(
      () => window.removeEventListener('pagehide', onPageHide),
      () => document.removeEventListener('visibilitychange', onHidden),
      this.flush.onFlushed(sceneId => void this.afterFlush(sceneId)),
      subscribe(appState.scenes, () => void this.checkOpenedScenes()),
      this.baselines.subscribe(() => void this.checkOpenedScenes())
    );
    void this.checkOpenedScenes();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.confirmed.clear();
    this.checked.clear();
  }

  /**
   * True when every dirty scene's current state is in a durable checkpoint — closing the tab
   * loses nothing, so the `beforeunload` prompt is not needed.
   */
  isCovered(): boolean {
    const revision = appState.scenes.nodeDataChangeSignal;
    return this.flush.dirtySceneIds().every(id => this.confirmed.get(id) === revision);
  }

  /**
   * A checkpoint of a project file that is not a scene — a locale table whose write got no answer
   * (W22): the text the editor meant to write, against the disk sha it was written on (`''` when
   * the file did not exist). Offered by its owner on the next open the way a scene draft is
   * ({@link draftApplies}); dropped by a write that landed. Nothing without an open project.
   */
  async putFileDraft(path: string, text: string, baselineSha: string): Promise<void> {
    const projectId = appState.project.id;
    if (!projectId) return;
    const key = draftKey(projectId, toProjectPath(path));
    await this.store.put({
      key,
      projectId,
      path: toProjectPath(path),
      baselineSha,
      text,
      revision: 0,
      at: Date.now(),
    });
  }

  async getFileDraft(path: string): Promise<DraftRecord | null> {
    const projectId = appState.project.id;
    if (!projectId) return null;
    return this.store.get(draftKey(projectId, toProjectPath(path))).catch(() => null);
  }

  async dropFileDraft(path: string): Promise<void> {
    const projectId = appState.project.id;
    if (!projectId) return;
    await this.store.delete(draftKey(projectId, toProjectPath(path))).catch(() => undefined);
  }

  /** Whether `draft` was made on the disk version `diskSha` (`''`: no file). */
  static applies(draft: DraftRecord, diskSha: string): boolean {
    return draftApplies(draft, diskSha);
  }

  /** Write a checkpoint of every dirty scene now (one run at a time). */
  checkpointAll(): Promise<void> {
    this.checkpointing ??= this.runCheckpoints().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  private async runCheckpoints(): Promise<void> {
    const projectId = appState.project.id;
    if (!projectId) return;
    for (const sceneId of this.flush.dirtySceneIds()) {
      if (this.confirmed.get(sceneId) === appState.scenes.nodeDataChangeSignal) continue;
      const snap = this.flush.snapshot(sceneId);
      if (!snap) continue;
      const key = draftKey(projectId, snap.path);
      try {
        if (snap.ops.length === 0) await this.store.delete(key);
        else {
          await this.store.put({
            key,
            projectId,
            path: snap.path,
            baselineSha: snap.baseline.sha,
            unconfirmedShas: this.baselines
              .unconfirmedFlushes(snap.path)
              .map(entry => entry.next.sha),
            text: snap.text,
            revision: snap.revision,
            at: Date.now(),
          });
        }
        this.confirmed.set(sceneId, snap.revision);
      } catch (error) {
        console.warn('[SceneDraftService] checkpoint failed', snap.path, error);
      }
    }
  }

  private async afterFlush(sceneId: string): Promise<void> {
    const descriptor = appState.scenes.descriptors[sceneId];
    const projectId = appState.project.id;
    if (!descriptor || descriptor.isDirty || !projectId) return;
    this.confirmed.set(sceneId, appState.scenes.nodeDataChangeSignal);
    await this.store
      .delete(draftKey(projectId, toProjectPath(descriptor.filePath)))
      .catch(() => undefined);
  }

  /** A scene that just got its first baseline this session: is there a draft for it? */
  private async checkOpenedScenes(): Promise<void> {
    const projectId = appState.project.id;
    if (!projectId) return;
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      if (!descriptor.filePath.startsWith('res://')) continue;
      const path = toProjectPath(descriptor.filePath);
      if (this.checked.has(path) || !this.baselines.get(path)) continue;
      this.checked.add(path);
      await this.offer(projectId, descriptor.id, path);
    }
  }

  private async offer(projectId: string, sceneId: string, path: string): Promise<void> {
    const key = draftKey(projectId, path);
    const draft = await this.store.get(key).catch(() => null);
    const baseline = this.baselines.get(path);
    if (!draft || !baseline) return;
    if (draft.text === baseline.text) {
      await this.store.delete(key);
      return;
    }
    const when = new Date(draft.at).toLocaleTimeString();
    if (!draftApplies(draft, baseline.sha)) {
      // The disk moved on since the draft was made: offering it would write over someone's change.
      await this.journal.recordRejectedDraft(
        path,
        draft.text,
        `unsaved draft from ${when}; the file changed on disk since`
      );
      await this.store.delete(key);
      this.notices.show({
        key: `draft:${path}`,
        tone: 'warn',
        message: `Unsaved edits to ${path} from ${when} were not restored: the file changed on disk since.`,
        detail: this.journal.available ? 'They are kept in History.' : undefined,
      });
      return;
    }
    this.notices.show({
      key: `draft:${path}`,
      tone: 'info',
      message: `Unsaved edits to ${path} from ${when} were found.`,
      detail: 'They did not reach the disk before the editor closed.',
      actions: [
        { label: 'Restore', run: () => this.restore(sceneId, path, draft) },
        { label: 'Discard', run: () => this.store.delete(key) },
      ],
    });
  }

  private async restore(sceneId: string, path: string, draft: DraftRecord): Promise<void> {
    const descriptor = appState.scenes.descriptors[sceneId];
    const baseline = this.baselines.get(path);
    if (!descriptor || !baseline || !draftApplies(draft, baseline.sha)) {
      this.notices.show({
        key: `draft:${path}`,
        tone: 'warn',
        message: `The draft of ${path} no longer applies: the file changed on disk.`,
      });
      return;
    }
    await this.merges.adoptText(descriptor, draft.text);
    await this.flush.flushScene(sceneId);
  }
}

const draftKey = (projectId: string, path: string): string => `${projectId}\u0000${path}`;

/** The disk holds the version the draft was made from (or the unanswered flush on top of it). */
const draftApplies = (draft: DraftRecord, diskSha: string): boolean =>
  draft.baselineSha === diskSha || (draft.unconfirmedShas ?? []).includes(diskSha);
