import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { hostFailureOf } from '@/host/EditorHost';
import { HostNoticeService } from '@/host/HostNoticeService';
import { HostService } from '@/host/HostService';

/**
 * Run > Build Playable: `POST /__pix3/api/build` through the host (plan §B.6 «Из UI»). The dev
 * server flushes this editor's unsaved scenes, runs the project's `vite build` and answers with
 * the artifact; the outcome lands in the host banner (and the log). Nothing in the document
 * changes, so the command is not undoable and never touches the operation gateway.
 */
export class BuildGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.build',
    title: 'Build Playable',
    description: 'Build the single-file playable (dist/index.html) with the project’s vite build',
    keywords: ['build', 'export', 'playable', 'html', 'dist'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 400,
  };

  private running = false;

  constructor(
    private readonly hostService: HostService,
    private readonly notices: HostNoticeService
  ) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'No project is open',
        scope: 'project',
        recoverable: true,
      };
    }
    if (!this.hostService.host.build) {
      return {
        canExecute: false,
        reason: 'This dev server has no playable build (pix3({ build: false }))',
        scope: 'project',
        recoverable: false,
      };
    }
    if (this.running) {
      return {
        canExecute: false,
        reason: 'A build is running',
        scope: 'project',
        recoverable: true,
      };
    }
    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    const build = this.hostService.host.build;
    if (!build) return { didMutate: false, payload: undefined };
    this.running = true;
    const key = 'build';
    this.notices.show({ key, message: 'Building the playable…' });
    try {
      const result = await build.run({ format: 'html' });
      this.notices.show({
        key,
        message: `Built ${result.path}`,
        detail: `${(result.bytes / 1024).toFixed(1)} KiB, sha256 ${result.sha256.slice(0, 12)}`,
      });
    } catch (error) {
      const failure = hostFailureOf(error);
      this.notices.show({
        key,
        tone: 'warn',
        message: 'The build failed',
        detail: failure?.message ?? (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      this.running = false;
    }
    return { didMutate: false, payload: undefined };
  }
}
