import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { HostService } from '@/host/HostService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { FlushService } from '@/services/project/FlushService';
import type { PlayTarget } from '@/state/AppState';

import { SetPlayTargetOperation } from './SetPlayTargetOperation';

/**
 * The toolbar's Play and its run modes (`appState.ui.playTarget`, the last one picked):
 *
 * - `tab` / `window` — the editor's own runner, in the Game tab or the game window, through
 *   `game.start` / `game.start-main` (so play ownership, Stop, Pause and the agent bridge apply);
 * - `browser` / `debug` — the game's own page on the dev server (`<base>?scene=…`, plus `debug`
 *   for the profiler overlay), the player a build ships, after a flush. The editor does not
 *   control that page: Play stays Play.
 *
 * "Play in …" sets the mode and runs in it; Play runs in the mode set. A run in the editor's
 * runner restarts it in the chosen surface.
 */

type OpenWindow = (url: string, target: string) => Window | null;

export interface PlayDependencies {
  readonly session: GamePlaySessionService;
  readonly host: HostService;
  readonly flush: FlushService;
  readonly openWindow?: OpenWindow;
}

interface PlayTargetInfo {
  readonly title: string;
  /** Short label for the toolbar's tooltip. */
  readonly label: string;
  readonly icon: string;
  readonly description: string;
}

export const PLAY_TARGET_INFO: Readonly<Record<PlayTarget, PlayTargetInfo>> = {
  tab: {
    title: 'Play in Game Tab',
    label: 'Game Tab',
    icon: 'play',
    description: "Run the game in the editor's Game tab",
  },
  window: {
    title: 'Play in Game Window',
    label: 'Game Window',
    icon: 'maximize-2',
    description: "Run the game in the editor's separate game window",
  },
  browser: {
    title: 'Play in Browser Tab',
    label: 'Browser Tab',
    icon: 'globe',
    description: "Run the game's own page (the player a build ships) in a browser tab",
  },
  debug: {
    title: 'Play with Profiler',
    label: 'Profiler',
    icon: 'activity',
    description: "Run the game's own page with the debug overlay: profiler, pause and step",
  },
};

/** The browser window each page mode reuses: a second Play reloads it instead of stacking tabs. */
export const PLAY_WINDOW_NAMES = { browser: 'pix3-play', debug: 'pix3-debug' } as const;

