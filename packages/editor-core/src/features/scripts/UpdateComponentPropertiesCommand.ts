import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  PREFAB_COMPONENT_LOCK_REASON,
  isPrefabInstanceNode,
} from '@/features/scene/scene-command-utils';
import {
  UpdateComponentPropertiesOperation,
  type UpdateComponentPropertiesParams,
} from './UpdateComponentPropertiesOperation';

/** Several properties of one component in one undo step (the inspector's "Revert N changes"). */
export class UpdateComponentPropertiesCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'scripts.update-component-properties',
    title: 'Update Component Properties',
    description: 'Update several script component properties on a node as one step',
    keywords: ['update', 'revert', 'script', 'component', 'properties'],
  };

  constructor(private readonly params: UpdateComponentPropertiesParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.snapshot.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    if (isPrefabInstanceNode(context, this.params.nodeId)) {
      return { canExecute: false, reason: PREFAB_COMPONENT_LOCK_REASON, scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<object>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operations.invokeAndPush(
      new UpdateComponentPropertiesOperation(this.params)
    );
    return { didMutate: pushed, payload: {} };
  }
}
