import type { RuntimeRendererStatsSnapshot, SceneRunnerFrameSample } from '@pix3/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FrameIntervalHistogram } from './frame-stats';
import { FrameProfile, isSoftwareGpu, startPageProfile, type ProfiledRunner } from './profile';

/**
 * `pix3 play --profile`'s collector against a scripted runner and clock: animation frames are
 * bursts of synchronous samples followed by a microtask, as a rAF callback (or a `stepFrames`
 * batch) delivers them.
 */

let now = 0;
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { __PIX3_PLAYER__?: unknown }).__PIX3_PLAYER__;
});

const setup = (mode: { ticksPerFrame: number; renderEveryNTicks: number; mode: string }) => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const listeners = new Set<(sample: SceneRunnerFrameSample) => void>();
  const state = { paused: false, calls: 10, programs: 3 };
  const runner: ProfiledRunner = {
    subscribeFrameStats: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTimeMode: () => ({ fixedDeltaSec: 1 / 60, ...mode }),
    get paused() {
      return state.paused;
    },
  };
  const renderer = {
    getStatsSnapshot: (): RuntimeRendererStatsSnapshot => ({
      calls: state.calls,
      triangles: state.calls * 100,
      points: 0,
      lines: 0,
      geometries: 4,
      textures: 5,
      programs: state.programs,
    }),
  };
  /** One animation frame `intervalMs` after the last: `ticks` samples, the last one painting. */
  const frame = async (
    intervalMs: number,
    ticks: readonly Partial<SceneRunnerFrameSample>[]
  ): Promise<void> => {
    now += intervalMs;
    for (const over of ticks) {
      for (const listener of listeners) {
        listener({
          dt: 1 / 60,
          elapsedTime: 0,
          frameNumber: 1,
          logicMs: 1,
          renderMs: 0,
          totalFrameMs: 1,
          unaccountedMs: 0,
          rafLatenessMs: 0,
          ...over,
        });
      }
    }
    await Promise.resolve();
  };
  return { runner, renderer, state, frame, listeners };
};

