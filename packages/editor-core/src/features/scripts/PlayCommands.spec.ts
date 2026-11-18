import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import type { HostService } from '@/host/HostService';
import { ServiceContainer } from '@/fw/di';
import { fakeGamePage, type FakeGamePage } from '@/host/testing/fake-game-page';
import { PLAY_PAGES_CHANNEL, PlayPageLink } from '@/services/play/PlayPageLink';
import type { FlushService } from '@/services/project/FlushService';
import { appState, getAppStateSnapshot } from '@/state';

import {
  PlayCommand,
  PlayEntryCommand,
  StopGameCommand,
  type PlayDependencies,
} from './PlayCommands';

const SCENE_ID = 'scene-level';

const setup = (base = '/') => {
  const order: string[] = [];
  const services = new Map<unknown, unknown>();
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
  const deps: PlayDependencies = {
    host: { info: { base } } as unknown as HostService,
    flush: {} as FlushService,
  };
  return { context, deps, order };
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
});

describe('Run menu', () => {
  it('Play Game (F5), Play Scene (F6), Stop (F8); Play needs an open project', () => {
    const { deps, context } = setup();
    expect(new PlayEntryCommand(deps).metadata).toMatchObject({ menuPath: 'run', menuOrder: 100 });
    expect(new PlayCommand(deps).metadata).toMatchObject({ menuPath: 'run', keybinding: 'F6' });
    expect(new StopGameCommand().metadata).toMatchObject({ id: 'game.stop', menuOrder: 200 });
    appState.project.status = 'idle';
    expect(new PlayCommand(deps).preconditions(context()).canExecute).toBe(false);
  });
});

describe("Play on the game's page (plan play-in-page D1, D2, S5b)", () => {
  let link: PlayPageLink;
  let stopLink: () => void;
  const fakes: FakeGamePage[] = [];

  beforeEach(() => {
    const container = ServiceContainer.getInstance();
    link = container.getService<PlayPageLink>(container.getOrCreateToken(PlayPageLink));
    stopLink = link.start();
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
    const { deps, context, opened, order } = pageSetup();
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

  it('Play Game loads the entry scene: no scene= on the page', async () => {
    const { deps, context, opened } = pageSetup();
    await new PlayEntryCommand(deps).execute(context());
    expect(opened[0].url).toMatch(
      new RegExp(`^${window.location.origin}/\\?debug&role=designer&gate=[\\w-]+$`)
    );
  });

  it('Stop closes the Play window over the link', async () => {
    const { context } = pageSetup();
    const designer = fakeGamePage('designer');
    fakes.push(designer);
    await link.until(() => link.page('designer') !== null, 1_000);
    await new StopGameCommand().execute(context());
    expect(designer.calls.map(call => call.tool)).toEqual(['close']);
  });
});
