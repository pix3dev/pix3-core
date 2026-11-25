import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { OperationService } from '@/services/core/OperationService';
import { resolveCameraViewNode } from '@/services/viewport/ViewportCameraView';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

/**
 * View ▸ Look Through Camera: the viewport shows the scene's camera — its pose, projection, fov and
 * clipping, at the project's design aspect — with the 2D layer laid over the same frame.
 */
export class ToggleCameraViewCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.look-through-camera',
    title: 'Look Through Camera',
    description:
      "Show the viewport through the scene camera (the one picked in the camera menu, else the game's), at the design aspect",
    keywords: ['camera', 'view', 'look through', 'game view', 'fov', 'perspective', 'toggle'],
    menuPath: 'view',
    keybinding: '0',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 220,
    checked: snapshot => snapshot.ui.lookThroughCamera,
  };

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.ui.lookThroughCamera) {
      return { canExecute: true };
    }
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getActiveSceneGraph();
    const sceneId = context.state.scenes.activeSceneId;
    const camera = graph
      ? resolveCameraViewNode(
          graph.rootNodes,
          sceneId ? (context.state.scenes.previewCameraNodeIds[sceneId] ?? null) : null,
          graph.nodeMap
        )
      : null;
    return camera
      ? { canExecute: true }
      : { canExecute: false, reason: 'The scene has no Camera3D', scope: 'scene' };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(new ToggleUIFlagOperation('lookThroughCamera', 'Look Through Camera'));
    return { didMutate: true, payload: undefined };
  }
}
