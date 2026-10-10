import { SceneManager, type SavedSceneDocument, type SceneGraph } from '@pix3/runtime';
import { inject, injectable } from '@/fw/di';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import {
  describeLeaf,
  diffScenes,
  indexNodes,
  leafKey,
  type LeafOp,
  type SceneOp,
} from '@/core/scene-patch/scene-diff';
import { withLegacyAnchorConversion } from '@/core/scene-patch/legacy-anchor-conversion';
import { findClobberedKeys, planMerge, type DroppedKey } from '@/core/scene-patch/scene-merge';
import { editorNormOfGraph, normOfGraph } from '@/core/scene-patch/scene-norm';
import { applySceneOps, ScenePatchError } from '@/core/scene-patch/scene-patch-writer';
import { HostNoticeService } from '@/host/HostNoticeService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { readDiskVersion } from '@/services/project/disk/disk-version';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { FlushService } from '@/services/project/FlushService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneBaselineService, type SceneBaseline } from '@/services/project/SceneBaselineService';
import { SceneJournalService } from '@/services/project/SceneJournalService';
import { appState, type SceneDescriptor } from '@/state';

/**
 * - `unchanged`: the disk holds the baseline (an own write, or a version put back);
 * - `reloaded`: a clean scene took the external version as is;
 * - `merged`: a dirty scene took it with the editor's accepted keys on top (dirty: they flush next);
 * - `missing`: the file is gone — the scene stays in memory, listed in `staleScenes`.
 */
export type ExternalApplyOutcome = 'unchanged' | 'reloaded' | 'merged' | 'missing';

/** How many dropped keys a notice names before "and N more". */
const NOTICE_KEYS = 4;

/**
 * An external version E of an open scene (plan §C.3): a settled batch from `ExternalChangeService`
 * lands here, through `ExternalReloadService`.
 *
 * - **Clean scene** — `ReloadSceneCommand` (graph replaced, selection by id kept, history cleared).
 * - **Dirty scene** — base B, external E, `pending = diff(B.norm, norm(graph))`:
 *   1. the editor state is journaled as `rejected-draft` (nothing is lost);
 *   2. each pending key is accepted if E left it as in B, dropped if E changed it too, if its node
 *      is gone in E, or if it is structural (N5);
 *   3. `merged = patch(E.text, accepted)` builds the graph, `baseline := E`, the accepted keys are
 *      the new `pending` and flush normally;
 *   4. history is cleared (its closures point at the old nodes);
 *   5. a notice names the dropped keys.
 * - **"Затирание по устаревшему чтению"** — if E puts keys the editor's flushes changed (any
 *   flush since the previous external version) back to a value they replaced, a notice offers to
 *   restore them ("Restore my edit").
 */
