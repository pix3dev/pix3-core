import {
  isStaleComponent,
  NodeBase,
  replaceStaleComponents,
  SceneManager,
  ScriptRegistry,
  type SceneGraph,
  type ScriptComponent,
} from '@pix3/runtime';

import { indexNodes } from '@/core/scene-patch/scene-diff';
import { normOfGraph } from '@/core/scene-patch/scene-norm';
import { inject, injectable } from '@/fw/di';
import { OperationService } from '@/services/core/OperationService';
import { SceneBaselineService, type SceneBaseline } from '@/services/project/SceneBaselineService';
import { appState } from '@/state';

/** How often one scene is retried when its baseline moves while the fresh parse runs. */
const MAX_ATTEMPTS = 3;

const hasStale = (graph: SceneGraph, registry: ScriptRegistry): boolean => {
  for (const node of graph.nodeMap.values()) {
    if (node.components.some(c => isStaleComponent(c, registry))) return true;
  }
  return false;
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Live script components follow their script (`.plans/scripts-vite.md` S7). A synced script
 * edit re-registers `user:<Name>` with a new class; every component built from the old class in
 * an open scene is replaced by one of the new class — same id, `enabled` and slot — so the
 * inspector's new schema works on a matching instance and the editor runs the code on disk.
 *
 * Not an operation: nothing a person did, so no history entry and no dirty mark. What a scene
 * would write must not move either, so the config of each new instance is the one a fresh load
 * of the baseline text builds with the new class (its defaults included), plus the keys the
 * person changed and has not saved yet (live config ≠ the old baseline's) — a dirty scene keeps
 * its edits, a clean one stays clean. The baseline norm is re-derived with the new classes, as
 * for a changed prefab (`SceneMergeService.rebaseOnPrefabChange`), so a new default is not an
 * edit.
 *
 * History entries keep references to old instances: property and enabled undo find the component
 * by id, and an undo/redo that brings an old instance back (a removed component, a deleted node)
 * is followed by a pass that replaces it with its live config.
 */
@injectable()
export class LiveComponentService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @inject(OperationService)
  private readonly operations!: OperationService;

  private running: Promise<number> = Promise.resolve(0);
  private disposeHistoryWatch: (() => void) | null = null;

  /**
   * Replace stale components in every open scene (queued behind a run in progress). Resolves to
   * how many were replaced. Skipped during play: the running game keeps its classes, and the
   * registration itself waits for play to stop.
   */
  replaceStale(): Promise<number> {
    this.running = this.running.then(
      () => this.replaceInOpenScenes(),
      () => this.replaceInOpenScenes()
    );
    return this.running;
  }

  /** Resolves once every replacement asked for so far is done. */
  async settled(): Promise<void> {
    await this.running.catch(() => 0);
  }

  dispose(): void {
    this.disposeHistoryWatch?.();
    this.disposeHistoryWatch = null;
  }

  private async replaceInOpenScenes(): Promise<number> {
    if (appState.ui.isPlaying) return 0;
    this.watchHistory();
    let replaced = 0;
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      replaced += await this.replaceInScene(descriptor.id, descriptor.filePath);
    }
    if (replaced > 0) {
      // The inspector reads components by id on render; give it the new instances.
      appState.scenes.nodeDataChangeSignal += 1;
    }
    return replaced;
  }

  private async replaceInScene(sceneId: string, filePath: string): Promise<number> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const graph = this.sceneManager.getSceneGraph(sceneId);
      if (!graph || !hasStale(graph, this.scriptRegistry)) return 0;
      const baseline = this.baselines.get(filePath);
      if (!baseline) {
        return replaceStaleComponents(graph.rootNodes, this.scriptRegistry);
      }
      const fresh = await this.sceneManager.parseScene(baseline.text, { filePath });
      try {
        // A flush, a reload or a merge moved on while the text was parsed: start over.
        if (
          this.sceneManager.getSceneGraph(sceneId) !== graph ||
          this.baselines.get(filePath) !== baseline
        ) {
          continue;
        }
        const replaced = replaceStaleComponents(
          graph.rootNodes,
          this.scriptRegistry,
          this.configFrom(baseline, fresh)
        );
        this.baselines.set(filePath, { ...baseline, norm: normOfGraph(fresh) });
        return replaced;
      } finally {
        for (const root of fresh.rootNodes) root.dispose();
      }
    }
    return 0;
  }

  /**
   * The config of a replacement: the fresh load's (new class, baseline text) with the unsaved
   * edits on top. A component the baseline does not have (added and not saved) keeps its live
   * config whole.
   */
  private configFrom(
    baseline: SceneBaseline,
    fresh: SceneGraph
  ): (node: NodeBase, component: ScriptComponent) => Record<string, unknown> {
    const saved = indexNodes(baseline.norm);
    return (node, component) => {
      const live = component.config ?? {};
      const savedConfig = saved
        .get(node.nodeId)
        ?.def.components?.find(c => c.id === component.id)?.config;
      const freshNode = fresh.nodeMap.get(node.nodeId);
      const freshComponent =
        freshNode instanceof NodeBase
          ? freshNode.components.find(c => c.id === component.id)
          : undefined;
      if (!savedConfig || !freshComponent) return { ...live };
      const out: Record<string, unknown> = { ...freshComponent.config };
      for (const [key, value] of Object.entries(live)) {
        if (!sameJson(value, savedConfig[key])) out[key] = value;
      }
      return out;
    };
  }

  /**
   * Undo/redo can bring an old instance back into a scene (a removed component, a deleted node);
   * replace it right after. Watched from the first replacement on — before that nothing is stale.
   */
  private watchHistory(): void {
    if (this.disposeHistoryWatch) return;
    this.disposeHistoryWatch = this.operations.addListener(event => {
      if (event.type !== 'operation:undone' && event.type !== 'operation:redone') return;
      let replaced = 0;
      for (const descriptor of Object.values(appState.scenes.descriptors)) {
        const graph = this.sceneManager.getSceneGraph(descriptor.id);
        if (graph) replaced += replaceStaleComponents(graph.rootNodes, this.scriptRegistry);
      }
      if (replaced > 0) appState.scenes.nodeDataChangeSignal += 1;
    });
  }
}
