import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { HostService } from '@/host/HostService';
import { FlushService } from '@/services/project/FlushService';

/** The window every Open Debug Window reuses: a second click reloads it instead of stacking tabs. */
export const DEBUG_WINDOW_NAME = 'pix3-debug';

type OpenWindow = (url: string, target: string) => Window | null;

/**
 * Debug mode: the game's own page (`<base>?debug`, served by the plugin's player) with the debug
 * overlay — frame times, renderer counters, long frames, audio, errors, pause / step. It runs
 * outside the editor, so its numbers carry none of the editor's cost, and the same URL works on a
 * phone on the LAN. The page plays the files on disk, so dirty scenes are flushed first (plan
 * §C.1, as play does).
 */
export class OpenDebugWindowCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.open-debug-window',
    title: 'Open Debug Window',
    description: 'Run the game on its own page with the debug overlay (profiler, pause / step)',
    keywords: ['debug', 'profiler', 'performance', 'fps', 'window'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 310,
  };

  constructor(
    private readonly host: HostService,
    private readonly flush: FlushService,
    private readonly openWindow: OpenWindow = (url, target) => window.open(url, target)
  ) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return { canExecute: false, reason: 'Project must be opened', scope: 'project' };
    }
    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.flush.flushDirty(0).catch(() => undefined);
    const url = new URL(`${this.host.info.base}?debug`, window.location.origin).href;
    if (!this.openWindow(url, DEBUG_WINDOW_NAME)) {
      console.warn(`[Pix3] The browser blocked the debug window; open ${url} yourself.`);
    }
    return { didMutate: false, payload: undefined };
  }
}
