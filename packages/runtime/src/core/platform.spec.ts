import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHeadlessGame, type HeadlessGame } from '../testing';
import {
  AD_CLOSE_TIMEOUT_MS,
  platform,
  setPlatformAdapter,
  setPlatformFallbackAdapter,
  type AdShow,
  type PlatformAdapter,
} from './platform';

const SCENE = "version: '1.0.0'\nroot:\n  - id: r\n    type: Group2D\n";

/** An adapter that hands every show to the test, which plays the SDK's signals by hand. */
const captureShows = (): { shows: AdShow[]; adapter: PlatformAdapter } => {
  const shows: AdShow[] = [];
  return {
    shows,
    adapter: {
      showRewarded: show => void shows.push(show),
      showInterstitial: show => void shows.push(show),
    },
  };
};

let game: HeadlessGame | null = null;
const startGame = async (ads?: Parameters<typeof createHeadlessGame>[0]['ads']) => {
  game = await createHeadlessGame({
    files: { 'scenes/main.pix3scene': SCENE, 'scenes/other.pix3scene': SCENE },
    ...(ads !== undefined ? { ads } : {}),
  });
  await game.start('scenes/main.pix3scene');
  return game;
};

afterEach(async () => {
  setPlatformAdapter(null);
  setPlatformFallbackAdapter(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await game?.disposeAsync();
  game = null;
});

describe('platform ads — the show contract', () => {
  it('is unavailable with no adapter (a build without a portal)', async () => {
    const result = await platform.showRewarded('revive', { onReward: () => {} });
    expect(result.outcome).toBe('unavailable');
    expect(result.id).toMatch(/^ad-\d+$/);
    expect(platform.showing).toBe(false);
  });

  it('rewards once and resolves closed, early reward included', async () => {
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const onReward = vi.fn();
    const pending = platform.showRewarded('revive', { onReward });
    const [show] = shows;
    expect(show).toMatchObject({ kind: 'rewarded', placement: 'revive' });
    show.started();
    show.rewarded();
    show.rewarded();
    expect(onReward).toHaveBeenCalledTimes(1);
    show.closed();
    show.closed();
    show.failed('late');
    expect(await pending).toEqual({ id: show.id, outcome: 'closed' });
    expect(onReward).toHaveBeenCalledTimes(1);
  });

  it('a close before the reward is skipped; the late reward is dropped with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const onReward = vi.fn();
    const pending = platform.showRewarded('chest', { onReward });
    shows[0].closed();
    shows[0].rewarded();
    expect((await pending).outcome).toBe('skipped');
    expect(onReward).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('came after it ended'));
  });

  it('an SDK failure is unavailable, thrown, rejected or signalled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setPlatformAdapter({
      showRewarded: () => {
        throw new Error('no fill');
      },
      showInterstitial: () => Promise.reject(new Error('sdk down')),
    });
    expect((await platform.showRewarded('a')).outcome).toBe('unavailable');
    expect((await platform.showInterstitial('b')).outcome).toBe('unavailable');

    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const pending = platform.showRewarded('c');
    shows[0].failed();
    expect((await pending).outcome).toBe('unavailable');
  });

  it('a show that never closes is unavailable after the timeout; started restarts it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    let outcome: string | null = null;
    void platform.showInterstitial('level-end').then(result => (outcome = result.outcome));
    await vi.advanceTimersByTimeAsync(AD_CLOSE_TIMEOUT_MS - 1000);
    shows[0].started();
    await vi.advanceTimersByTimeAsync(AD_CLOSE_TIMEOUT_MS - 1000);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(outcome).toBe('unavailable');
    shows[0].closed();
    expect(outcome).toBe('unavailable');
  });

  it('a second call during a show is unavailable and leaves the first alone', async () => {
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const first = platform.showRewarded('a');
    expect(platform.showing).toBe(true);
    expect((await platform.showInterstitial('b')).outcome).toBe('unavailable');
    expect(shows).toHaveLength(1);
    shows[0].closed();
    expect((await first).outcome).toBe('skipped');
  });

  it('a throwing onReward does not break the show', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const pending = platform.showRewarded('a', {
      onReward: () => {
        throw new Error('game bug');
      },
    });
    shows[0].rewarded();
    shows[0].closed();
    expect((await pending).outcome).toBe('closed');
  });

  it("the game's adapter wins over the dev placeholder", async () => {
    const fallback = captureShows();
    setPlatformFallbackAdapter(fallback.adapter);
    const pending = platform.showInterstitial('x');
    expect(fallback.shows).toHaveLength(1);
    fallback.shows[0].closed();
    expect((await pending).outcome).toBe('closed');

    const own = captureShows();
    setPlatformAdapter(own.adapter);
    const next = platform.showInterstitial('y');
    expect(own.shows).toHaveLength(1);
    expect(fallback.shows).toHaveLength(1);
    own.shows[0].closed();
    await next;
  });

  it('levelStart / levelComplete reach the adapter as they are', () => {
    const levelStart = vi.fn();
    const levelComplete = vi.fn();
    platform.levelStart('1');
    setPlatformAdapter({ levelStart, levelComplete });
    platform.levelStart('1');
    platform.levelComplete('1', { stars: 3 });
    expect(levelStart).toHaveBeenCalledWith('1');
    expect(levelComplete).toHaveBeenCalledWith('1', { stars: 3 });
  });
});

