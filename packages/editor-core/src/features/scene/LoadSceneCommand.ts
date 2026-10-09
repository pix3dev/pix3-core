import { inject } from '@/fw/di';
import { ResourceManager } from '@/services/assets/ResourceManager';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { SceneGraph } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { optionalService } from '@/services/project/disk/optional-service';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { readDiskVersion, type DiskVersion } from '@/services/project/disk/disk-version';
import { normOfGraph } from '@/core/scene-patch/scene-norm';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';

export interface LoadSceneCommandPayload {
  filePath: string; // res:// path
  sceneId?: string; // optional override id
}

export class LoadSceneCommand extends CommandBase<LoadSceneCommandPayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.load',
    title: 'Load Scene',
    description: 'Load a scene file into the editor',
    keywords: ['load', 'scene', 'open'],
  };

  @inject(ResourceManager) private readonly resources!: ResourceManager;
  @inject(SceneManager) private readonly sceneManager!: SceneManager;
  @inject(ProjectStorageService) private readonly storage!: ProjectStorageService;

  private payload?: LoadSceneCommandPayload;

  constructor(payload?: LoadSceneCommandPayload) {
    super();
    this.payload = payload;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before loading scenes',
        scope: 'project',
        recoverable: true,
      };
    }

    if (!this.payload?.filePath) {
      return {
        canExecute: false,
        reason: 'File path is required to load a scene',
        scope: 'service',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<LoadSceneCommandPayload>> {
    if (!this.payload) {
      throw new Error('LoadSceneCommand requires payload with filePath');
    }

    const { filePath } = this.payload;
    const { state } = context;

    state.scenes.loadState = 'loading';
    state.scenes.loadError = null;

    try {
      const baselines = filePath.startsWith('res://')
        ? optionalService(context.container, SceneBaselineService)
        : null;
      // Read the raw bytes once, hash THOSE and parse their text, so the baseline is exactly what
      // was loaded (a BOM would make a text hash never match the disk's).
      const diskVersion = baselines ? await this.readDiskVersionSafe(filePath) : null;
      const sceneText = diskVersion?.text ?? (await this.resources.readText(filePath));
      const graph = await this.sceneManager.parseScene(sceneText, { filePath });
      if (baselines && diskVersion) {
        // Plan §C.2: the baseline of every later flush, normalised from the graph this text built
        // before anything touches it (`.plans/write-model.md` W1).
        baselines.set(filePath, {
          sha: diskVersion.hash,
          text: SceneBaselineService.decode(diskVersion.bytes),
          norm: normOfGraph(graph),
        });
      }

      const activeId = this.payload.sceneId ?? state.scenes.activeSceneId ?? 'startup-scene';
      const existing = state.scenes.descriptors[activeId] ?? null;
      const sceneName = this.deriveSceneName(filePath, graph.metadata ?? {}, existing?.name);

      let lastModifiedTime: number | null = null;
      try {
        if (filePath.startsWith('res://')) {
          lastModifiedTime = await this.storage.getLastModified(filePath);
        }
      } catch (error) {
        console.debug('[LoadSceneCommand] Could not read the modification time:', error);
      }

      if (!existing) {
        state.scenes.descriptors[activeId] = {
          id: activeId,
          filePath,
          name: sceneName,
          version: graph.version ?? '1.0.0',
          isDirty: false,
          lastSavedAt: null,
          lastModifiedTime,
        };
        state.scenes.activeSceneId = activeId;
      } else {
        state.scenes.descriptors[activeId] = {
          ...existing,
          filePath,
          name: sceneName,
          version: graph.version ?? existing.version,
          isDirty: false,
          lastModifiedTime,
        } as typeof existing;
        state.scenes.activeSceneId = activeId;
      }

      this.sceneManager.setActiveSceneGraph(activeId, graph);

      // Reloading into an already-open scene replaces its graph in place (the old
      // nodes are disposed by setActiveSceneGraph). The active-scene id is
      // unchanged, so OperationService's per-scene switch won't fire — clear this
      // scene's undo history explicitly so entries don't reference detached nodes.
      if (existing) {
        const operationService = context.container.getService<OperationService>(
          context.container.getOrCreateToken(OperationService)
        );
        operationService.clearHistory();
      }

      state.scenes.hierarchies[activeId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        // Store Three.js nodes as non-proxied references to avoid DOM Illegal invocation errors
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };
      state.scenes.loadState = 'ready';
      state.scenes.lastLoadedAt = Date.now();
      state.scenes.pendingScenePaths = state.scenes.pendingScenePaths.filter(
        (p: string) => p !== filePath
      );
      state.project.lastOpenedScenePath = filePath;

      return {
        didMutate: true,
        payload: this.payload,
      };
    } catch (error) {
      let message = 'Failed to load scene.';
      if (error instanceof SceneValidationError) {
        message = `${message} Validation issues: ${error.details.join('; ')}`;
      } else if (error instanceof Error) {
        message = `${message} ${error.message}`;
      }
      state.scenes.loadState = 'error';
      state.scenes.loadError = message;
      console.error('[LoadSceneCommand] Scene load failed:', error);
      throw error;
    }
  }

  private async readDiskVersionSafe(filePath: string): Promise<DiskVersion | null> {
    try {
      return await readDiskVersion(this.storage, filePath);
    } catch {
      return null;
    }
  }

  private deriveSceneName(
    filePath: string,
    metadata: SceneGraph['metadata'] | Record<string, unknown>,
    existingName?: string | null
  ): string {
    const preserved = typeof existingName === 'string' ? existingName.trim() : '';
    if (preserved) return preserved;

    const metaName = this.extractMetadataName(metadata);
    if (metaName) return metaName;

    const normalizedPath = this.resources.normalize(filePath).replace(/\\+/g, '/');
    const segments = normalizedPath.split('/').filter(Boolean);
    const basename = segments.length ? segments[segments.length - 1] : normalizedPath;
    const withoutExtension = basename.replace(/\.[^./]+$/i, '');
    const words = withoutExtension
      .split(/[^a-z0-9]+/i)
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1));
    return words.length ? words.join(' ') : 'Scene';
  }

  private extractMetadataName(metadata: SceneGraph['metadata'] | Record<string, unknown>): string {
    const candidates = [
      (metadata as Record<string, unknown>)?.name,
      (metadata as Record<string, unknown>)?.title,
      (metadata as Record<string, unknown>)?.displayName,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed) return trimmed;
      }
    }
    return '';
  }
}
