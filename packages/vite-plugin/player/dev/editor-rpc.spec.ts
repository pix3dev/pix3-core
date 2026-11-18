import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installEditorRpc,
  openPageLink,
  pageRole,
  PLAY_PAGES_CHANNEL,
  type RpcPage,
} from './editor-rpc';

/**
 * The game page's end of the editor link (plan play-in-page D6, D8, S5b): `hello` as the link opens
 * and again once booted, the Play gate, calls
 * addressed by role and `loadId`, `page_reloaded` for a call meant for another load, the page's
 * errors and "Show in editor" as frames. The editor's end is editor-core's `PlayPageLink`.
 */

const frames: Record<string, unknown>[] = [];
let editor: BroadcastChannel | null = null;
let disposers: (() => void)[] = [];

const listen = (): BroadcastChannel => {
  const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
  channel.onmessage = event => frames.push(event.data as Record<string, unknown>);
  return channel;
};

const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const waitFrame = async (
  predicate: (frame: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 100; i += 1) {
    const found = frames.find(predicate);
    if (found) return found;
    await settle(10);
  }
  throw new Error('no such frame');
};

const fakePage = (overrides: Partial<RpcPage['state']> = {}) => {
  const errorListeners = new Set<(error: { message: string; where: string | null }) => void>();
  const runner = { paused: false, resume: vi.fn(() => void (runner.paused = false)) };
  const debug = {
    paused: false,
    pause: vi.fn(() => void (debug.paused = true)),
    resume: vi.fn(() => void (debug.paused = false)),
    onError: (listener: (error: { message: string; where: string | null }) => void) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
  const tools = {
    call: vi.fn(async (name: string) => {
      if (name === 'game_run') runner.paused = true; // pauseOnOutcome
      return { ok: true, tool: name };
    }),
  };
  const state = {
    loadId: 'load-1',
    rev: 7,
    status: 'running',
    frames: 3,
    scene: 'scenes/main.pix3scene',
    runner,
    tools,
    loadTools: vi.fn(async () => true),
    ...overrides,
  };
  return {
    page: { state, debug } as RpcPage,
    state,
    runner,
    debug,
    tools,
    emitError: (message: string) => {
      for (const listener of errorListeners) listener({ message, where: 'update · ship' });
    },
  };
};

const call = (tool: string, params: Record<string, unknown> = {}, loadId = 'load-1') => {
  const id = `call-${Math.random()}`;
  editor?.postMessage({ type: 'call', id, role: 'agent', loadId, tool, params });
  return waitFrame(frame => frame.type === 'result' && frame.id === id).then(
    frame => frame.value as Record<string, unknown>
  );
};

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  editor?.close();
  editor = null;
  frames.length = 0;
});

