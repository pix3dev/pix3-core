import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPageTools, type PageTools } from './page-test-host';

/**
 * The game page's test host (plan play-in-page S3): `__PIX3_PLAYER__.tools` over a page's player,
 * and the run contract — one run at a time, a cancelled or abandoned (`pagehide`) run gives back
 * its pointer, its pause and the worker frames.
 */

interface FakeRunner {
  frames: number;
  readonly paused: boolean;
  readonly running: boolean;
  schedulers: unknown[];
  getTimeMode(): { mode: string; fixedDeltaSec: number };
  setTimeMode(config: { mode: string; fixedDeltaSec?: number }): void;
  stepFrames(count?: number): number;
  pause(): void;
  resume(): void;
  subscribeFrameStats(listener: () => void): () => void;
  setFrameScheduler(scheduler: unknown): void;
  getLiveRootNodes(): never[];
  getLiveNodeById(): null;
  findLiveNodeByName(): null;
}

const makeRunner = (): FakeRunner => {
  let mode = 'realtime';
  let fixedDeltaSec = 1 / 60;
  let paused = false;
  const listeners = new Set<() => void>();
  const runner: FakeRunner = {
    frames: 0,
    schedulers: [],
    get paused() {
      return paused;
    },
    running: true,
    getTimeMode: () => ({ mode, fixedDeltaSec }),
    setTimeMode: config => {
      mode = config.mode;
      fixedDeltaSec = config.fixedDeltaSec ?? fixedDeltaSec;
    },
    stepFrames: (count = 1) => {
      if (mode !== 'manual' || paused) return 0;
      for (let i = 0; i < count; i += 1) {
        runner.frames += 1;
        for (const listener of listeners) listener();
      }
      return count;
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    subscribeFrameStats: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFrameScheduler: scheduler => {
      runner.schedulers.push(scheduler);
    },
    getLiveRootNodes: () => [],
    getLiveNodeById: () => null,
    findLiveNodeByName: () => null,
  };
  return runner;
};

interface FakePlayer {
  status: string;
  frames: number;
  scene: string | null;
  runner: FakeRunner;
  renderer: { domElement: HTMLCanvasElement };
  tools?: PageTools;
}

const page = window as unknown as { __PIX3_PLAYER__?: FakePlayer };

const mountPlayer = (policies: Record<string, Record<string, unknown>> = {}) => {
  const player: FakePlayer = {
    status: 'running',
    frames: 0,
    scene: 'scenes/main.pix3scene',
    runner: makeRunner(),
    renderer: { domElement: document.createElement('canvas') },
  };
  page.__PIX3_PLAYER__ = player;
  const tools = installPageTools({ botPolicies: () => policies });
  return { player, tools };
};

/** A run long enough to be in flight when the next call lands. */
const LONG_RUN = { until: [{ kind: 'frames', n: 10_800 }], maxFrames: 10_800, maxWallMs: 180_000 };

afterEach(async () => {
  await page.__PIX3_PLAYER__?.tools?.call('game_cancel');
  delete page.__PIX3_PLAYER__;
});

describe('installPageTools', () => {
  it('puts the tools on __PIX3_PLAYER__, once', () => {
    const { player, tools } = mountPlayer();
    expect(player.tools).toBe(tools);
    expect(installPageTools({ botPolicies: () => ({}) })).toBe(tools);
  });

  it('refuses a page without a player', () => {
    expect(() => installPageTools({ botPolicies: () => ({}) })).toThrow('no Pix3 player');
  });

  it('runs pix3_game_run on the page and answers like the bridge', async () => {
    const { player, tools } = mountPlayer();
    const result = (await tools.call('game_run', { until: [{ kind: 'frames', n: 5 }] })) as {
      ok: boolean;
      outcome?: { kind: string; frame: number };
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toMatchObject({ kind: 'until', frame: 5 });
    expect(player.runner.frames).toBe(5);

    expect(await tools.call('game_run', { until: [{ kind: 'soon' }] })).toMatchObject({
      ok: false,
      reason: 'invalid_spec',
    });
    expect(await tools.call('game_run', { until: [], maxWallMs: 600_000 })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    expect(await tools.call('game_walk')).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('plays a policy from the page’s own policies (virtual:pix3/bot-policies)', async () => {
    const { tools } = mountPlayer({
      '/design/tests/bots/quick.ts': {
        default: {
          name: 'quick',
          tick: (bot: {
            frame: number;
            press(action: string): void;
            done(pass: boolean, why: string): void;
          }) => (bot.frame < 2 ? bot.press('Key_A') : bot.done(true, 'seen')),
        },
      },
    });
    const result = (await tools.call('game_run', {
      bot: { name: 'quick' },
      until: [{ kind: 'frames', n: 60 }],
    })) as { outcome?: { kind: string } };
    expect(result.outcome?.kind).toBe('bot-pass');

    const missing = (await tools.call('game_run', {
      bot: { name: 'nope' },
      until: [{ kind: 'frames', n: 1 }],
    })) as { ok: boolean; reason: string; detail: string };
    expect(missing).toMatchObject({ ok: false, reason: 'refused' });
    expect(missing.detail).toContain('quick');
  });
});

describe('the run contract', () => {
  it('holds one run at a time: a second game_run or bot_start is refused while one runs', async () => {
    const { tools } = mountPlayer();
    const first = tools.call('game_run', LONG_RUN);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await tools.call('game_run', { until: [{ kind: 'frames', n: 1 }] })).toMatchObject({
      ok: false,
      reason: 'run_active',
    });
    await expect(tools.call('bot_start', { name: 'any' })).rejects.toThrow('already running');
    expect(await tools.call('game_cancel')).toEqual({ ok: true, cancelled: true });
    expect(await first).toMatchObject({ ok: false, reason: 'cancelled' });
    // Free again.
    expect(await tools.call('game_run', { until: [{ kind: 'frames', n: 1 }] })).toMatchObject({
      ok: true,
    });
  });

  it('a cancelled run lifts no finger, lets the game run on and hands frames back to rAF', async () => {
    const { player, tools } = mountPlayer();
    const canvas = player.renderer.domElement;
    const cancels: number[] = [];
    canvas.addEventListener('pointercancel', event =>
      cancels.push((event as PointerEvent).pointerId)
    );
    const ups = vi.fn();
    canvas.addEventListener('pointerup', ups);

    const run = tools.call('game_run', LONG_RUN);
    await new Promise(resolve => setTimeout(resolve, 20));
    // Worker frames while the run holds the page (a hidden page gets no rAF).
    expect(player.runner.schedulers).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(await run).toMatchObject({ ok: false, reason: 'cancelled' });

    expect(cancels.length).toBeGreaterThan(0);
    expect(ups).not.toHaveBeenCalled();
    // pauseOnOutcome does not hold a cancelled run's game: it was running before, it runs after.
    expect(player.runner.paused).toBe(false);
    expect(player.runner.getTimeMode().mode).toBe('realtime');
    // Back on rAF, still counting the player's frames.
    expect(player.runner.schedulers).toHaveLength(2);
    const restored = player.runner.schedulers[1] as {
      request(callback: (time: number) => void): number;
    };
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    const before = player.frames;
    restored.request(() => undefined);
    expect(player.frames).toBe(before + 1);
    raf.mockRestore();
  });

  it('a run that ends on its own leaves the game paused on its outcome frame', async () => {
    const { player, tools } = mountPlayer();
    await tools.call('game_run', { until: [{ kind: 'frames', n: 3 }] });
    expect(player.runner.paused).toBe(true);
    expect(await tools.call('game_cancel')).toEqual({ ok: true, cancelled: false });
  });
});