describe('FrameProfile', () => {
  it('excludes the warm-up and measures wall-clock intervals, logic, paint and counters', async () => {
    const { runner, renderer, state, frame } = setup({
      mode: 'realtime',
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
    });
    const profile = new FrameProfile(runner, renderer, { warmupSeconds: 0.1, warmupFrames: 3 });
    profile.start();
    // Warm-up: a slow first frame (a shader link) that must not reach the numbers.
    await frame(0, [{ logicMs: 50, renderMs: 400 }]);
    await frame(120, [{ logicMs: 1, renderMs: 2 }]);
    state.programs = 5; // linked during the warm-up: not counted
    await frame(16, [{ logicMs: 1, renderMs: 2 }]); // closes the warm-up (136 ms, 3 frames)
    for (let i = 0; i < 9; i += 1) {
      await frame(16, [
        {
          logicMs: 2,
          renderMs: 3,
          profilerActivities: [{ label: 'Islands', selfTimeMs: 0.5 }],
        },
      ]);
    }
    state.calls = 30;
    state.programs = 6;
    await frame(40, [{ logicMs: 2, renderMs: 3 }]);
    const report = profile.stop();

    expect(report.window.warmup.frames).toBe(3);
    expect(report.window.frames).toBe(10);
    expect(report.window.ticks).toBe(10);
    expect(report.frame.count).toBe(10);
    expect(report.frame.max).toBe(40);
    expect(report.frame.long).toBe(1);
    expect(report.frame.mean).toBeCloseTo((9 * 16 + 40) / 10, 3);
    expect(report.logicPerTick.max).toBe(2);
    expect(report.work.mean).toBe(5);
    expect(report.render.count).toBe(10);
    expect(report.window.fps).toBeCloseTo(1000 / 18.4, 2);
    expect(report.activities).toEqual([
      { label: 'Islands', perTick: { mean: 0.45, max: 0.5 }, perFrameMean: 0.45, ticks: 9 },
    ]);
    expect(report.renderer).toMatchObject({
      sampled: 10,
      calls: { mean: 12, max: 30 },
      programsLinked: 1,
      last: { geometries: 4, textures: 5, programs: 6 },
    });
  });

  it('groups a frame of fixed ticks: logic per tick and per frame apart, one paint', async () => {
    const { runner, renderer, frame } = setup({
      mode: 'fixed',
      ticksPerFrame: 4,
      renderEveryNTicks: 4,
    });
    const profile = new FrameProfile(runner, renderer, { warmupSeconds: 0, warmupFrames: 1 });
    profile.start();
    const batch = [{ logicMs: 1 }, { logicMs: 1 }, { logicMs: 1 }, { logicMs: 1, renderMs: 6 }];
    await frame(0, batch);
    for (let i = 0; i < 5; i += 1) await frame(100, batch);
    const report = profile.stop();

    expect(report.window).toMatchObject({ frames: 5, ticks: 20, painted: 5, ticksPerFrame: 4 });
    expect(report.logicPerTick).toMatchObject({ count: 20, mean: 1 });
    expect(report.logicPerFrame).toMatchObject({ count: 5, mean: 4 });
    expect(report.render).toMatchObject({ count: 5, mean: 6 });
    expect(report.work.mean).toBe(10);
    // The interval is wall clock, not 4 × 1/60 s of `dt`.
    expect(report.frame.mean).toBe(100);
  });

  it('drops the interval across a pause and the counters of a paused frame', async () => {
    const { runner, renderer, state, frame } = setup({
      mode: 'fixed',
      ticksPerFrame: 4,
      renderEveryNTicks: 4,
    });
    const profile = new FrameProfile(runner, renderer, { warmupSeconds: 0, warmupFrames: 1 });
    profile.start();
    await frame(0, [{ renderMs: 1 }]);
    await frame(50, [{ renderMs: 1 }]);
    // A bot's screenshot: paused during this frame, `renderOnce` paints a second time.
    state.paused = true;
    state.calls = 999;
    await frame(50, [{ renderMs: 1 }]);
    state.paused = false;
    state.calls = 10;
    await frame(5000, [{ renderMs: 1 }]);
    await frame(50, [{ renderMs: 1 }]);
    const report = profile.stop();

    expect(report.window.gaps).toBe(1);
    expect(report.frame).toMatchObject({ count: 3, max: 50 });
    expect(report.renderer).toMatchObject({ sampled: 3, calls: { max: 10 } });
  });

  it('reports nothing measured when the run ends inside the warm-up', async () => {
    const { runner, frame } = setup({ mode: 'realtime', ticksPerFrame: 1, renderEveryNTicks: 1 });
    const profile = new FrameProfile(runner, null);
    profile.start();
    await frame(0, [{}]);
    await frame(16, [{}]);
    const report = profile.stop();
    expect(report.window.frames).toBe(0);
    expect(report.frame.mean).toBeNull();
    expect(report.renderer).toBeNull();
  });
});

describe('startPageProfile', () => {
  it("reads the renderer from the player's state, or from the runner of an older player", () => {
    const { runner, renderer, listeners } = setup({
      mode: 'realtime',
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
    });
    const page = window as unknown as {
      __PIX3_PLAYER__?: unknown;
      __PIX3_PAGE_PROFILE__?: unknown;
    };
    page.__PIX3_PLAYER__ = { runner: Object.assign(runner, { renderer }) };
    const profile = startPageProfile();
    expect(page.__PIX3_PAGE_PROFILE__).toBe(profile);
    expect(listeners.size).toBe(1);
    profile.stop();
    expect(listeners.size).toBe(0);

    page.__PIX3_PLAYER__ = { runner: null };
    expect(() => startPageProfile()).toThrow('the page has no running game');
  });
});

describe('isSoftwareGpu', () => {
  it('names the CPU rasterisers a headless box renders with', () => {
    expect(
      isSoftwareGpu(
        'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
      )
    ).toBe(true);
    expect(isSoftwareGpu('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(
      isSoftwareGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')
    ).toBe(false);
    expect(isSoftwareGpu(null)).toBe(false);
  });
});

describe('FrameIntervalHistogram with fine buckets', () => {
  it('keeps sub-millisecond percentiles and an exact mean', () => {
    const histogram = new FrameIntervalHistogram(0.05, 250);
    for (let i = 0; i < 99; i += 1) histogram.record(0.31);
    histogram.record(4);
    const stats = histogram.snapshot();
    expect(stats.p50Ms).toBe(0.35);
    expect(stats.p99Ms).toBe(0.35);
    expect(stats.worstMs).toBe(4);
    expect(stats.meanMs).toBeCloseTo((99 * 0.31 + 4) / 100, 6);
  });
});