@injectable()
export class SceneMergeService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(FlushService)
  private readonly flush!: FlushService;

  @inject(SceneJournalService)
  private readonly journal!: SceneJournalService;

  @inject(HostNoticeService)
  private readonly notices!: HostNoticeService;

  /** Apply whatever is on disk now at the scene's path. */
  async applyExternal(descriptor: SceneDescriptor): Promise<ExternalApplyOutcome> {
    const path = toProjectPath(descriptor.filePath);
    const version = await readDiskVersion(this.storage, descriptor.filePath);
    if (!version) {
      if (!appState.project.host.staleScenes.includes(path)) {
        appState.project.host.staleScenes = [...appState.project.host.staleScenes, path];
      }
      this.notices.show({
        key: `missing:${path}`,
        tone: 'warn',
        message: `${path} was deleted on disk.`,
        detail: 'The open scene stays in memory and is not written.',
      });
      return 'missing';
    }
    appState.project.host.staleScenes = appState.project.host.staleScenes.filter(p => p !== path);
    const B = this.baselines.get(path);
    if (B && B.sha === version.hash) return 'unchanged';

    const eText = SceneBaselineService.decode(version.bytes);
    const eGraph = await this.sceneManager.parseScene(version.text, {
      filePath: descriptor.filePath,
    });
    const E: SceneBaseline = { sha: version.hash, text: eText, norm: normOfGraph(eGraph) };
    const clobbered = findClobberedKeys(this.baselines.takeFlushLedger(path), E.norm);

    const graph = this.sceneManager.getSceneGraph(descriptor.id);
    const pending =
      B && graph && descriptor.isDirty ? diffScenes(B.norm, editorNormOfGraph(graph, B.norm)) : [];
    if (B) this.highlightChanges(descriptor.id, B.norm, E.norm);
    let outcome: ExternalApplyOutcome;
    if (!B || !graph || pending.length === 0) {
      await this.install(descriptor, E, version.text, eGraph, false);
      outcome = 'reloaded';
    } else {
      outcome = await this.merge(descriptor, path, B, E, version.text, eGraph, graph);
    }
    if (clobbered.length > 0) this.offerRestore(descriptor, path, clobbered, E.norm);
    return outcome;
  }

  /** How long the scene tree highlights the nodes an external version changed. */
  static readonly HIGHLIGHT_MS = 3_000;
  private readonly highlightTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The nodes E changed against B (added, moved, any key) light up in the tree for a moment. */
  private highlightChanges(sceneId: string, B: SavedSceneDocument, E: SavedSceneDocument): void {
    const ids = new Set<string>();
    for (const op of diffScenes(B, E)) {
      if (op.kind === 'addNode') ids.add(op.def.id);
      else if (op.kind === 'moveNode') ids.add(op.nodeId);
      else if ((op.kind === 'set' || op.kind === 'delete') && op.nodeId) ids.add(op.nodeId);
    }
    if (ids.size === 0) return;
    appState.project.host.recentlyChanged = {
      ...appState.project.host.recentlyChanged,
      [sceneId]: [...ids],
    };
    clearTimeout(this.highlightTimers.get(sceneId));
    this.highlightTimers.set(
      sceneId,
      setTimeout(() => {
        this.highlightTimers.delete(sceneId);
        const { [sceneId]: _gone, ...rest } = appState.project.host.recentlyChanged;
        appState.project.host.recentlyChanged = rest;
      }, SceneMergeService.HIGHLIGHT_MS)
    );
  }

  /**
   * A prefab changed on disk: the override base of every instance in this scene moved, so the
   * baseline norm is re-derived from the baseline text against the new prefab (§C.2 "Если внешне
   * изменился префаб…"). Without it the next flush would write the base change as overrides.
   */
  async rebaseOnPrefabChange(descriptor: SceneDescriptor): Promise<void> {
    const path = toProjectPath(descriptor.filePath);
    const B = this.baselines.get(path);
    if (!B) return;
    const graph = await this.sceneManager.parseScene(B.text, { filePath: descriptor.filePath });
    try {
      this.baselines.set(path, { ...B, norm: normOfGraph(graph) });
    } finally {
      disposeGraph(graph);
    }
  }

  private async merge(
    descriptor: SceneDescriptor,
    path: string,
    B: SceneBaseline,
    E: SceneBaseline,
    eText: string,
    eGraph: SceneGraph,
    graph: SceneGraph
  ): Promise<ExternalApplyOutcome> {
    const G = editorNormOfGraph(graph, B.norm);
    const editorText = this.flush.snapshot(descriptor.id)?.text ?? null;
    if (editorText !== null) {
      await this.journal.recordRejectedDraft(
        path,
        editorText,
        'editor state replaced by a merge with an external version'
      );
    }
    const plan = planMerge(B.norm, E.norm, G);
    let accepted = plan.accepted;
    let mergedText = eText;
    if (accepted.length > 0) {
      try {
        // E may still be a legacy file: the accepted keys land with its conversion (W21).
        mergedText = applySceneOps(E.text, withLegacyAnchorConversion(E.text, E.norm, accepted));
      } catch (error) {
        if (!(error instanceof ScenePatchError)) throw error;
        accepted = [];
      }
    }
    const dropped: DroppedKey[] =
      accepted.length === plan.accepted.length
        ? [...plan.dropped]
        : [
            ...plan.dropped,
            ...plan.accepted.map(op => ({
              op,
              key: op.nodeId ?? '@doc',
              nodeId: op.nodeId,
              reason: 'same-key' as const,
            })),
          ];
    if (accepted.length === 0) {
      await this.install(descriptor, E, eText, eGraph, false);
    } else {
      const merged = await this.sceneManager.parseScene(mergedText, {
        filePath: descriptor.filePath,
      });
      disposeGraph(eGraph);
      await this.install(descriptor, E, mergedText, merged, true);
    }
    if (dropped.length > 0) {
      const names = dropped.map(d => this.describe(d, G));
      this.notices.show({
        key: `merge:${path}`,
        tone: 'warn',
        message: `${path} changed on disk while you were editing it: ${dropped.length} of your change${dropped.length === 1 ? ' was' : 's were'} dropped.`,
        detail:
          `${names.slice(0, NOTICE_KEYS).join('; ')}${names.length > NOTICE_KEYS ? `; and ${names.length - NOTICE_KEYS} more` : ''}. ` +
          (this.journal.available ? 'Your version is in History.' : ''),
      });
    }
    return 'merged';
  }

  /** Build the graph from `text` (or install `graph`), with `baseline` as the disk version. */
  private async install(
    descriptor: SceneDescriptor,
    baseline: SceneBaseline,
    text: string,
    graph: SceneGraph,
    markDirty: boolean
  ): Promise<void> {
    await this.dispatcher.execute(
      new ReloadSceneCommand({
        sceneId: descriptor.id,
        filePath: descriptor.filePath,
        sceneText: text,
        graph,
        baseline,
        markDirty,
      })
    );
  }

  /** "The agent overwrote your edit X [Restore my edit]" — re-applies the flushed values. */
  private offerRestore(
    descriptor: SceneDescriptor,
    path: string,
    clobbered: readonly LeafOp[],
    names: SavedSceneDocument
  ): void {
    const labels = clobbered.map(op =>
      this.describe({ op, key: '', nodeId: op.nodeId, reason: 'same-key' }, names)
    );
    this.notices.show({
      key: `clobber:${path}`,
      tone: 'warn',
      message: `An agent overwrote your edit in ${path}.`,
      detail: `${labels.slice(0, NOTICE_KEYS).join('; ')}${labels.length > NOTICE_KEYS ? `; and ${labels.length - NOTICE_KEYS} more` : ''} — it wrote a file it read before you saved them.`,
      actions: [
        { label: 'Restore my edit', run: () => this.restoreKeys(descriptor, path, clobbered) },
      ],
    });
  }

  private async restoreKeys(
    descriptor: SceneDescriptor,
    path: string,
    ops: readonly LeafOp[]
  ): Promise<void> {
    const B = this.baselines.get(path);
    if (!B) return;
    const graphNow = this.sceneManager.getSceneGraph(descriptor.id);
    const editorOps =
      graphNow && descriptor.isDirty ? diffScenes(B.norm, editorNormOfGraph(graphNow, B.norm)) : [];
    // Pending edits of the editor ride along (structure included); the restored keys win.
    const keyed = new Map<string, SceneOp>();
    for (const [index, op] of [...editorOps, ...ops].entries()) {
      keyed.set(
        op.kind === 'set' || op.kind === 'delete' ? leafKey(op.nodeId, op.path) : `#${index}`,
        op
      );
    }
    await this.adoptText(descriptor, applySceneOps(B.text, [...keyed.values()]));
    await this.flush.flushScene(descriptor.id);
  }

  /**
   * History → "Restore version": unsaved edits are flushed first (so the version being replaced
   * is in the journal too), then the plugin writes the journaled version with
   * `If-Match = baseline`. The scene follows the disk like after any external change.
   */
  async restoreVersion(descriptor: SceneDescriptor, versionId: string): Promise<boolean> {
    const path = toProjectPath(descriptor.filePath);
    if (descriptor.isDirty) await this.flush.flushScene(descriptor.id);
    const baseline = this.baselines.get(path);
    try {
      await this.journal.restore(path, versionId, baseline?.sha);
      return true;
    } catch (error) {
      this.notices.show({
        key: `restore:${path}`,
        tone: 'warn',
        message: `Could not restore that version of ${path}.`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Make `text` the scene's graph on top of the current baseline: the difference is pending and
   * flushes next (a restored draft, restored keys). History is cleared like on any reload.
   */
  async adoptText(descriptor: SceneDescriptor, text: string): Promise<void> {
    const B = this.baselines.get(toProjectPath(descriptor.filePath));
    if (!B) throw new Error(`${descriptor.filePath} has no disk baseline`);
    const graph = await this.sceneManager.parseScene(text, { filePath: descriptor.filePath });
    await this.install(descriptor, B, text, graph, true);
  }

  private describe(dropped: DroppedKey, doc: SavedSceneDocument): string {
    const name = dropped.nodeId
      ? (indexNodes(doc).get(dropped.nodeId)?.def.name ?? dropped.nodeId)
      : null;
    if (dropped.reason === 'structural') {
      const kind =
        dropped.op.kind === 'addNode'
          ? 'added'
          : dropped.op.kind === 'removeNode'
            ? 'deleted'
            : 'moved';
      return `${name ?? dropped.nodeId} (${kind})`;
    }
    const op = dropped.op;
    const label =
      op.kind === 'set' || op.kind === 'delete' ? describeLeaf(name, op.path) : dropped.key;
    return dropped.reason === 'node-gone' ? `${label} (node deleted on disk)` : label;
  }
}

/** A graph parsed only to be read (normalised, or replaced by a merged one). */
function disposeGraph(graph: SceneGraph): void {
  for (const root of graph.rootNodes) root.dispose();
}
