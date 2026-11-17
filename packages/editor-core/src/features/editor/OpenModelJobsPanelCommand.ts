import { inject } from '@/fw/di';
import { LayoutManagerService, PANEL_COMPONENT_TYPES } from '@/core/LayoutManager';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * Reveal the 3D Asset Generator panel: the coding agent's model jobs (`pix3 model`), their passes
 * and the human's feedback on them (plan `.plans/model-jobs.md` Stage 2). Revealing a panel is not
 * an undoable state change, so this returns `didMutate: false` and never creates an Operation.
 */
export class OpenModelJobsPanelCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-model-jobs',
    title: '3D Asset Generator',
    description: 'Open the 3D Asset Generator panel: model jobs, their passes and your feedback',
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 311,
    keywords: ['model', '3d', 'job', 'pass', 'feedback', 'generate', 'asset', 'mesh', 'panel'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.showPanel(PANEL_COMPONENT_TYPES.modelJobs);
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
