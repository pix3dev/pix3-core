import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { SaveAsPrefabOperation } from '@/features/scene/SaveAsPrefabOperation';
import { SceneManager } from '@pix3/runtime';

export interface SaveAsPrefabCommandParams {
  nodeId?: string;
  prefabPath?: string;
}

export class SaveAsPrefabCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.save-as-prefab',
    title: 'Save Branch as Prefab…',
    description: 'Save selected node branch as prefab and replace it with instance',
    keywords: ['prefab', 'save', 'branch', 'instance'],
    menuPath: 'node',
    addToMenu: true,
    menuOrder: 300,
  };

  private readonly params?: SaveAsPrefabCommandParams;

  constructor(params?: SaveAsPrefabCommandParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before saving prefabs',
        scope: 'project',
        recoverable: true,
      };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    if (!sceneManager.getActiveSceneGraph()) {
      return {
        canExecute: false,
        reason: 'An active scene is required to save a prefab',
        scope: 'scene',
      };
    }

    const nodeId = this.params?.nodeId ?? context.state.selection.primaryNodeId;
    if (!nodeId) {
      return {
        canExecute: false,
        reason: 'Select a node to save as prefab',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const nodeId = this.params?.nodeId ?? context.state.selection.primaryNodeId;
    if (!nodeId) {
      return { didMutate: false, payload: undefined };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const sceneGraph = sceneManager.getActiveSceneGraph();
    const nodeNameFromScene = sceneGraph?.nodeMap.get(nodeId)?.name ?? null;
    const prefabPath = this.params?.prefabPath ?? this.defaultPrefabPath(nodeId, nodeNameFromScene);
    if (!prefabPath) {
      return { didMutate: false, payload: undefined };
    }

    const pushed = await operationService.invokeAndPush(
      new SaveAsPrefabOperation({
        nodeId,
        prefabPath,
      })
    );

    return { didMutate: pushed, payload: undefined };
  }

  /** No save picker in a dev-server editor: prefabs go to the conventional `prefabs/` folder. */
  private defaultPrefabPath(nodeId: string, nodeName: string | null): string {
    return `res://prefabs/${this.toSceneFileBaseName(nodeName, nodeId)}.pix3scene`;
  }

  private toSceneFileBaseName(nodeName: string | null, fallbackId: string): string {
    const source = (nodeName && nodeName.trim().length > 0 ? nodeName : fallbackId).trim();
    const withoutExtension = source.replace(/\.pix3scene$/i, '');
    const sanitized = withoutExtension
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '_')
      .replace(/-+/g, '-')
      .replace(/_+/g, '_')
      .replace(/^[-_.]+|[-_.]+$/g, '');

    return sanitized || 'prefab';
  }
}