describe('platform ads in a run', () => {
  it('holds the ad pause during a show and lifts it before the promise resolves', async () => {
    const { runner } = await startGame();
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const pending = platform.showRewarded('revive').then(result => {
      expect(runner.getPauseReasons()).toEqual([]);
      return result;
    });
    expect(runner.getPauseReasons()).toEqual(['ad']);
    expect(runner.stepFrames(3)).toBe(0);
    shows[0].closed();
    await pending;
    expect(runner.stepFrames(3)).toBe(3);
  });

  it('a close while the tab is hidden starts nothing: the background reason still holds', async () => {
    const { runner } = await startGame();
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const pending = platform.showInterstitial('level-end');
    runner.setPauseReason('background', true);
    shows[0].closed();
    expect((await pending).outcome).toBe('closed');
    expect(runner.getPauseReasons()).toEqual(['background']);
    expect(runner.stepFrames(1)).toBe(0);
  });

  it('a scene change during a show settles it unavailable and drops its reward', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = await startGame();
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const onReward = vi.fn();
    const pending = platform.showRewarded('revive', { onReward });
    await g.scene.changeScene('scenes/other.pix3scene');
    await g.flush();
    expect((await pending).outcome).toBe('unavailable');
    expect(g.runner.getPauseReasons()).toEqual([]);
    shows[0].rewarded();
    expect(onReward).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('came after it ended'));
  });

  it('RunOverrides.ads decides each show in order, whatever adapter the game has', async () => {
    await startGame(['reward', 'skip', 'unavailable']);
    const { shows, adapter } = captureShows();
    setPlatformAdapter(adapter);
    const onReward = vi.fn();
    expect((await platform.showRewarded('a', { onReward })).outcome).toBe('closed');
    expect(onReward).toHaveBeenCalledTimes(1);
    expect((await platform.showRewarded('b', { onReward })).outcome).toBe('skipped');
    expect((await platform.showInterstitial('c')).outcome).toBe('unavailable');
    expect((await platform.showInterstitial('d')).outcome).toBe('unavailable');
    expect(onReward).toHaveBeenCalledTimes(1);
    expect(shows).toHaveLength(0);
  });

  it('one RunOverrides.ads value answers every show', async () => {
    await startGame('reward');
    const onReward = vi.fn();
    await platform.showRewarded('a', { onReward });
    await platform.showRewarded('b', { onReward });
    expect(onReward).toHaveBeenCalledTimes(2);
    expect((await platform.showInterstitial('c')).outcome).toBe('closed');
  });
});
