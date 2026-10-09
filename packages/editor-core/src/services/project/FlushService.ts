import { SceneManager } from '@pix3/runtime';
import { subscribe } from 'valtio/vanilla';
import { inject, injectable } from '@/fw/di';
import type { HookReply } from '@/host/EditorHost';
import { diffScenes, type SceneOp } from '@/core/scene-patch/scene-diff';
import { editorNormOfGraph, serializeGraph } from '@/core/scene-patch/scene-norm';
import { applySceneOps, ScenePatchError } from '@/core/scene-patch/scene-patch-writer';
import { sha256 } from '@/core/hash';
import { LoggingService } from '@/services/core/LoggingService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneBaselineService, type SceneBaseline } from '@/services/project/SceneBaselineService';
import { SceneJournalService } from '@/services/project/SceneJournalService';
import { HostNoticeService } from '@/host/HostNoticeService';
import { ReadOnlyTabError, SceneWriteConflictError } from '@/services/project/write-errors';
import { appState } from '@/state';

/**
 * - `saved`: the patch is on disk; the baseline moved to it;
 * - `unchanged`: nothing pending (an undo back to the baseline) — nothing written, scene clean;
 * - `external-change`: the disk is not the baseline (412): nothing written, the path went to the
 *   external-change path, whose merge (§C.3) produces the next flush;
 * - `held`: an external version of the path is still settling — the merge comes first;
 * - `read-only`: another tab is the writer;
 * - `failed`: the write failed otherwise (dev server down…): the scene stays dirty, retried later.
 */
export type FlushOutcome =
  | 'saved'
  | 'unchanged'
  | 'external-change'
  | 'held'
  | 'read-only'
  | 'failed';

/** What a flush is about to write: an immutable snapshot of the graph (§C.2 step 1). */
export interface FlushSnapshot {
  readonly path: string;
  readonly baseline: SceneBaseline;
  /** `nodeDataChangeSignal` when the snapshot was taken (the cutoff). */
  readonly revision: number;
  readonly norm: SceneBaseline['norm'];
  readonly ops: readonly SceneOp[];
  /** The file text to write: the baseline text with `ops` spliced in (or the full fallback). */
  readonly text: string;
  readonly fallback: boolean;
}

/**
 * When and how the editor writes scenes (plan §C.1 "Когда пишется диск", §C.2 "Flush = один патч
 * от baseline"). Replaces the port-phase `SceneWriteService` behind the same methods.
 *
 * `pending = diff(baseline.norm, norm(graph))`, computed at flush time, so perform / undo / redo /
 * coalesce need no bookkeeping (N8). A flush takes a snapshot `{revision, norm}` synchronously,
 * splices the diff into the baseline text (`ScenePatchWriter`), writes with
 * `If-Match = baseline.sha`, and on success makes the snapshot the baseline. The scene turns clean
 * only if no operation completed since the snapshot (`nodeDataChangeSignal` cutoff); later edits
 * stay pending for the next flush.
 *
 * | Trigger | Rule |
 * |---|---|
 * | idle | {@link IDLE_MS} after the last completed operation |
 * | upper bound | at most {@link MAX_DIRTY_MS} after the first unsaved edit under continuous work |
 * | Ctrl+S | now ({@link saveScene}) |
 * | play / build / agent sync | {@link flushDirty} first |
 * | during a gesture | never; every trigger waits for pointerup |
 */
