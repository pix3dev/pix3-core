import { ResourceManager } from '@/services/assets/ResourceManager';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { optionalService } from '@/services/project/coauthoring/optional-service';
import { SceneBaselineService, type SceneBaseline } from '@/services/project/SceneBaselineService';
import { normOfGraph } from '@/core/scene-patch/scene-norm';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
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
  /** File path to reload from. */
  filePath: string;
  /**
   * The scene text to build the graph from — a merge result (plan §C.3 step 3). Omitted: the file
   * is read now and becomes the baseline.
   */
  sceneText?: string;
  /**
   * The baseline to record instead of the text read now: with a merge, the graph is built from
   * the merged text M while the baseline is the external version E on disk (§C.3 step 3).
   */
  baseline?: SceneBaseline;
  /** A graph already parsed from `sceneText` (the merge parses E once to normalise it). */
  graph?: SceneGraph;
  /** Mark the scene dirty after the reload (a merge result not on disk yet). */
  markDirty?: boolean;
}

/**
 * ReloadSceneOperation reloads a scene from its file source.
 * Used when external file changes are detected.
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
    const { sceneId, filePath } = this.params;

    const resourceManager = container.getService<ResourceManager>(
      container.getOrCreateToken(ResourceManager)
    );
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    try {
      const baselines = optionalService(container, SceneBaselineService);
      let diskBytes: Uint8Array | null = null;
      let diskHash: string | null = null;
      let sceneText = this.params.sceneText;
      if (sceneText === undefined) {
        // Raw bytes when the project storage is there (the baseline hash must be the disk's).
        const storage = optionalService(container, ProjectStorageService);
        const version = storage ? await readDiskVersion(storage, filePath).catch(() => null) : null;
        diskBytes = version?.bytes ?? null;
        diskHash = version?.hash ?? null;
        sceneText = version?.text ?? (await resourceManager.readText(filePath));
      }

      // When a file is being written, some browsers briefly expose a 0-byte file.
      // Retry a few times before treating this as a real invalid scene.
      for (
        let attempt = 0;
        attempt < 3 && (!sceneText || sceneText.trim().length === 0);
        attempt += 1
      ) {
        console.warn('[ReloadSceneOperation] Scene file empty; retrying read', {
          filePath,
          attempt: attempt + 1,
          contentLength: sceneText?.length ?? 0,
        });
        await new Promise(resolve => window.setTimeout(resolve, 50));
        sceneText = await resourceManager.readText(filePath);
        diskBytes = null;
        diskHash = null;
      }

      if (!sceneText || sceneText.trim().length === 0) {
        console.warn('[ReloadSceneOperation] Scene file still empty; skipping reload', {
          filePath,
          contentLength: sceneText?.length ?? 0,
        });
        return { didMutate: false };
      }

      const graph = this.params.graph ?? (await sceneManager.parseScene(sceneText, { filePath }));

      // Get current scene descriptor
      const descriptor = state.scenes.descriptors[sceneId];
      if (!descriptor) {
        throw new Error(`Scene descriptor not found: ${sceneId}`);
      }

      // The baseline is normalised from the fresh graph before anything touches it (W1).
      const norm = normOfGraph(graph);

      // Update scene manager with new graph
      sceneManager.setActiveSceneGraph(sceneId, graph);
      if (baselines) {
        if (this.params.baseline) {
          baselines.set(filePath, this.params.baseline);
        } else if (diskBytes && diskHash) {
          baselines.set(filePath, {
            sha: diskHash,
            text: SceneBaselineService.decode(diskBytes),
            norm,
          });
        } else {
          await baselines.setFromText(filePath, sceneText, norm);
        }
      }

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
