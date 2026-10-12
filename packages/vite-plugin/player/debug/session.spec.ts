import {
  getScriptErrorSink,
  registerGameDebug,
  reportScriptError,
  resolveRuntimeTimeConfig,
  type AudioService,
  type ResolvedRuntimeTimeConfig,
  type RuntimeRenderer,
  type RuntimeTimeConfig,
  type SceneRunner,
  type SceneRunnerFrameSample,
} from '@pix3/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Pix3PlayerState } from '../index';
import { mountDebugOverlay } from './index';
import { DebugSession } from './session';

/** The slice of `SceneRunner` the session uses, with the time mode it would be in. */
const fakeRunner = () => {
  const listeners = new Set<(sample: SceneRunnerFrameSample) => void>();
  let mode: ResolvedRuntimeTimeConfig = resolveRuntimeTimeConfig({ mode: 'realtime' });
  const runner = {
    running: true,
    subscribeFrameStats: (listener: (sample: SceneRunnerFrameSample) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTimeMode: () => ({ ...mode }),
    setTimeMode: vi.fn((config: RuntimeTimeConfig) => {
      mode = resolveRuntimeTimeConfig(config);
    }),
    stepFrames: vi.fn(() => (mode.mode === 'manual' ? 1 : 0)),
  };
  const emit = (over: Partial<SceneRunnerFrameSample> = {}): void => {
    for (const listener of listeners) {
      listener({
        dt: 1 / 60,
        elapsedTime: 0,
        frameNumber: 7,
        logicMs: 1,
        renderMs: 2,
        totalFrameMs: 3,
        unaccountedMs: 13.6,
        rafLatenessMs: 0,
        ...over,
      });
    }
  };
  return { runner, emit, listeners };
};

const context = (runner: ReturnType<typeof fakeRunner>['runner']) => {
  const programs = { count: 3 };
  const state: Pix3PlayerState = {
    status: 'running',
    frames: 0,
    errors: [],
    scene: 'scenes/main.pix3scene',
    runner: null,
  };
  return {
    programs,
    state,
    value: {
      runner: runner as unknown as SceneRunner,
      renderer: {
        getStatsSnapshot: () => ({
          calls: 12,
          triangles: 400,
          points: 0,
          lines: 0,
          geometries: 5,
          textures: 4,
          programs: programs.count,
        }),
      } as unknown as RuntimeRenderer,
      audio: { getActivePlaybackSnapshot: () => [] } as unknown as AudioService,
      state,
    },
  };
};

const sessions: { dispose(): void }[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  document.body.innerHTML = '';
});

describe('DebugSession', () => {
  it('pauses in manual time mode, steps only while paused, and resumes the previous mode', () => {
    const { runner } = fakeRunner();
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 4 });
    const session = new DebugSession(context(runner).value);
    sessions.push(session);
    session.start();

    session.step();
    expect(runner.stepFrames).not.toHaveBeenCalled();

    session.pause();
    expect(session.paused).toBe(true);
    expect(runner.getTimeMode()).toMatchObject({
      mode: 'manual',
      muteAudio: true,
      renderEveryNTicks: 1,
    });
    session.step();
    expect(runner.stepFrames).toHaveBeenCalledWith(1);

    session.resume();
    expect(session.paused).toBe(false);
    expect(runner.getTimeMode()).toMatchObject({ mode: 'fixed', ticksPerFrame: 4 });
  });

  it('leaves a game that drives its own manual ticks alone', () => {
    const { runner } = fakeRunner();
    runner.setTimeMode({ mode: 'manual' });
    runner.setTimeMode.mockClear();
    const session = new DebugSession(context(runner).value);
    session.pause();
    expect(session.paused).toBe(false);
    expect(runner.setTimeMode).not.toHaveBeenCalled();
  });

  it('reads renderer counters from a painted frame and counts programs linked since then', () => {
    const { runner, emit } = fakeRunner();
    const ctx = context(runner);
    const session = new DebugSession(ctx.value);
    sessions.push(session);
    session.start();

    // A tick that skipped its paint has reset counters: not read.
    emit({ renderMs: 0 });
    expect(session.snapshot().renderer).toBeNull();
    emit();
    session.rollWindow();
    expect(session.snapshot()).toMatchObject({
      frameNumber: 7,
      renderer: { calls: 12, programs: 3 },
      programsLinked: 0,
    });

    ctx.programs.count = 5;
    emit();
    expect(session.snapshot().programsLinked).toBe(2);
    expect(session.snapshot().window.frames).toBe(2);
    session.resetStats();
    expect(session.snapshot()).toMatchObject({ programsLinked: 0, stability: { sampleCount: 0 } });
  });

  it('collects script errors through the runtime sink and the page errors of __PIX3_PLAYER__', () => {
    const { runner } = fakeRunner();
    const ctx = context(runner);
    const session = new DebugSession(ctx.value);
    session.start();

    reportScriptError({
      phase: 'update',
      message: 'TypeError: x is undefined',
      nodeName: 'Player',
      componentType: 'user:Mover',
    });
    ctx.state.errors.push('unhandledrejection: boom');

    expect(session.snapshot().errors).toMatchObject({
      count: 2,
      recent: [
        { message: 'TypeError: x is undefined', where: 'update · Player · user:Mover' },
        { message: 'unhandledrejection: boom', where: null },
      ],
    });
    session.dispose();
    expect(getScriptErrorSink()).toBeNull();
  });

  it("includes the game's registerGameDebug snapshot", () => {
    const { runner } = fakeRunner();
    const session = new DebugSession(context(runner).value);
    const unregister = registerGameDebug({ name: 'demo', snapshot: () => ({ level: 3 }) });
    try {
      expect(session.snapshot().game).toEqual({ name: 'demo', snapshot: { level: 3 } });
    } finally {
      unregister();
    }
  });
});

describe('mountDebugOverlay', () => {
  it('mounts the panel, exposes __PIX3_PLAYER__.debug and tears both down', () => {
    const { runner, listeners } = fakeRunner();
    const ctx = context(runner);
    const unmount = mountDebugOverlay(ctx.value);

    const host = document.querySelector('.pix3-debug-overlay');
    expect(host?.shadowRoot?.querySelector('.title')?.textContent).toBe('Pix3 debug');
    expect(ctx.state.debug?.snapshot()).toMatchObject({ scene: 'scenes/main.pix3scene' });
    expect(listeners.size).toBe(1);

    host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="pause"]')?.click();
    expect(runner.getTimeMode().mode).toBe('manual');

    unmount();
    expect(document.querySelector('.pix3-debug-overlay')).toBeNull();
    expect(ctx.state.debug).toBeUndefined();
    expect(listeners.size).toBe(0);
    // Unmounting a paused session hands the game its clock back.
    expect(runner.getTimeMode().mode).toBe('realtime');
  });
});