@injectable()
export class FlushService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ExternalChangeService)
  private readonly externalChanges!: ExternalChangeService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(SceneJournalService)
  private readonly journal!: SceneJournalService;

  @inject(HostNoticeService)
  private readonly notices!: HostNoticeService;

  static readonly IDLE_MS = 1_500;
  static readonly MAX_DIRTY_MS = 10_000;
  /** How often a held idle flush re-checks (gesture, read-only, failure). */
  static readonly RETRY_MS = 250;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt: number | null = null;
  private lastSignal = -1;
  private disposeSubscription: (() => void) | null = null;
  /** One flush per scene at a time; a second request waits for the first. */
  private readonly chains = new Map<string, Promise<FlushOutcome>>();
  private readonly listeners = new Set<(sceneId: string, outcome: FlushOutcome) => void>();

  /** Start the idle/upper-bound timer (called once by `mountEditor`). */
  start(): void {
    if (this.disposeSubscription) return;
    this.lastSignal = appState.scenes.nodeDataChangeSignal;
    this.disposeSubscription = subscribe(appState.scenes, () => this.onScenesChanged());
  }

  dispose(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = null;
    this.clearTimer();
    this.listeners.clear();
  }

  /** Listener per finished flush (the draft service drops its checkpoint on `saved`). */
  onFlushed(listener: (sceneId: string, outcome: FlushOutcome) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dirtySceneIds(): string[] {
    return Object.values(appState.scenes.descriptors)
      .filter(descriptor => descriptor.isDirty && descriptor.filePath.startsWith('res://'))
      .map(descriptor => descriptor.id);
  }

  /** True while a flush of any scene is in flight (part of the "dirty" indicator, §C.1). */
  isFlushing(): boolean {
    return this.chains.size > 0;
  }

  /** Ctrl+S: write this scene now (after a gesture in progress ends). */
  async saveScene(sceneId: string): Promise<FlushOutcome> {
    await this.waitForGestureEnd(Number.POSITIVE_INFINITY);
    return this.flushScene(sceneId);
  }

  /**
   * Write every dirty scene now — the sync barrier's step 0 (§B.3), play and build. A gesture in
   * progress is waited out up to `timeoutMs`; if it outlasts that, nothing is written and the
   * answer says so (the agent retries).
   */
  async flushDirty(timeoutMs: number): Promise<HookReply> {
    if (!(await this.waitForGestureEnd(timeoutMs))) {
      return { ok: false, reason: 'gesture_in_progress' };
    }
    const saved: string[] = [];
    const conflicts: string[] = [];
    const failed: string[] = [];
    // Several dirty scenes (a prefab and a scene with its instances) go as one changeset.
    const together = await this.flushTogether(this.dirtySceneIds());
    saved.push(...together.saved);
    conflicts.push(...together.conflicts);
    // A flush already in flight is awaited too: its write is part of "the disk is current".
    const ids = new Set([...this.dirtySceneIds(), ...this.chains.keys()]);
    for (const sceneId of ids) {
      const path = toProjectPath(appState.scenes.descriptors[sceneId]?.filePath ?? sceneId);
      const outcome = await this.flushScene(sceneId);
      if (outcome === 'saved') saved.push(path);
      else if (outcome === 'external-change' || outcome === 'held') conflicts.push(path);
      else if (outcome === 'failed' || outcome === 'read-only') failed.push(path);
    }
    if (conflicts.length > 0) return { ok: false, reason: 'external_change', saved, conflicts };
    if (failed.length > 0) return { ok: false, reason: 'write_failed', saved, failed };
    return { ok: true, saved };
  }

  /**
   * Plan §C.2 "Префаб + сцена — один changeset": when two or more scenes have something to
   * write and the host has transactions, they are written as one (§C.4: all or nothing, one
   * `pix3:fs` frame). A refused `If-Match` writes nothing; that path goes to the merge and the
   * others are left dirty for the per-scene flush that follows.
   */
  private async flushTogether(
    sceneIds: readonly string[]
  ): Promise<{ saved: string[]; conflicts: string[] }> {
    const none = { saved: [], conflicts: [] };
    if (sceneIds.length < 2 || !this.storage.supportsChangesets()) return none;
    if (appState.project.host.writer === 'other') return none;
    // Wait out per-scene flushes in flight: a changeset must not race one of its own scenes.
    await Promise.all(
      sceneIds.map(id => this.chains.get(id)?.catch(() => undefined) ?? Promise.resolve())
    );
    const snaps: Array<{ sceneId: string; snap: FlushSnapshot }> = [];
    for (const sceneId of sceneIds) {
      const descriptor = appState.scenes.descriptors[sceneId];
      if (!descriptor || this.baselines.isPendingExternal(toProjectPath(descriptor.filePath)))
        continue;
      const snap = this.snapshot(sceneId);
      if (snap && snap.ops.length > 0) snaps.push({ sceneId, snap });
    }
    if (snaps.length < 2) return none;
    let shas: string[];
    try {
      shas = await this.storage.writeTextChangeset(
        snaps.map(({ snap }) => ({ path: snap.path, text: snap.text, baseHash: snap.baseline.sha }))
      );
    } catch (error) {
      if (!(error instanceof SceneWriteConflictError)) {
        // No answer is not "not written": the changeset may have landed (all or nothing).
        for (const { snap } of snaps) await this.recordUnconfirmed(snap);
      }
      if (error instanceof SceneWriteConflictError) {
        const path = toProjectPath(error.path);
        this.baselines.markPendingExternal(path);
        this.externalChanges.report(path);
        return { saved: [], conflicts: [path] };
      }
      // Anything else: the per-scene flushes that follow report it.
      return none;
    }
    const saved: string[] = [];
    snaps.forEach(({ sceneId, snap }, index) => {
      this.baselines.recordFlush(snap.path, snap.baseline, {
        sha: shas[index],
        text: snap.text,
        norm: snap.norm,
      });
      const descriptor = appState.scenes.descriptors[sceneId];
      if (descriptor && appState.scenes.nodeDataChangeSignal === snap.revision) {
        descriptor.isDirty = false;
      }
      if (descriptor) descriptor.lastSavedAt = Date.now();
      saved.push(snap.path);
    });
    for (const { sceneId } of snaps) {
      for (const listener of [...this.listeners]) listener(sceneId, 'saved');
    }
    return { saved, conflicts: [] };
  }

  /** The text a flush of `sceneId` would write now, or null when nothing is pending (the draft). */
  snapshot(sceneId: string): FlushSnapshot | null {
    const descriptor = appState.scenes.descriptors[sceneId];
    const graph = this.sceneManager.getSceneGraph(sceneId);
    if (!descriptor || !graph || !descriptor.filePath.startsWith('res://')) return null;
    const path = toProjectPath(descriptor.filePath);
    const baseline = this.baselines.get(path);
    if (!baseline) return null;
    const revision = appState.scenes.nodeDataChangeSignal;
    const norm = editorNormOfGraph(graph, baseline.norm);
    const ops = diffScenes(baseline.norm, norm);
    if (ops.length === 0) {
      return { path, baseline, revision, norm, ops, text: baseline.text, fallback: false };
    }
    try {
      return {
        path,
        baseline,
        revision,
        norm,
        ops,
        text: applySceneOps(baseline.text, ops),
        fallback: false,
      };
    } catch (error) {
      if (!(error instanceof ScenePatchError)) throw error;
      return { path, baseline, revision, norm, ops, text: serializeGraph(graph), fallback: true };
    }
  }

  /** Flush one scene (serialised per scene). */
  flushScene(sceneId: string): Promise<FlushOutcome> {
    const previous = this.chains.get(sceneId) ?? Promise.resolve<FlushOutcome>('unchanged');
    const next = previous.catch(() => 'failed' as const).then(() => this.flushOnce(sceneId));
    this.chains.set(sceneId, next);
    void next.finally(() => {
      if (this.chains.get(sceneId) === next) this.chains.delete(sceneId);
    });
    return next;
  }

  private async flushOnce(sceneId: string): Promise<FlushOutcome> {
    const outcome = await this.flushUnserialised(sceneId);
    for (const listener of [...this.listeners]) {
      try {
        listener(sceneId, outcome);
      } catch (error) {
        console.error('[FlushService] Listener error', error);
      }
    }
    return outcome;
  }

  private async flushUnserialised(sceneId: string): Promise<FlushOutcome> {
    if (appState.project.host.writer === 'other') return 'read-only';
    const descriptor = appState.scenes.descriptors[sceneId];
    if (!descriptor || !descriptor.filePath.startsWith('res://')) return 'unchanged';
    const path = toProjectPath(descriptor.filePath);
    if (this.baselines.isPendingExternal(path)) return 'held';

    const snap = this.snapshot(sceneId);
    if (!snap) {
      this.logger.warn(`${path}: no disk baseline for this scene — not written.`);
      return 'failed';
    }
    if (snap.ops.length === 0) {
      if (appState.scenes.nodeDataChangeSignal === snap.revision) descriptor.isDirty = false;
      return 'unchanged';
    }
    if (snap.fallback) {
      this.logger.warn(
        `${path}: the scene uses YAML the patch writer does not edit in place (anchors, aliases or ` +
          'flow `children`) — written in full; comments in it are not kept.'
      );
    }

    let sha: string;
    try {
      sha = await this.storage.writeTextFile(descriptor.filePath, snap.text, {
        baseHash: snap.baseline.sha,
      });
    } catch (error) {
      if (error instanceof SceneWriteConflictError) {
        // The disk holds an earlier flush of ours whose answer was lost: adopt it, write the rest.
        if (error.currentHash && this.baselines.acceptOwnHash(path, error.currentHash)) {
          if (this.baselines.get(path) !== snap.baseline) return this.flushUnserialised(sceneId);
        }
        // Someone else wrote the file since the baseline: the merge path takes it from here.
        this.baselines.markPendingExternal(path);
        this.externalChanges.report(path);
        return 'external-change';
      }
      if (error instanceof ReadOnlyTabError) {
        // §C.3 hand-over step 3: another tab claimed the writer after this snapshot. Its content
        // is kept in the journal, never written over the new writer's disk.
        appState.project.host.writer = 'other';
        await this.journal.recordRejectedDraft(
          path,
          snap.text,
          'a write refused because another tab took over'
        );
        this.notices.show({
          key: `superseded:${path}`,
          tone: 'warn',
          message: `Another tab took over writing; your last edits to ${path} were not saved here.`,
          detail: this.journal.available ? 'They are kept in History.' : undefined,
        });
        return 'read-only';
      }
      this.logger.warn(
        `${path}: not written (${error instanceof Error ? error.message : String(error)}).`
      );
      await this.recordUnconfirmed(snap);
      return 'failed';
    }

    // The plugin hashes the bytes it wrote; a host without a hash leaves us to compute it.
    const next: SceneBaseline = {
      sha: sha || (await sha256(snap.text)),
      text: snap.text,
      norm: snap.norm,
    };
    this.baselines.recordFlush(path, snap.baseline, next);
    // Clean only when no operation completed since the snapshot (§C.2 step 4).
    if (appState.scenes.nodeDataChangeSignal === snap.revision) descriptor.isDirty = false;
    descriptor.lastSavedAt = Date.now();
    this.logger.debug(
      `Flushed ${path} (${snap.ops.length} change${snap.ops.length === 1 ? '' : 's'}).`
    );
    return 'saved';
  }

  /**
   * A write that failed without a refusal (no answer: the dev server stopped, the connection
   * dropped) may still have landed — the plugin renames the file into place before it answers.
   * Its sha is remembered: a disk showing exactly those bytes is this write, not someone else's
   * (`SceneBaselineService.acceptOwnHash`), and a draft made meanwhile still applies to it.
   */
  private async recordUnconfirmed(snap: FlushSnapshot): Promise<void> {
    this.baselines.recordUnconfirmedFlush(snap.path, snap.baseline, {
      sha: await sha256(snap.text),
      text: snap.text,
      norm: snap.norm,
    });
  }

  private waitForGestureEnd(timeoutMs: number): Promise<boolean> {
    if (!appState.ui.gestureInProgress) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            unsubscribe();
            resolve(false);
          }, timeoutMs)
        : null;
      const unsubscribe = subscribe(appState.ui, () => {
        if (appState.ui.gestureInProgress) return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
    });
  }

  // --- idle timer -------------------------------------------------------------------------------

  private onScenesChanged(): void {
    const signal = appState.scenes.nodeDataChangeSignal;
    const operationCompleted = signal !== this.lastSignal;
    this.lastSignal = signal;
    if (this.dirtySceneIds().length === 0) {
      this.firstDirtyAt = null;
      this.clearTimer();
      return;
    }
    if (!operationCompleted && this.idleTimer) return; // unrelated scene state; keep the schedule
    const now = Date.now();
    this.firstDirtyAt ??= now;
    this.schedule(
      Math.min(FlushService.IDLE_MS, this.firstDirtyAt + FlushService.MAX_DIRTY_MS - now)
    );
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.idleTimer = setTimeout(() => void this.idleFlush(), Math.max(0, delay));
  }

  private clearTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async idleFlush(): Promise<void> {
    this.idleTimer = null;
    // Never during a gesture: the upper bound waits for pointerup (§C.1). A read-only tab waits
    // for the writer claim.
    if (appState.ui.gestureInProgress || appState.project.host.writer === 'other') {
      this.schedule(FlushService.RETRY_MS);
      return;
    }
    const outcomes = await Promise.all(this.dirtySceneIds().map(id => this.flushScene(id)));
    const remaining = this.dirtySceneIds().length > 0;
    this.firstDirtyAt = remaining ? Date.now() : null;
    if (remaining && !this.idleTimer) {
      // Edits after the snapshot, or a failed write: come back for them.
      this.schedule(outcomes.includes('failed') ? 2_000 : FlushService.IDLE_MS);
    }
  }
}
