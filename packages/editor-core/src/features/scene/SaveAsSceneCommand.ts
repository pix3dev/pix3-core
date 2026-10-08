import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  SaveAsSceneOperation,
  type SaveAsSceneOperationParams,
} from '@/features/scene/SaveAsSceneOperation';
import { SceneManager } from '@pix3/runtime';

export class SaveAsSceneCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.save-as',
    title: 'Save As…',
    description: 'Save the active scene to a new file',
    keywords: ['save', 'scene', 'export', 'as'],
    menuPath: 'file',
    keybinding: 'Mod+Shift+S',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 210,
  };

  private params?: SaveAsSceneOperationParams;

  constructor(params?: SaveAsSceneOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );

    console.debug('[SaveAsSceneCommand] Checking preconditions', {
      projectStatus: context.state.project.status,
      activeSceneId: context.state.scenes.activeSceneId,
    });

    if (context.state.project.status !== 'ready') {
      console.warn('[SaveAsSceneCommand] Project not ready:', context.state.project.status);
      return {
        canExecute: false,
        reason: 'Project must be opened before saving scenes',
        scope: 'project',
        recoverable: true,
      };
    }

    const activeGraph = sceneManager.getActiveSceneGraph();
    const hasActiveScene = Boolean(activeGraph);
    console.debug('[SaveAsSceneCommand] Active scene check', {
      hasActiveScene,
      rootNodeCount: activeGraph?.rootNodes.length,
    });

    if (!hasActiveScene) {
      console.warn('[SaveAsSceneCommand] No active scene');
      return {
        canExecute: false,
        reason: 'An active scene is required to save',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    // No file picker in a dev-server editor: the target is a project path.
    // TODO(editor-core port): a proper path dialog (`.plans/editor-core-port.md` progress notes).
    let filePath = this.params?.filePath;
    if (!filePath) {
      const current = context.state.scenes.activeSceneId
        ? context.state.scenes.descriptors[context.state.scenes.activeSceneId]?.filePath
        : undefined;
      const suggested = (current ?? 'res://scenes/scene.pix3scene').replace(
        /\.pix3scene$/,
        '-copy.pix3scene'
      );
      const answer = window.prompt('Save scene as (path inside the project):', suggested);
      if (!answer) {
        return { didMutate: false, payload: undefined };
      }
      filePath = answer.startsWith('res://') ? answer : `res://${answer.replace(/^\/+/, '')}`;
    }

    const op = new SaveAsSceneOperation({ filePath, sceneId: undefined });
    const pushed = await operationService.invokeAndPush(op);

    if (pushed) {
      console.info('[SaveAsSceneCommand] Scene saved successfully');
    } else {
      console.warn('[SaveAsSceneCommand] Operation was not pushed to history');
    }

    return { didMutate: pushed, payload: undefined };
  }
}
