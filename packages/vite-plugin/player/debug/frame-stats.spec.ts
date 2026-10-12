import type { SceneRunnerFrameSample } from '@pix3/runtime';
import { describe, expect, it } from 'vitest';

import { FrameIntervalHistogram, FrameRing, FrameWindowAccumulator } from './frame-stats';
import { LongFrameObserver } from './long-frames';

const sample = (over: Partial<SceneRunnerFrameSample> = {}): SceneRunnerFrameSample => ({
  dt: 1 / 60,
  elapsedTime: 0,
  frameNumber: 1,
  logicMs: 2,
  renderMs: 3,
  totalFrameMs: 5,
  unaccountedMs: 1000 / 60 - 5,
  rafLatenessMs: 0.5,
  ...over,
});

describe('FrameIntervalHistogram', () => {
  it('reports pessimistic nearest-rank percentiles and counts frames past 33.4 ms', () => {
    const histogram = new FrameIntervalHistogram();
    for (let i = 0; i < 98; i += 1) histogram.record(16.7);
    histogram.record(40);
    histogram.record(120);

    const stats = histogram.snapshot();
    expect(stats.sampleCount).toBe(100);
    // The bucket's upper edge, never the lower one.
    expect(stats.p50Ms).toBe(17);
    expect(stats.p99Ms).toBe(41);
    // The overflow bucket answers with the worst frame itself.
    histogram.record(150);
    expect(histogram.snapshot().worstMs).toBe(150);
    expect(stats.longCount).toBe(2);
    expect(stats.longPercent).toBeCloseTo(2);
  });

  it('is empty after a reset', () => {
    const histogram = new FrameIntervalHistogram();
    histogram.record(20);
    histogram.reset();
    expect(histogram.snapshot()).toMatchObject({ sampleCount: 0, p50Ms: null, worstMs: null });
  });
});

describe('FrameRing', () => {
  it('keeps the last frames in order, oldest first', () => {
    const ring = new FrameRing(3);
    for (let i = 1; i <= 5; i += 1) ring.push(i, 0, i * 10);
    expect(ring.length).toBe(3);
    expect([0, 1, 2].map(i => ring.logicMs[ring.indexOf(i)])).toEqual([3, 4, 5]);
  });
});

describe('FrameWindowAccumulator', () => {
  it('averages the window and the FrameProfiler activities per frame, then starts over', () => {
    const accumulator = new FrameWindowAccumulator();
    accumulator.add(sample({ profilerActivities: [{ label: 'AI', selfTimeMs: 4 }] }));
    accumulator.add(
      sample({
        logicMs: 4,
        profilerActivities: [
          { label: 'AI', selfTimeMs: 2 },
          { label: 'Path', selfTimeMs: 1 },
        ],
      })
    );

    const window = accumulator.close();
    expect(window.frames).toBe(2);
    expect(window.fps).toBeCloseTo(60);
    expect(window.logicMs).toBe(3);
    expect(window.frameMs).toBeCloseTo(1000 / 60);
    expect(window.activities).toEqual([
      { label: 'AI', ms: 3 },
      { label: 'Path', ms: 0.5 },
    ]);
    expect(accumulator.close().frames).toBe(0);
  });
});

describe('LongFrameObserver', () => {
  it('keeps the four worst frames and names the longest script, or none', () => {
    const observer = new LongFrameObserver();
    for (const duration of [60, 200, 80, 70, 90]) observer.record({ duration });
    observer.record({
      duration: 300,
      blockingDuration: 250,
      scripts: [
        {
          sourceURL: 'http://localhost:5173/scripts/Enemy.ts?t=1',
          sourceFunctionName: 'onUpdate',
          duration: 40,
        },
        { sourceURL: 'http://localhost:5173/src/main.ts', duration: 10 },
      ],
    });

    const stats = observer.stats();
    expect(stats.count).toBe(6);
    expect(stats.worst.map(frame => frame.durationMs)).toEqual([300, 200, 90, 80]);
    expect(stats.worst[0]).toEqual({
      durationMs: 300,
      blockingMs: 250,
      script: 'Enemy.ts · onUpdate',
    });
    expect(stats.worst[1].script).toBeNull();
  });
});
