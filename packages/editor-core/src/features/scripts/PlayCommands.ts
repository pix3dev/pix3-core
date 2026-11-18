import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { HostService } from '@/host/HostService';
import {
  gamePageUrl,
  OPEN_WAIT_MS,
  pageWindowFeatures,
  PlayPageLink,
} from '@/services/play/PlayPageLink';
import { FlushService } from '@/services/project/FlushService';

/**
 * Run → Play Game / Play Scene / Stop and the toolbar's Play (plan play-in-page): every Play is a
 * fresh load of the game's own page after a flush — see {@link launchPagePlay}. The editor runs no
 * game and keeps no play state (D4); Stop closes the Play window over the link.
 */

type OpenWindow = (url: string, target: string, features?: string) => Window | null;

export interface PlayDependencies {
  readonly host: HostService;
  readonly flush: FlushService;
  readonly openWindow?: OpenWindow;
}

/** `res://`-relative path of the active scene, or null when none is open. */
const activeScenePath = (context: CommandContext): string | null => {
  const id = context.state.scenes.activeSceneId;
  const path = id ? context.state.scenes.descriptors[id]?.filePath : undefined;
  return path ? path.replace(/^res:\/\//i, '').replace(/^\/+/, '') : null;
};

const service = <T>(context: CommandContext, token: new (...args: never[]) => T): T =>
  context.container.getService<T>(context.container.getOrCreateToken(token));

/**
 * Play on the game's page (D1, D2, S5b): a fresh load of `/?debug&role=designer[&scene=…]` (D5)
 * after a flush — the page must play the files as edited.
 *
 * The page lives in a window opened `noopener` (its own renderer process: a busy game does not
 * stall the editor), so the editor holds no handle on it and cannot navigate it later:
 *
 * - no Play window yet: open it in the click (a popup blocker honours a click only for a few
 *   seconds, and the flush is async) straight onto the game's URL with `&gate=<id>`; the page
 *   waits at the gate, and the flush's outcome opens it (`go`) or closes the page;
 * - a Play window open (it said hello): flush, then tell it to load the URL (`navigate`).
 *
 * With `noopener` `window.open` returns null whatever happens; a page that never says hello was
 * blocked, and the console says where to open it.
 */
async function launchPagePlay(
  context: CommandContext,
  scope: 'scene' | 'entry',
  deps: PlayDependencies
): Promise<void> {
  const open = deps.openWindow ?? ((href, name, features) => window.open(href, name, features));
  const link = service(context, PlayPageLink);
  const url = gamePageUrl(
    deps.host.info.base,
    'designer',
    scope === 'scene' ? activeScenePath(context) : null
  );
  const features = pageWindowFeatures(context.state.project.manifest?.viewportBaseSize);
  // A second Play while the first window is still loading addresses that window, not a new one.
  if (link.isOpening('designer')) {
    await link.until(() => link.page('designer') !== null, OPEN_WAIT_MS);
  }
  const gate = link.page('designer') ? null : link.openGate('designer');
  if (gate) open(`${url}&gate=${gate}`, '_blank', features);
  const flushed = await deps.flush.flushDirty(0);
  if (gate) link.releaseGate(gate, flushed.ok);
  if (!flushed.ok) {
    console.warn(
      `[Pix3] Play stopped: the editor could not write its unsaved edits (${String(flushed.reason)}).`
    );
    return;
  }
  const blocked = (): void =>
    console.warn(`[Pix3] The browser blocked the game window; open ${url} yourself.`);
  if (gate) {
    void link
      .until(() => link.page('designer') !== null, OPEN_WAIT_MS)
      .then(seen => {
        if (!seen) blocked();
      });
    return;
  }
  const navigated = await link.call('designer', 'navigate', { url });
  // The window went away meanwhile: a new one (outside the click, so a blocker may refuse it).
  if (navigated.ok === false) open(url, '_blank', features);
}

const needsProject = (context: CommandContext): CommandPreconditionResult =>
  context.state.project.status === 'ready'
    ? { canExecute: true }
    : { canExecute: false, reason: 'Project must be opened', scope: 'project' };

abstract class PlayScopeCommand extends CommandBase<void, void> {
  protected abstract readonly scope: 'scene' | 'entry';

  constructor(private readonly deps: PlayDependencies) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    return needsProject(context);
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    await launchPagePlay(context, this.scope, this.deps);
    return { didMutate: false, payload: undefined };
  }
}

/** The toolbar's Play and Run → Play Scene: the active scene. A second Play reloads the window. */
export class PlayCommand extends PlayScopeCommand {
  protected readonly scope = 'scene';
  readonly metadata: CommandMetadata = {
    id: 'game.play',
    title: 'Play Scene',
    description: "Run the active scene on the game's page",
    keywords: ['play', 'run', 'game', 'scene', 'current'],
    menuPath: 'run',
    keybinding: 'F6',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 110,
  };
}

/** Run → Play Game: the project's entry scene (the full flow, usually a menu first). */
export class PlayEntryCommand extends PlayScopeCommand {
  protected readonly scope = 'entry';
  readonly metadata: CommandMetadata = {
    id: 'game.play-entry',
    title: 'Play Game',
    description: "Run the project's entry scene on the game's page",
    keywords: ['play', 'run', 'game', 'entry', 'main'],
    menuPath: 'run',
    keybinding: 'F5 | Mod+Ctrl+Enter',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 100,
  };
}

/** Run → Stop (F8): close the Play window. The agent's page is the agent's (`pix3_play stop`). */
export class StopGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.stop',
    title: 'Stop',
    description: 'Close the Play window',
    keywords: ['stop', 'game', 'close'],
    menuPath: 'run',
    keybinding: 'F8 | Mod+Ctrl+Shift+Enter',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 200,
  };

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    await service(context, PlayPageLink).close('designer');
    return { didMutate: false, payload: undefined };
  }
}
