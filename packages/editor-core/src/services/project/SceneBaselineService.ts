import type { SavedSceneDocument } from '@pix3/runtime';
import { injectable } from '@/fw/di';
import { sha256 } from '@/core/hash';
import { recordFlushedKeys, type FlushLedger } from '@/core/scene-patch/scene-merge';
import { toProjectPath } from '@/services/project/disk/project-paths';

/**
 * The last confirmed disk version of a scene (plan §C.2 "Baseline"): updated on load, reload and a
 * **successful** flush only. `text` is the exact file text (a BOM kept), `sha` the hash of its raw
 * bytes, `norm` the normalised document of the graph built from that text (W1).
 */
export interface SceneBaseline {
  readonly sha: string;
  readonly text: string;
  readonly norm: SavedSceneDocument;
}

/**
 * Per-path memory of the write model (replaces 1.x's `SceneDiskStateService`; keys are project
 * paths without a scheme, `scenes/a.pix3scene`):
 *
 * - the **baseline** of every open scene — `If-Match` of the next flush, B of the §C.3 merge, and
 *   the hash an own write is recognised by;
 * - the **flush ledger** per path: the keys the editor's flushes changed since the last external
 *   version, for "the agent overwrote your edit" (§C.3);
 * - paths with a **pending external version** (seen on disk, not applied yet: settling, unparsable,
 *   or held for play). A flush skips them; the merge takes over.
 */
@injectable()
export class SceneBaselineService {
  private readonly baselines = new Map<string, SceneBaseline>();
  private readonly ledgers = new Map<string, FlushLedger>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** The exact text of raw bytes, BOM included (the hash is over the bytes). */
  static decode(bytes: Uint8Array): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }

  get(path: string): SceneBaseline | null {
    return this.baselines.get(toProjectPath(path)) ?? null;
  }

  set(path: string, baseline: SceneBaseline): void {
    this.baselines.set(toProjectPath(path), baseline);
    this.notify();
  }

  /** Baseline from text whose bytes were not kept (a spec, a merge result just written). */
  async setFromText(path: string, text: string, norm: SavedSceneDocument): Promise<SceneBaseline> {
    const baseline = { sha: await sha256(text), text, norm };
    this.set(path, baseline);
    return baseline;
  }

  /** After a successful flush: the new baseline, and what this flush changed. */
  recordFlush(path: string, previous: SceneBaseline, next: SceneBaseline): void {
    const key = toProjectPath(path);
    this.ledgers.set(
      key,
      recordFlushedKeys(this.ledgers.get(key) ?? new Map(), previous.norm, next.norm)
    );
    this.set(key, next);
  }

  /**
   * The keys flushed since the last external version, handed over once: the external version
   * that asks for them settles every one of them (`findClobberedKeys`).
   */
  takeFlushLedger(path: string): FlushLedger {
    const key = toProjectPath(path);
    const ledger = this.ledgers.get(key) ?? new Map();
    this.ledgers.delete(key);
    return ledger;
  }

  /** True when `hash` is the baseline of `path` — the editor's own write, or what it loaded. */
  isKnownHash(path: string, hash: string): boolean {
    return this.baselines.get(toProjectPath(path))?.sha === hash;
  }

  forget(path: string): void {
    const key = toProjectPath(path);
    this.baselines.delete(key);
    this.ledgers.delete(key);
    this.clearPendingExternal(key);
    this.notify();
  }

  markPendingExternal(path: string): void {
    const key = toProjectPath(path);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.notify();
  }

  clearPendingExternal(path: string): void {
    if (this.pending.delete(toProjectPath(path))) this.notify();
  }

  isPendingExternal(path: string): boolean {
    return this.pending.has(toProjectPath(path));
  }

  getPendingExternalPaths(): string[] {
    return [...this.pending];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.baselines.clear();
    this.ledgers.clear();
    this.pending.clear();
    this.notify();
  }

  dispose(): void {
    this.reset();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[SceneBaselineService] Listener error', error);
      }
    }
  }
}