describe('editor-rpc (the game page end of the editor link)', () => {
  it('reads the role from ?role=, and only designer or agent', () => {
    expect(pageRole('?debug&role=agent&mute')).toBe('agent');
    expect(pageRole('?role=designer')).toBe('designer');
    expect(pageRole('?role=boss')).toBeNull();
    expect(pageRole('?debug')).toBeNull();
  });

  it('says hello booting at once, ready once the game booted and the tools loaded, and to who', async () => {
    editor = listen();
    const { page, state } = fakePage({ status: 'booting' });
    const rpc = installEditorRpc(page, 'agent');
    disposers.push(() => rpc?.dispose());
    await settle(150);
    expect(frames.filter(frame => frame.type === 'hello').map(frame => frame.page)).toEqual([
      expect.objectContaining({ loadId: 'load-1', status: 'booting' }),
    ]);
    frames.length = 0;
    state.status = 'running';
    const hello = await waitFrame(frame => frame.type === 'hello');
    expect(state.loadTools).toHaveBeenCalled();
    expect(hello.page).toMatchObject({
      role: 'agent',
      loadId: 'load-1',
      rev: 7,
      status: 'running',
    });
    frames.length = 0;
    editor.postMessage({ type: 'who' });
    await waitFrame(frame => frame.type === 'hello');
  });

  it('opens before the game: hello, navigate and close while booting; the rest waits for the game', async () => {
    editor = listen();
    const win = Object.assign(new EventTarget(), {
      location: {
        href: 'http://localhost/?debug&role=agent',
        search: '?debug&role=agent',
        replace: vi.fn(),
      },
      close: vi.fn(),
      focus: vi.fn(),
    });
    const link = openPageLink('agent', win as unknown as Window, 'load-1');
    disposers.push(() => link?.dispose());
    expect(link?.gate).toBeNull();
    expect((await waitFrame(frame => frame.type === 'hello')).page).toMatchObject({
      role: 'agent',
      loadId: 'load-1',
      status: 'booting',
      rev: null,
    });
    expect(await call('status')).toMatchObject({ ok: true, page: { status: 'booting' } });
    expect(await call('live_node')).toMatchObject({ ok: false, reason: 'no_game_page' });
    expect(await call('navigate', { url: '/?debug&role=agent&start=2' })).toEqual({ ok: true });
    expect(await call('close')).toEqual({ ok: true });
    await settle();
    expect(win.location.replace).toHaveBeenCalledWith('/?debug&role=agent&start=2');
    expect(win.close).toHaveBeenCalled();
    // The booted page joins the same link and load.
    const fake = fakePage();
    window.__PIX3_PAGE_LINK__ = link ?? undefined;
    disposers.push(() => delete window.__PIX3_PAGE_LINK__);
    const rpc = installEditorRpc(fake.page, 'agent');
    expect(rpc?.info()).toMatchObject({ loadId: 'load-1' });
    expect(await call('live_node', { nodeId: 'ship' })).toEqual({ ok: true, tool: 'live_node' });
  });

  it('a gated page waits for the editor: go boots it (and drops ?gate=), no closes it', async () => {
    editor = listen();
    const gatedWin = () =>
      Object.assign(new EventTarget(), {
        location: {
          href: 'http://localhost/?debug&role=designer&gate=g1',
          pathname: '/',
          search: '?debug&role=designer&gate=g1',
          hash: '',
        },
        history: { state: null, replaceState: vi.fn() },
        close: vi.fn(),
      });
    const win = gatedWin();
    const link = openPageLink('designer', win as unknown as Window, 'load-1');
    disposers.push(() => link?.dispose());
    expect(await waitFrame(frame => frame.type === 'wait')).toEqual({ type: 'wait', gate: 'g1' });
    let opened = false;
    void link?.gate?.then(() => (opened = true));
    editor.postMessage({ type: 'gate', gate: 'other', go: true });
    await settle();
    expect(opened).toBe(false);
    editor.postMessage({ type: 'gate', gate: 'g1', go: true });
    await settle();
    expect(opened).toBe(true);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/?debug&role=designer');

    const refused = gatedWin();
    const second = openPageLink('designer', refused as unknown as Window, 'load-2');
    disposers.push(() => second?.dispose());
    editor.postMessage({ type: 'gate', gate: 'g1', go: false });
    await settle();
    expect(refused.close).toHaveBeenCalled();
  });

  it('answers a call for its role and load; another load is page_reloaded, another role silence', async () => {
    editor = listen();
    const fake = fakePage();
    const rpc = installEditorRpc(fake.page, 'agent');
    disposers.push(() => rpc?.dispose());
    await waitFrame(frame => frame.type === 'hello');

    expect(await call('live_node', { nodeId: 'ship' })).toEqual({ ok: true, tool: 'live_node' });
    expect(fake.tools.call).toHaveBeenCalledWith('live_node', { nodeId: 'ship' });

    const stale = await call('game_run', {}, 'load-0');
    expect(stale).toMatchObject({ ok: false, reason: 'page_reloaded' });
    expect(fake.tools.call).not.toHaveBeenCalledWith('game_run', {});

    const id = 'designer-call';
    editor.postMessage({ type: 'call', id, role: 'designer', loadId: 'load-1', tool: 'status' });
    await settle(50);
    expect(frames.some(frame => frame.id === id)).toBe(false);

    expect(await call('reboot')).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('marks the pause a game_run left, and resume lifts it', async () => {
    editor = listen();
    const fake = fakePage();
    const rpc = installEditorRpc(fake.page, 'agent');
    disposers.push(() => rpc?.dispose());
    await waitFrame(frame => frame.type === 'hello');
    await call('game_run', { until: [] });
    expect(((await call('status')).page as Record<string, unknown>).pausedBy).toBe('pix3_game_run');
    const resumed = await call('resume');
    expect(fake.runner.resume).toHaveBeenCalled();
    expect(resumed.page).toMatchObject({ paused: false });
    expect((resumed.page as Record<string, unknown>).pausedBy).toBeUndefined();
    await call('pause');
    expect(fake.debug.pause).toHaveBeenCalled();
  });

  it('reports the page errors and "Show in editor", and says bye on pagehide', async () => {
    editor = listen();
    const fake = fakePage();
    const rpc = installEditorRpc(fake.page, 'designer');
    disposers.push(() => rpc?.dispose());
    await waitFrame(frame => frame.type === 'hello');
    fake.emitError('boom');
    expect(await waitFrame(frame => frame.type === 'log')).toMatchObject({
      role: 'designer',
      loadId: 'load-1',
      message: 'boom',
      where: 'update · ship',
    });
    rpc?.select('ship');
    expect(await waitFrame(frame => frame.type === 'select')).toMatchObject({ nodeId: 'ship' });
    window.dispatchEvent(new Event('pagehide'));
    expect(await waitFrame(frame => frame.type === 'bye')).toMatchObject({
      role: 'designer',
      loadId: 'load-1',
    });
  });

  it("bye says whether the page reloads or its window closes (the Navigation API's navigate)", async () => {
    const byes = async (navigate: { sameDocument: boolean } | null): Promise<unknown> => {
      frames.length = 0;
      const channel = listen();
      const win = Object.assign(new EventTarget(), {
        location: window.location,
        navigation: new EventTarget(),
      });
      const rpc = installEditorRpc(fakePage().page, 'agent', win as unknown as Window);
      await waitFrame(frame => frame.type === 'hello');
      if (navigate) {
        win.navigation.dispatchEvent(
          Object.assign(new Event('navigate'), { destination: navigate })
        );
      }
      win.dispatchEvent(new Event('pagehide'));
      const bye = await waitFrame(frame => frame.type === 'bye');
      rpc?.dispose();
      channel.close();
      return bye.reloading;
    };
    expect(await byes({ sameDocument: false })).toBe(true); // Vite's location.reload(), navigate
    expect(await byes({ sameDocument: true })).toBe(false); // a hash change, then the window closed
    expect(await byes(null)).toBe(false); // the window closed
  });
});
