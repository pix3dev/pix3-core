import { describe, expect, it } from 'vitest';

import {
  runGameTestLoop,
  type GameRunLoopDeps,
  type TestableRunner,
} from '@/services/game-test/GameTestService';
import { makeFrameInputFeeder, type InputSink } from '@/services/game-test/frame-input';

/**
 * Frame-stamped input against a fake runner: the case that matters is that an event
 * lands **between** two ticks rather than being paced by a wall clock — the delivery the
 * negative control's gesture depends on in `'manual'` time.
 */

interface FakeRunner extends TestableRunner {
  frames: number;
  onTick?: (frame: number) => void;
}

function makeRunner(): FakeRunner {
  let mode: 'realtime' | 'fixed' | 'manual' = 'realtime';
  let paused = false;
  const runner: FakeRunner = {
    frames: 0,
    get paused() {
      return paused;
    },
    get running() {
      return true;
    },
    getTimeMode: () => ({
      mode,
      fixedDeltaSec: 1 / 60,
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
      muteAudio: true,
    }),
    setTimeMode: config => {
      mode = config.mode;
    },
    stepFrames: (count = 1) => {
      if (mode !== 'manual' || paused) return 0;
      for (let i = 0; i < count; i += 1) {
        runner.frames += 1;
        runner.onTick?.(runner.frames);
      }
      return count;
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
  return runner;
}

function makeDeps(runner: FakeRunner, over: Partial<GameRunLoopDeps> = {}): GameRunLoopDeps {
  let wall = 0;
  return {
    runner,
    sampleGameState: () => null,
    errorCount: () => 0,
    errorsSince: () => [],
    nodeExists: () => false,
    now: () => (wall += 1),
    yieldToHost: () => Promise.resolve(),
    ...over,
  };
}

describe('frame-denominated input', () => {
  it('delivers an event BETWEEN the two ticks it is stamped between', async () => {
    const runner = makeRunner();
    const log: string[] = [];
    runner.onTick = frame => log.push(`tick:${frame}`);
    const sink: InputSink = {
      key: (phase, code) => log.push(`key:${phase}:${code}`),
      pointer: (phase, nx, ny) => log.push(`pointer:${phase}:${nx},${ny}`),
    };
    const feeder = makeFrameInputFeeder(
      [
        { frame: 3, kind: 'key', phase: 'down', code: 'ArrowLeft' },
        { frame: 5, kind: 'pointer', phase: 'up', nx: 0.5, ny: 0.25 },
      ],
      sink
    );

    const result = await runGameTestLoop(
      makeDeps(runner, { beforeFrame: frame => feeder.before(frame) }),
      {
        until: [{ kind: 'frames', n: 6 }],
        fail: [],
        watch: [],
        maxFrames: 50,
        fixedDeltaSec: 1 / 60,
        maxWallMs: 20_000,
        pauseOnOutcome: false,
        settleMs: 0,
      }
    );

    expect(result.outcome?.frame).toBe(6);
    // keydown sits after tick 2 and before tick 3, so the game polls it on frame 3. A
    // wall-clock pacer in `'manual'` mode would have put both events between the same
    // pair of ticks.
    expect(log).toEqual([
      'tick:1',
      'tick:2',
      'key:down:ArrowLeft',
      'tick:3',
      'tick:4',
      'pointer:up:0.5,0.25',
      'tick:5',
      'tick:6',
    ]);
  });

  it('dispatches nothing for a frame with no events', () => {
    const sent: string[] = [];
    const feeder = makeFrameInputFeeder(
      [
        { frame: 2, kind: 'key', phase: 'down', code: 'KeyA' },
        { frame: 2, kind: 'pointer', phase: 'down', nx: 0.5, ny: 0.5 },
      ],
      {
        key: (phase, code) => sent.push(`${phase}:${code}`),
        pointer: (phase, nx, ny) => sent.push(`${phase}:${nx},${ny}`),
      }
    );
    feeder.before(1);
    expect(sent).toEqual([]);
    feeder.before(2);
    expect(sent).toEqual(['down:KeyA', 'down:0.5,0.5']);
  });
});
