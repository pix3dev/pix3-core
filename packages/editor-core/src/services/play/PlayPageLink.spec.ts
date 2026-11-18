import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { fakeGamePage, type FakeGamePage } from '@/host/testing/fake-game-page';
import { appState, resetAppState } from '@/state';

import { gamePageUrl, PlayPageLink } from './PlayPageLink';

/**
 * The editor's end of the link to the game pages (plan play-in-page D6–D8): calls addressed by
 * role and load and correlated by id, `page_reloaded` when the page goes away under a call, the
 * readiness of a page against the last sync, and the pages' errors.
 */

let link: PlayPageLink;
let stop: () => void;
const pages: FakeGamePage[] = [];

const page = (...args: Parameters<typeof fakeGamePage>): FakeGamePage => {
  const created = fakeGamePage(...args);
  pages.push(created);
  return created;
};

beforeEach(() => {
  resetAppState();
  const container = ServiceContainer.getInstance();
  link = container.getService<PlayPageLink>(container.getOrCreateToken(PlayPageLink));
  stop = link.start();
});

afterEach(() => {
  for (const created of pages.splice(0)) created.close();
  stop();
});

describe('PlayPageLink', () => {
  it('finds the pages already open, and loses one on its bye', async () => {
    const agent = page('agent', { rev: 4 });
    page('designer');
    expect((await link.discover(50)).map(found => found.role)).toEqual(['designer', 'agent']);
    expect(link.page('agent')).toMatchObject({ loadId: agent.info.loadId, rev: 4 });
    agent.close();
    await vi.waitFor(() => expect(link.page('agent')).toBeNull());
    expect(link.isReloading('agent', 1_000)).toBe(true);
  });

  it('a page whose window closed is gone at once, not reloading', async () => {
    const agent = page('agent');
    await link.discover(50);
    agent.close(false);
    await vi.waitFor(() => expect(link.page('agent')).toBeNull());
    expect(link.isReloading('agent', 1_000)).toBe(false);
  });

  it('forgets a page that agreed to close though its bye never came (headless Chrome)', async () => {
    page('designer'); // answers close {ok: true} and never says bye
    await link.discover(50);
    const changes = vi.fn();
    const off = link.onPagesChanged(changes);
    expect(await link.close('designer')).toMatchObject({ ok: true });
    expect(link.page('designer')).toBeNull();
    expect(link.isReloading('designer', 1_000)).toBe(false);
    expect(changes).toHaveBeenCalled();
    off();
  });

  it('addresses a call by role and load, and matches answers by id', async () => {
    const agent = page('agent');
    const designer = page('designer');
    await link.discover(50);
    let release: (value: unknown) => void = () => undefined;
    agent.answer = tool =>
      tool === 'slow' ? new Promise(resolve => (release = resolve)) : { ok: true, tool };
    const slow = link.call('agent', 'slow');
    const fast = await link.call('agent', 'fast');
    expect(fast).toEqual({ ok: true, tool: 'fast' });
    release({ ok: true, tool: 'slow' });
    expect(await slow).toEqual({ ok: true, tool: 'slow' });
    expect(agent.calls.map(call => [call.tool, call.loadId])).toEqual([
      ['slow', agent.info.loadId],
      ['fast', agent.info.loadId],
    ]);
    expect(designer.calls).toEqual([]);
  });

  it('answers page_reloaded when the page reloads under a call, no_game_page without a page', async () => {
    const agent = page('agent');
    await link.discover(50);
    agent.answer = () => new Promise(() => undefined); // a long game_run
    const running = link.call('agent', 'game_run');
    await vi.waitFor(() => expect(agent.calls).toHaveLength(1));
    agent.reload();
    expect(await running).toMatchObject({ ok: false, reason: 'page_reloaded' });
    await vi.waitFor(() => expect(link.page('agent')?.loadId).toBe('agent-load-1'));
    // The new load answers the next call.
    agent.answer = tool => ({ ok: true, tool });
    expect(await link.call('agent', 'status')).toEqual({ ok: true, tool: 'status' });
    expect(agent.calls.at(-1)?.loadId).toBe('agent-load-1');
    expect(await link.call('designer', 'status')).toMatchObject({ reason: 'no_game_page' });
  });

  it('times out a page that never answers', async () => {
    const agent = page('agent');
    await link.discover(50);
    agent.answer = () => new Promise(() => undefined);
    expect(await link.call('agent', 'status', {}, 30)).toMatchObject({
      ok: false,
      reason: 'no_game_page',
    });
  });

  it('is fresh only at or after the last sync, and a page closed from here is not reloading', async () => {
    const agent = page('agent', { rev: 3 });
    await link.discover(50);
    const found = link.page('agent');
    expect(found && link.isFresh(found)).toBe(true);
    link.noteSync(5);
    expect(found && link.isFresh(found)).toBe(false);
    agent.reload({ rev: 5 });
    expect(
      await link.until(() => !!link.page('agent') && link.isFresh(link.page('agent')!), 500)
    ).toBe(true);
    agent.answer = tool => {
      if (tool === 'close') setTimeout(() => agent.close(), 0);
      return { ok: true };
    };
    await link.close('agent');
    await vi.waitFor(() => expect(link.page('agent')).toBeNull());
    expect(link.isReloading('agent', 1_000)).toBe(false);
  });

  it('closes the agent page after 10 idle minutes, never during a call (D7)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const agent = page('agent'); // its hello starts the idle clock
      const designer = page('designer');
      let finish: () => void = () => undefined;
      agent.answer = tool =>
        tool === 'game_run'
          ? new Promise(resolve => (finish = () => resolve({ ok: true })))
          : { ok: true };
      await vi.waitFor(() => expect(link.page('agent')).not.toBeNull());
      const tools = () => agent.calls.map(call => call.tool);
      // A run longer than the timeout holds the page.
      const run = link.call('agent', 'game_run', {}, 60 * 60_000);
      await vi.waitFor(() => expect(tools()).toEqual(['game_run']));
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(tools()).toEqual(['game_run']);
      finish();
      await run;
      // The clock starts again when the last call ends.
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000);
      expect(tools()).toEqual(['game_run']);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(tools()).toEqual(['game_run', 'close']));
      expect(designer.calls).toEqual([]); // the human's page is never closed for idling
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read-only editor tab does not close the agent page for idling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      appState.project.host.writer = 'other';
      const agent = page('agent');
      await vi.waitFor(() => expect(link.page('agent')).not.toBeNull());
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(agent.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the pages' errors, tagged with their page and load", async () => {
    const agent = page('agent');
    await link.discover(50);
    agent.log('boom');
    await vi.waitFor(() => expect(link.errors()).toHaveLength(1));
    expect(link.errors()[0]).toMatchObject({
      origin: 'agent',
      loadId: agent.info.loadId,
      message: 'boom',
    });
    link.clearErrors();
    expect(link.errors()).toEqual([]);
  });

  it('builds the page URL: debug, role, mute for the agent, scene and run', () => {
    expect(gamePageUrl('/', 'designer', 'res://scenes/a.pix3scene')).toBe(
      `${window.location.origin}/?debug&role=designer&scene=scenes%2Fa.pix3scene`
    );
    expect(gamePageUrl('/game/', 'agent', null, { seed: 8 })).toBe(
      `${window.location.origin}/game/?debug&role=agent&mute&run=${encodeURIComponent('{"seed":8}')}`
    );
  });
});
