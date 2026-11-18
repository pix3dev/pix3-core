import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import type { HostService } from '@/host/HostService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import type { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { ServiceContainer } from '@/fw/di';
import { fakeGamePage, type FakeGamePage } from '@/host/testing/fake-game-page';
import { PLAY_PAGES_CHANNEL, PlayPageLink } from '@/services/play/PlayPageLink';
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
  appState.ui.playHost = 'editor';
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

describe("Play on the game's page (playHost: page, plan play-in-page D1, D2, S5b)", () => {
  let link: PlayPageLink;
  let stopLink: () => void;
  const fakes: FakeGamePage[] = [];

  beforeEach(() => {
    const container = ServiceContainer.getInstance();
    link = container.getService<PlayPageLink>(container.getOrCreateToken(PlayPageLink));
    stopLink = link.start();
    appState.ui.playHost = 'page';
  });

  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.close();
    stopLink();
  });

  /** The editor with the link in its container; `opened` are the `window.open` calls. */
  const pageSetup = (flushOk = true) => {
    const editor = setup();
    const opened: { url: string; name: string; features?: string }[] = [];
    const container = editor.context().container;
    const services = container as unknown as { getService: (token: unknown) => unknown };
    const base = services.getService.bind(services);
    services.getService = token => (token === PlayPageLink ? link : base(token));
    editor.deps = {
      ...editor.deps,
      flush: {
        flushDirty: vi.fn(async () => {
          editor.order.push('flush');
          return flushOk ? { ok: true } : { ok: false, reason: 'write_failed' };
        }),
      } as unknown as FlushService,
      openWindow: (url, name, features) => {
        editor.order.push('open-page');
        opened.push({ url, name, features });
        return null; // `noopener`: never a handle
      },
    };
    return { ...editor, opened };
  };

  /** The page the gated window became: it asks at its gate, and says what the editor answered. */
  const gatedPage = (url: string) => {
    const gate = new URL(url).searchParams.get('gate');
    const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
    const answer = new Promise<boolean>(resolve => {
      channel.onmessage = event => {
        const frame = event.data as Record<string, unknown>;
        if (frame.type === 'gate' && frame.gate === gate) resolve(frame.go === true);
      };
    });
    channel.postMessage({ type: 'wait', gate });
    return answer.finally(() => channel.close());
  };

  it('no Play window yet: opens one noopener in the click, gated until the flush says go', async () => {
    const { deps, context, opened, order, dispatched } = pageSetup();
    appState.ui.playTarget = 'tab'; // any mode: every Play is the page
    await new PlayCommand(deps).execute(context());
    expect(order).toEqual(['open-page', 'flush']);
    expect(opened[0].name).toBe('_blank');
    expect(opened[0].features).toContain('noopener');
    expect(opened[0].url).toMatch(
      new RegExp(
        `^${window.location.origin}/\\?debug&role=designer&scene=scenes%2Flevel\\.pix3scene&gate=[\\w-]+$`
      )
    );
    // The page asks late (it loads after the flush): the decided gate still answers.
    expect(await gatedPage(opened[0].url)).toBe(true);
    expect(dispatched).toEqual([]);
    expect(appState.ui.isPlaying).toBe(false);
  });

  it('a failed flush tells the gated page no: it closes itself, the files are older', async () => {
    const { deps, context, opened } = pageSetup(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new PlayEntryCommand(deps).execute(context());
    expect(await gatedPage(opened[0].url)).toBe(false);
  });

  it('a Play window open: the second Play flushes, then tells it to load the URL, no new window', async () => {
    const { deps, context, opened, order } = pageSetup();
    const designer = fakeGamePage('designer');
    fakes.push(designer);
    await link.until(() => link.page('designer') !== null, 1_000);
    await new PlayCommand(deps).execute(context());
    expect(opened).toEqual([]);
    expect(order).toEqual(['flush']);
    expect(designer.calls.map(call => call.tool)).toEqual(['navigate']);
    expect(designer.calls[0].params.url).toBe(
      `${window.location.origin}/?debug&role=designer&scene=scenes%2Flevel.pix3scene`
    );
  });

  it('a second Play while the first window still loads waits for its hello and reuses it', async () => {
    const { deps, context, opened } = pageSetup();
    const first = new PlayCommand(deps).execute(context());
    await first;
    expect(opened).toHaveLength(1);
    const second = new PlayCommand(deps).execute(context());
    const designer = fakeGamePage('designer', { status: 'booting' });
    fakes.push(designer);
    await second;
    expect(opened).toHaveLength(1);
    expect(designer.calls.map(call => call.tool)).toEqual(['navigate']);
  });
});
