import { SceneManager, type SceneGraph } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { optionalService } from '@/services/project/disk/optional-service';
import { SceneBaselineService, type SceneBaseline } from '@/services/project/SceneBaselineService';
import {
  NON_HUMAN_OPERATION_TAG,
  type Operation,
  type OperationContext,
  type OperationInvokeResult,
  type OperationMetadata,
} from '@/core/Operation';

export interface ReloadSceneOperationParams {
  /** Scene ID to reload. */
  sceneId: string;
  /** The scene's file path. */
  filePath: string;
  /**
   * The graph to install: built from the external version E, or from the merged text M (plan §C.3
   * step 3) — `SceneMergeService` parses it.
   */
  graph: SceneGraph;
  /** The disk version, E: with a merge the graph is built from M while the baseline stays E. */
  baseline: SceneBaseline;
  /** Mark the scene dirty after the reload (a merge result not on disk yet). */
  markDirty?: boolean;
}

/**
 * ReloadSceneOperation installs a version of a scene from disk (an external change, or a merge on
 * top of one): the graph replaces the open one, selection by id is kept, the baseline moves.
 */
export class ReloadSceneOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.reload',
    title: 'Reload Scene',
    description: 'Reload scene from file (triggered by external change)',
    // Applying a version from disk is not a human edit: it must never be recorded into the
    // protected set `P` of 1.x).
    tags: [NON_HUMAN_OPERATION_TAG],
  };

  private readonly params: ReloadSceneOperationParams;

  constructor(params: ReloadSceneOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const { sceneId, filePath, graph, baseline } = this.params;

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    try {
      // Get current scene descriptor
      const descriptor = state.scenes.descriptors[sceneId];
      if (!descriptor) {
        throw new Error(`Scene descriptor not found: ${sceneId}`);
      }

      // Update scene manager with new graph
      sceneManager.setActiveSceneGraph(sceneId, graph);
      optionalService(container, SceneBaselineService)?.set(filePath, baseline);

      // Non-destructive: keep the selection of every node that still exists (by id). The camera
      // lives in `appState.scenes.*CameraStates` and the viewport reconciles proxies by id, and the
      // scene tree prunes only the collapsed ids that are gone — neither is reset by a reload.
      const keep = (id: string) => graph.nodeMap.has(id);
      if (state.scenes.activeSceneId === sceneId) {
        const kept = state.selection.nodeIds.filter(keep);
        if (kept.length !== state.selection.nodeIds.length) {
          state.selection.nodeIds = kept;
        }
        if (state.selection.primaryNodeId && !keep(state.selection.primaryNodeId)) {
          state.selection.primaryNodeId = kept[0] ?? null;
        }
        if (state.selection.focusNodeId && !keep(state.selection.focusNodeId)) {
          state.selection.focusNodeId = null;
        }
      }

      // Update state hierarchy
      state.scenes.hierarchies[sceneId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };

      // Not dirty: it is what is on disk — unless it is a merge result still to be written back.
      descriptor.isDirty = this.params.markDirty === true;

      state.scenes.loadState = 'ready';
      state.scenes.loadError = null;
      state.scenes.lastLoadedAt = Date.now();

      // Reloading from disk replaces the in-memory graph wholesale (the previous
      // graph and its nodes are disposed by SceneManager.setActiveSceneGraph).
      // There is no coherent in-editor undo for an external file change, and the
      // old snapshot-swap undo left state and scene graph out of sync. Return a
      // non-committing mutation so this is never pushed to history;
      // ReloadSceneCommand clears history after a successful reload.
      return { didMutate: true };
    } catch (error) {
      let message = 'Failed to reload scene from file.';
      if (error instanceof SceneValidationError) {
        message = `${message} Validation issues: ${error.details.join('; ')}`;
      } else if (error instanceof Error) {
        message = `${message} ${error.message}`;
      }
      state.scenes.loadState = 'error';
      state.scenes.loadError = message;
      console.error('[ReloadSceneOperation] Reload failed:', error);
      throw error;
    }
  }
}
