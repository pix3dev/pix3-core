import { inject, injectable } from '@/fw/di';
import type { HookReply } from '@/host/EditorHost';
import { SaveSceneOperation, type SaveSceneOutcome } from '@/features/scene/SaveSceneOperation';
import { OperationService } from '@/services/core/OperationService';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';

/**
 * When the editor writes scenes to disk, port phase (`.plans/editor-core-port.md` D4).
 *
 * The one seam plan §C.1's `FlushService` replaces: Ctrl+S (`saveScene`), the sync barrier's step
 * 0 (`flushDirty`, plan §B.3), and an idle timer (§C.1 table: 1.5 s after the last edit, at most
 * 10 s after the first unsaved one, never during a gesture). Writes go through
 * `SaveSceneOperation` (full serialisation, `If-Match` on the version the editor loaded); the
 * splice-patch writer and the IndexedDB draft come with `FlushService`.
 */
@injectable()
export class SceneWriteService {
  @inject(OperationService)
  private readonly operations!: OperationService;

  static readonly IDLE_MS = 1_500;
  static readonly MAX_DIRTY_MS = 10_000;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt: number | null = null;
  private disposeSubscription: (() => void) | null = null;

  /** Start the idle-save timer (called once by `mountEditor`). */
  start(): void {
    if (this.disposeSubscription) return;
    this.disposeSubscription = subscribe(appState.scenes, () => this.onScenesChanged());
  }

  dispose(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  dirtySceneIds(): string[] {
    return Object.values(appState.scenes.descriptors)
      .filter(descriptor => descriptor.isDirty)
      .map(descriptor => descriptor.id);
  }

  async saveScene(sceneId: string, quiet = false): Promise<SaveSceneOutcome> {
    const result = await this.operations.invoke(new SaveSceneOperation({ sceneId, quiet }));
    return result.outcome;
  }

  /**
   * Write every dirty scene now. A gesture in progress is waited out up to `timeoutMs`; if it
   * outlasts that, nothing is written and the answer says so (the agent retries).
   */
  async flushDirty(timeoutMs: number): Promise<HookReply> {
    if (!(await this.waitForGestureEnd(timeoutMs))) {
      return { ok: false, reason: 'gesture_in_progress' };
    }
    const saved: string[] = [];
    const conflicts: string[] = [];
    for (const sceneId of this.dirtySceneIds()) {
      const path = appState.scenes.descriptors[sceneId]?.filePath ?? sceneId;
      const outcome = await this.saveScene(sceneId, true);
      if (outcome === 'saved') saved.push(path);
      if (outcome === 'external-change') conflicts.push(path);
    }
    if (conflicts.length > 0) return { ok: false, reason: 'external_change', saved, conflicts };
    return { ok: true, saved };
  }

  private waitForGestureEnd(timeoutMs: number): Promise<boolean> {
    if (!appState.ui.gestureInProgress) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);
      const unsubscribe = subscribe(appState.ui, () => {
        if (appState.ui.gestureInProgress) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
    });
  }

  private onScenesChanged(): void {
    if (this.dirtySceneIds().length === 0) {
      this.firstDirtyAt = null;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    const now = Date.now();
    this.firstDirtyAt ??= now;
    const deadline = this.firstDirtyAt + SceneWriteService.MAX_DIRTY_MS;
    const delay = Math.max(0, Math.min(SceneWriteService.IDLE_MS, deadline - now));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.idleSave(), delay);
  }

  private async idleSave(): Promise<void> {
    this.idleTimer = null;
    // Never during a gesture: the upper bound waits for pointerup (plan §C.1).
    if (appState.ui.gestureInProgress || appState.project.host.writer === 'other') {
      this.idleTimer = setTimeout(() => void this.idleSave(), 250);
      return;
    }
    await this.flushDirty(0);
    this.firstDirtyAt = this.dirtySceneIds().length > 0 ? Date.now() : null;
  }
}
