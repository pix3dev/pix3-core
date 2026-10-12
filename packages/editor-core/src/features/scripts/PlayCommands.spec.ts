import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import type { HostService } from '@/host/HostService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import type { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import type { FlushService } from '@/services/project/FlushService';
import { appState, getAppStateSnapshot } from '@/state';

import {
  PLAY_WINDOW_NAMES,
  PlayCommand,
  PlayEntryCommand,
  PlayInGameTabCommand,
  PlayInGameWindowCommand,
  playPageUrl,
  PlayWithProfilerCommand,
  type PlayDependencies,
} from './PlayCommands';
import { PLAY_TARGET_STORAGE_KEY } from './SetPlayTargetOperation';

const SCENE_ID = 'scene-level';

const setup = (base = '/') => {
  const order: string[] = [];
  const dispatched: string[] = [];
  const dispatcher = {
    executeById: vi.fn(async (id: string) => {
      order.push(id);
      dispatched.push(id);
      return true;
    }),
  };
  const operations = {
    invoke: vi.fn(async (operation: { perform(context: unknown): Promise<unknown> }) =>
      operation.perform({ state: appState, snapshot: getAppStateSnapshot() })
    ),
  };
  const services = new Map<unknown, unknown>([
    [CommandDispatcher, dispatcher],
    [OperationService, operations],
  ]);
  const container = {
    getOrCreateToken: (token: unknown) => token,
    getService: (token: unknown) => services.get(token),
  } as unknown as CommandContext['container'];
  const context = (): CommandContext =>
    ({
      state: appState,
      snapshot: getAppStateSnapshot(),
      container,
      requestedAt: 0,
    }) as CommandContext;
  const session = {
    openOrFocusPopoutWindow: vi.fn(async () => void order.push('open-window')),
    closePopout: vi.fn(async () => void order.push('close-window')),
  };
  const opened: { url: string; name: string }[] = [];
  const deps: PlayDependencies = {
    session: session as unknown as GamePlaySessionService,
    host: { info: { base } } as unknown as HostService,
    flush: {
      flushDirty: vi.fn(async () => {
        order.push('flush');
        return { ok: true };
      }),
    } as unknown as FlushService,
    openWindow: (url, name) => {
      order.push('open-page');
      opened.push({ url, name });
      return {} as Window;
    },
  };
  return { context, deps, session, dispatched, opened, order };
};

beforeEach(() => {
  appState.project.status = 'ready';
  appState.scenes.descriptors[SCENE_ID] = {
    filePath: 'res://scenes/level.pix3scene',
  } as (typeof appState.scenes.descriptors)[string];
  appState.scenes.activeSceneId = SCENE_ID;
});

afterEach(() => {
  appState.project.status = 'idle';
  delete appState.scenes.descriptors[SCENE_ID];
  appState.scenes.activeSceneId = null;
  appState.ui.isPlaying = false;
  appState.ui.playTarget = 'tab';
  localStorage.removeItem(PLAY_TARGET_STORAGE_KEY);
});

describe('playPageUrl', () => {
  it('names the scene and the debug mode on the base', () => {
    const origin = window.location.origin;
    expect(playPageUrl('/', 'browser', null)).toBe(`${origin}/`);
    expect(playPageUrl('/game/', 'debug', 'scenes/a b.pix3scene')).toBe(
      `${origin}/game/?debug&scene=scenes%2Fa%20b.pix3scene`
    );
  });
});

describe('Play in …', () => {
  it('needs an open project, and checks the mode Play uses', () => {
    const { deps, context } = setup();
    const command = new PlayWithProfilerCommand(deps);
    expect(command.metadata).toMatchObject({ id: 'game.play-in-debug', menuPath: 'run' });
    expect(command.metadata.checked?.(getAppStateSnapshot())).toBe(false);
    appState.ui.playTarget = 'debug';
    expect(command.metadata.checked?.(getAppStateSnapshot())).toBe(true);
    appState.project.status = 'idle';
    expect(command.preconditions(context()).canExecute).toBe(false);
  });

  it('Play with Profiler: remembers the mode, flushes, then opens the page on the active scene', async () => {
    const { deps, context, opened, order } = setup('/game/');
    await new PlayWithProfilerCommand(deps).execute(context());
    expect(appState.ui.playTarget).toBe('debug');
    expect(localStorage.getItem(PLAY_TARGET_STORAGE_KEY)).toBe('debug');
    expect(order).toEqual(['flush', 'open-page']);
    expect(opened).toEqual([
      {
        url: `${window.location.origin}/game/?debug&scene=scenes%2Flevel.pix3scene`,
        name: PLAY_WINDOW_NAMES.debug,
      },
    ]);
  });

  it('Play in Game Window: stops a run in the tab, opens the window, starts there', async () => {
    const { deps, context, order } = setup();
    appState.ui.isPlaying = true;
    await new PlayInGameWindowCommand(deps).execute(context());
    expect(order).toEqual(['game.stop', 'open-window', 'game.start']);
  });

  it('Play in Game Tab: closes the game window first, so the run lands in the tab', async () => {
    const { deps, context, order } = setup();
    await new PlayInGameTabCommand(deps).execute(context());
    expect(order).toEqual(['close-window', 'game.start']);
  });
});

describe('Play', () => {
  it('runs in the mode last picked', async () => {
    const { deps, context, opened, dispatched } = setup();
    appState.ui.playTarget = 'browser';
    await new PlayCommand(deps).execute(context());
    expect(opened[0]).toMatchObject({ name: PLAY_WINDOW_NAMES.browser });
    expect(opened[0].url).toContain('?scene=scenes%2Flevel.pix3scene');
    expect(dispatched).toEqual([]);
  });

  it('Play Game runs the entry scene: no ?scene= on the page, game.start-main in the editor', async () => {
    const page = setup();
    appState.ui.playTarget = 'browser';
    await new PlayEntryCommand(page.deps).execute(page.context());
    expect(page.opened[0].url).toBe(`${window.location.origin}/`);

    const editor = setup();
    appState.ui.playTarget = 'tab';
    await new PlayEntryCommand(editor.deps).execute(editor.context());
    expect(editor.dispatched).toEqual(['game.start-main']);
  });
});