/** `<base>?scene=…` (and `debug`) on the page's origin. */
export const playPageUrl = (
  base: string,
  target: 'browser' | 'debug',
  scenePath: string | null
): string => {
  const params: string[] = [];
  if (target === 'debug') params.push('debug');
  if (scenePath) params.push(`scene=${encodeURIComponent(scenePath)}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return new URL(`${base}${query}`, window.location.origin).href;
};

/** `res://`-relative path of the active scene, or null when none is open. */
const activeScenePath = (context: CommandContext): string | null => {
  const id = context.state.scenes.activeSceneId;
  const path = id ? context.state.scenes.descriptors[id]?.filePath : undefined;
  return path ? path.replace(/^res:\/\//i, '').replace(/^\/+/, '') : null;
};

const service = <T>(context: CommandContext, token: new (...args: never[]) => T): T =>
  context.container.getService<T>(context.container.getOrCreateToken(token));

/** Run the game in `target`: the active scene (`scene`) or the project's entry scene (`entry`). */
export async function launchPlay(
  context: CommandContext,
  target: PlayTarget,
  scope: 'scene' | 'entry',
  deps: PlayDependencies
): Promise<void> {
  if (target === 'tab' || target === 'window') {
    const dispatcher = service(context, CommandDispatcher);
    if (context.state.ui.isPlaying) await dispatcher.executeById('game.stop');
    // `game.start` runs where the session's preferred host is: the game window while it is open.
    if (target === 'window') await deps.session.openOrFocusPopoutWindow();
    else await deps.session.closePopout();
    await dispatcher.executeById(scope === 'entry' ? 'game.start-main' : 'game.start');
    return;
  }
  // The page plays the files on disk (plan §C.1, as play does).
  await deps.flush.flushDirty(0).catch(() => undefined);
  const url = playPageUrl(
    deps.host.info.base,
    target,
    scope === 'scene' ? activeScenePath(context) : null
  );
  const open = deps.openWindow ?? ((href, name) => window.open(href, name));
  if (!open(url, PLAY_WINDOW_NAMES[target])) {
    console.warn(`[Pix3] The browser blocked the game window; open ${url} yourself.`);
  }
}

const needsProject = (context: CommandContext): CommandPreconditionResult =>
  context.state.project.status === 'ready'
    ? { canExecute: true }
    : { canExecute: false, reason: 'Project must be opened', scope: 'project' };

/**
 * Run → Play in Game Tab / Game Window / Browser Tab / with Profiler: set the mode and run. One
 * subclass per mode, each with literal metadata — `CommandRegistry.menu.spec.ts` reads the menu
 * slots from source.
 */
abstract class PlayInCommand extends CommandBase<void, void> {
  protected abstract readonly target: PlayTarget;

  constructor(private readonly deps: PlayDependencies) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    return needsProject(context);
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    await service(context, OperationService).invoke(
      new SetPlayTargetOperation({ target: this.target })
    );
    await launchPlay(context, this.target, 'scene', this.deps);
    return { didMutate: true, payload: undefined };
  }
}

export class PlayInGameTabCommand extends PlayInCommand {
  protected readonly target = 'tab';
  readonly metadata: CommandMetadata = {
    id: 'game.play-in-tab',
    title: 'Play in Game Tab',
    description: PLAY_TARGET_INFO.tab.description,
    keywords: ['play', 'run', 'game', 'tab'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 410,
    checked: snapshot => snapshot.ui.playTarget === 'tab',
  };
}

export class PlayInGameWindowCommand extends PlayInCommand {
  protected readonly target = 'window';
  readonly metadata: CommandMetadata = {
    id: 'game.play-in-window',
    title: 'Play in Game Window',
    description: PLAY_TARGET_INFO.window.description,
    keywords: ['play', 'run', 'game', 'window', 'popout'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 420,
    checked: snapshot => snapshot.ui.playTarget === 'window',
  };
}

export class PlayInBrowserTabCommand extends PlayInCommand {
  protected readonly target = 'browser';
  readonly metadata: CommandMetadata = {
    id: 'game.play-in-browser',
    title: 'Play in Browser Tab',
    description: PLAY_TARGET_INFO.browser.description,
    keywords: ['play', 'run', 'game', 'browser', 'page', 'player'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 430,
    checked: snapshot => snapshot.ui.playTarget === 'browser',
  };
}

export class PlayWithProfilerCommand extends PlayInCommand {
  protected readonly target = 'debug';
  readonly metadata: CommandMetadata = {
    id: 'game.play-in-debug',
    title: 'Play with Profiler',
    description: PLAY_TARGET_INFO.debug.description,
    keywords: ['play', 'run', 'debug', 'profiler', 'performance', 'fps'],
    menuPath: 'run',
    addToMenu: true,
    menuOrder: 440,
    checked: snapshot => snapshot.ui.playTarget === 'debug',
  };
}

/** One "Play in …" command per mode, in menu order. */
export const createPlayInCommands = (deps: PlayDependencies): PlayInCommand[] => [
  new PlayInGameTabCommand(deps),
  new PlayInGameWindowCommand(deps),
  new PlayInBrowserTabCommand(deps),
  new PlayWithProfilerCommand(deps),
];

abstract class PlayInModeCommand extends CommandBase<void, void> {
  protected abstract readonly scope: 'scene' | 'entry';

  constructor(private readonly deps: PlayDependencies) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    return needsProject(context);
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    await launchPlay(context, context.state.ui.playTarget, this.scope, this.deps);
    return { didMutate: true, payload: undefined };
  }
}

/** The toolbar's Play: the active scene, in the mode last picked. */
export class PlayCommand extends PlayInModeCommand {
  protected readonly scope = 'scene';
  readonly metadata: CommandMetadata = {
    id: 'game.play',
    title: 'Play',
    description: 'Run the active scene in the last run mode',
    keywords: ['play', 'run', 'game'],
    addToMenu: false,
  };
}

/** The run options' Play Game: the project's entry scene, in the mode last picked. */
export class PlayEntryCommand extends PlayInModeCommand {
  protected readonly scope = 'entry';
  readonly metadata: CommandMetadata = {
    id: 'game.play-entry',
    title: 'Play Game',
    description: "Run the project's entry scene in the last run mode",
    keywords: ['play', 'run', 'game', 'entry', 'main'],
    addToMenu: false,
  };
}
