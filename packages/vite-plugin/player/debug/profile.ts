import type {
  FrameProfilerActivity,
  RuntimeRendererStatsSnapshot,
  SceneRunnerFrameSample,
} from '@pix3/runtime';

import { readDeviceInfo, readHeapMb, type DeviceInfo } from './device-info';
import { FrameIntervalHistogram, type FrameStability } from './frame-stats';
import { LongFrameObserver, type LongFrameStats } from './long-frames';

/**
 * `pix3 play --profile`: the debug overlay's numbers over a measured window, for a page that has
 * no overlay — a built `dist/index.html` included. The CLI bundles this file into a page script
 * (`packages/cli/src/play/bundle.ts`) and evaluates it in the game's page, so the player ships
 * none of it. It reads what the overlay reads — `SceneRunner.subscribeFrameStats` (logic / render
 * ms, `FrameProfiler` activities), `RuntimeRenderer.getStatsSnapshot`, LoAF, heap, device — and
 * keeps the overlay's histogram, at a finer bucket.
 *
 * **Ticks vs. animation frames.** The runner notifies once per logic *tick*; an animation frame
 * can carry several (a bot plays in `fixed` mode, 4 ticks of 1/60 s per frame, only the last one
 * painting), and in `fixed`/`manual` mode a sample's `dt` is the authored tick, not wall clock. So
 * the profile groups the ticks of one animation frame — every tick of a rAF callback (or a
 * `stepFrames` batch) runs synchronously, and a microtask queued by the first one runs after the
 * last — and reports per-tick logic separately from per-frame logic, paint and the wall-clock
 * interval between frames (measured here, never `dt`).
 *
 * **Warm-up.** The first {@link ProfileOptions.warmupSeconds} (and at least
 * {@link ProfileOptions.warmupFrames} frames) are excluded: shader links, texture uploads and
 * JIT tiers land there. A frame on which the game was paused (a bot's screenshot holds the game)
 * ends with a gap: the next interval would measure the pause, so it is dropped.
 */

/** What the profile needs of a `SceneRunner` (structural: the page's runtime may be older). */
export interface ProfiledRunner {
  subscribeFrameStats(listener: (sample: SceneRunnerFrameSample) => void): () => void;
  getTimeMode(): {
    readonly mode: string;
    readonly fixedDeltaSec: number;
    readonly ticksPerFrame: number;
    readonly renderEveryNTicks: number;
  };
  readonly paused: boolean;
}

/** What the profile needs of a `RuntimeRenderer`. */
export interface ProfiledRenderer {
  getStatsSnapshot(): RuntimeRendererStatsSnapshot;
}

export interface ProfileOptions {
  /** Wall-clock seconds excluded at the start (default 1). */
  readonly warmupSeconds?: number;
  /** Animation frames excluded at the start, at least (default 5). */
  readonly warmupFrames?: number;
}

/** Milliseconds over the measured window; nulls when nothing was measured. */
export interface ProfileStats {
  readonly count: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface ProfileActivity {
  readonly label: string;
  /** Self time per logic tick: mean over every measured tick (0 where it did not report), max. */
  readonly perTick: { readonly mean: number; readonly max: number };
  /** Mean self time per animation frame (all of the frame's ticks). */
  readonly perFrameMean: number;
  /** Ticks on which the game reported it. */
  readonly ticks: number;
}

export interface ProfileReport {
  readonly window: {
    /** Excluded at the start. */
    readonly warmup: { readonly seconds: number; readonly frames: number; readonly ticks: number };
    /** Wall clock of the measured window. */
    readonly seconds: number;
    /** Animation frames measured (each carries one or more ticks). */
    readonly frames: number;
    /** Of them, frames that painted. */
    readonly painted: number;
    /** Logic ticks measured. */
    readonly ticks: number;
    readonly ticksPerFrame: number | null;
    /** Animation frames per wall-clock second. */
    readonly fps: number | null;
    /** The runner's time mode when the measurement ended. */
    readonly timeMode: {
      readonly mode: string;
      readonly fixedDeltaSec: number;
      readonly ticksPerFrame: number;
      readonly renderEveryNTicks: number;
    };
    /** Frame intervals dropped because the game was paused across them. */
    readonly gaps: number;
  };
  /** Wall-clock interval between animation frames — what a player sees. */
  readonly frame: ProfileStats & { readonly long: number; readonly longPercent: number | null };
  /** The game's work per animation frame: every tick's logic plus the paint. */
  readonly work: ProfileStats;
  readonly logicPerTick: ProfileStats;
  readonly logicPerFrame: ProfileStats;
  /** Paint per painted frame. */
  readonly render: ProfileStats;
  /** `FrameProfiler` activities the game reported, largest mean first. */
  readonly activities: readonly ProfileActivity[];
  /** Counters of the painted frames (three's `renderer.info`); null without a renderer. */
  readonly renderer: {
    readonly sampled: number;
    readonly calls: { readonly mean: number; readonly max: number };
    readonly triangles: { readonly mean: number; readonly max: number };
    readonly last: RuntimeRendererStatsSnapshot;
    /** WebGL programs linked during the measured window (each one a main-thread stall). */
    readonly programsLinked: number;
  } | null;
  readonly heapMb: { readonly start: number; readonly end: number; readonly peak: number } | null;
  readonly longAnimationFrames: LongFrameStats;
  readonly device: DeviceInfo;
  /** The WebGL renderer is a CPU rasteriser: render ms say nothing about a device. */
  readonly softwareGpu: boolean;
}

/** 0.05 ms buckets up to 1 s: logic and paint are often well under a millisecond. */
const BUCKET_MS = 0.05;
const MAX_MS = 1000;
/** Frame intervals: 0.5 ms buckets up to 2 s (a software-rendered page runs 100+ ms frames). */
const FRAME_BUCKET_MS = 0.5;
const FRAME_MAX_MS = 2000;
/** Heap is read every this many measured frames (and at both ends). */
const HEAP_EVERY = 30;

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i;

/** Whether a WebGL renderer string names a CPU rasteriser. */
export const isSoftwareGpu = (gpu: string | null): boolean =>
  gpu !== null && SOFTWARE_GPU.test(gpu);

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

const toStats = (stability: FrameStability): ProfileStats => ({
  count: stability.sampleCount,
  mean: round(stability.meanMs),
  p50: round(stability.p50Ms),
  p95: round(stability.p95Ms),
  p99: round(stability.p99Ms),
  max: round(stability.worstMs),
});

interface ActivitySum {
  sum: number;
  max: number;
  ticks: number;
}

export class FrameProfile {
  private readonly frameHistogram = new FrameIntervalHistogram(FRAME_BUCKET_MS, FRAME_MAX_MS);
  private readonly workHistogram = new FrameIntervalHistogram(BUCKET_MS, MAX_MS);
  private readonly tickLogicHistogram = new FrameIntervalHistogram(BUCKET_MS, MAX_MS);
  private readonly frameLogicHistogram = new FrameIntervalHistogram(BUCKET_MS, MAX_MS);
  private readonly renderHistogram = new FrameIntervalHistogram(BUCKET_MS, MAX_MS);
  private readonly activities = new Map<string, ActivitySum>();
  private readonly longFrames = new LongFrameObserver();
  private readonly warmupMs: number;
  private readonly warmupFrames: number;
  private detach: (() => void) | null = null;
  private startedAt = 0;
  private measuring = false;
  private measureStart = 0;
  private lastClose: number | null = null;
  private gapNext = false;
  private gaps = 0;
  private warmup = { frames: 0, ticks: 0, seconds: 0 };
  private frames = 0;
  private painted = 0;
  private ticks = 0;
  // The animation frame being collected.
  private groupOpen = false;
  private groupLogic = 0;
  private groupRender = 0;
  private groupTicks = 0;
  private groupPainted = false;
  private groupActivities: FrameProfilerActivity[][] = [];
  // Renderer counters.
  private rendererSampled = 0;
  private callsSum = 0;
  private callsMax = 0;
  private trianglesSum = 0;
  private trianglesMax = 0;
  private lastStats: RuntimeRendererStatsSnapshot | null = null;
  private programsAtStart: number | null = null;
  private heap: { start: number; end: number; peak: number } | null = null;

  constructor(
    private readonly runner: ProfiledRunner,
    private readonly renderer: ProfiledRenderer | null,
    options: ProfileOptions = {}
  ) {
    this.warmupMs = Math.max(0, options.warmupSeconds ?? 1) * 1000;
    this.warmupFrames = Math.max(0, options.warmupFrames ?? 5);
  }

  start(): void {
    if (this.detach) return;
    this.startedAt = performance.now();
    this.detach = this.runner.subscribeFrameStats(this.onTick);
  }

  /** Stop listening; the report stays readable. */
  stop(): ProfileReport {
    if (this.detach) {
      this.detach();
      this.detach = null;
      this.longFrames.stop();
      this.sampleHeap();
    }
    return this.report();
  }

  report(): ProfileReport {
    const frame = this.frameHistogram.snapshot();
    const seconds = this.measuring ? (this.lastClose ?? this.measureStart) - this.measureStart : 0;
    const activities = [...this.activities]
      .map(([label, sum]) => ({
        label,
        perTick: {
          mean: round(this.ticks > 0 ? sum.sum / this.ticks : 0) ?? 0,
          max: round(sum.max) ?? 0,
        },
        perFrameMean: round(this.frames > 0 ? sum.sum / this.frames : 0) ?? 0,
        ticks: sum.ticks,
      }))
      .sort((a, b) => b.perTick.mean - a.perTick.mean);
    const last = this.lastStats;
    const device = readDeviceInfo();
    return {
      window: {
        warmup: { ...this.warmup, seconds: round(this.warmup.seconds / 1000) ?? 0 },
        seconds: round(seconds / 1000) ?? 0,
        frames: this.frames,
        painted: this.painted,
        ticks: this.ticks,
        ticksPerFrame: this.frames > 0 ? round(this.ticks / this.frames) : null,
        fps: seconds > 0 ? round((frame.sampleCount * 1000) / this.sumIntervals(frame)) : null,
        timeMode: { ...this.runner.getTimeMode() },
        gaps: this.gaps,
      },
      frame: {
        ...toStats(frame),
        long: frame.longCount,
        longPercent: round(frame.longPercent),
      },
      work: toStats(this.workHistogram.snapshot()),
      logicPerTick: toStats(this.tickLogicHistogram.snapshot()),
      logicPerFrame: toStats(this.frameLogicHistogram.snapshot()),
      render: toStats(this.renderHistogram.snapshot()),
      activities,
      renderer:
        last === null
          ? null
          : {
              sampled: this.rendererSampled,
              calls: {
                mean: round(this.callsSum / this.rendererSampled) ?? 0,
                max: this.callsMax,
              },
              triangles: {
                mean: Math.round(this.trianglesSum / this.rendererSampled),
                max: this.trianglesMax,
              },
              last,
              programsLinked: last.programs - (this.programsAtStart ?? last.programs),
            },
      heapMb: this.heap
        ? {
            start: round(this.heap.start) ?? 0,
            end: round(this.heap.end) ?? 0,
            peak: round(this.heap.peak) ?? 0,
          }
        : null,
      longAnimationFrames: this.longFrames.stats(),
      device,
      softwareGpu: isSoftwareGpu(device.gpu),
    };
  }

  /** `fps` is frames per second of measured intervals (gaps excluded). */
  private sumIntervals(frame: FrameStability): number {
    return (frame.meanMs ?? 0) * frame.sampleCount;
  }

  private readonly onTick = (sample: SceneRunnerFrameSample): void => {
    if (!this.groupOpen) {
      this.groupOpen = true;
      // Every tick of this animation frame runs before the microtask does.
      queueMicrotask(this.closeFrame);
    }
    this.groupTicks += 1;
    this.groupLogic += sample.logicMs;
    this.groupRender += sample.renderMs;
    if (sample.renderMs > 0) this.groupPainted = true;
    if (this.measuring) {
      this.tickLogicHistogram.record(sample.logicMs);
      if (sample.profilerActivities) this.groupActivities.push([...sample.profilerActivities]);
    }
  };

  private readonly closeFrame = (): void => {
    const now = performance.now();
    const ticks = this.groupTicks;
    const logic = this.groupLogic;
    const render = this.groupRender;
    const painted = this.groupPainted;
    const activities = this.groupActivities;
    this.groupOpen = false;
    this.groupTicks = 0;
    this.groupLogic = 0;
    this.groupRender = 0;
    this.groupPainted = false;
    this.groupActivities = [];
    // A pause (a bot's screenshot, a verdict) taken during this frame: the next interval would
    // measure the pause, and `renderOnce` has added a second paint to the counters.
    const pausedNow = this.runner.paused;

    if (!this.measuring) {
      this.warmup.frames += 1;
      this.warmup.ticks += ticks;
      if (now - this.startedAt >= this.warmupMs && this.warmup.frames >= this.warmupFrames) {
        this.measuring = true;
        this.measureStart = now;
        this.warmup.seconds = now - this.startedAt;
        this.longFrames.start();
        this.programsAtStart = this.renderer ? (this.readRenderer()?.programs ?? null) : null;
        this.sampleHeap();
      }
      this.lastClose = now;
      this.gapNext = pausedNow;
      return;
    }

    this.frames += 1;
    this.ticks += ticks;
    if (this.lastClose !== null && !this.gapNext) this.frameHistogram.record(now - this.lastClose);
    else if (this.gapNext) this.gaps += 1;
    this.lastClose = now;
    this.gapNext = pausedNow;
    this.workHistogram.record(logic + render);
    this.frameLogicHistogram.record(logic);
    if (painted) {
      this.painted += 1;
      this.renderHistogram.record(render);
      if (!pausedNow) this.sampleRenderer();
    }
    for (const tick of activities) {
      for (const activity of tick) {
        if (!Number.isFinite(activity.selfTimeMs)) continue;
        const sum = this.activities.get(activity.label) ?? { sum: 0, max: 0, ticks: 0 };
        sum.sum += activity.selfTimeMs;
        sum.max = Math.max(sum.max, activity.selfTimeMs);
        sum.ticks += 1;
        this.activities.set(activity.label, sum);
      }
    }
    if (this.frames % HEAP_EVERY === 0) this.sampleHeap();
  };

  private readRenderer(): RuntimeRendererStatsSnapshot | null {
    try {
      return this.renderer ? this.renderer.getStatsSnapshot() : null;
    } catch {
      return null;
    }
  }

  /** The counters still hold the frame's paint: the last tick painted, nothing reset since. */
  private sampleRenderer(): void {
    const stats = this.readRenderer();
    if (!stats) return;
    this.lastStats = stats;
    this.rendererSampled += 1;
    this.callsSum += stats.calls;
    this.callsMax = Math.max(this.callsMax, stats.calls);
    this.trianglesSum += stats.triangles;
    this.trianglesMax = Math.max(this.trianglesMax, stats.triangles);
  }

  private sampleHeap(): void {
    const mb = readHeapMb();
    if (mb === null || !this.measuring) return;
    if (!this.heap) this.heap = { start: mb, end: mb, peak: mb };
    this.heap.end = mb;
    this.heap.peak = Math.max(this.heap.peak, mb);
  }
}

interface ProfiledPlayerState {
  readonly runner?: ProfiledRunner | null;
  readonly renderer?: ProfiledRenderer | null;
}

/**
 * Start a profile on this page's running game (`window.__PIX3_PLAYER__`) and leave it on
 * `window.__PIX3_PAGE_PROFILE__`. A player older than `__PIX3_PLAYER__.renderer` keeps the
 * renderer on the runner only; the profile reads it there (a JS field, private in TypeScript).
 */
export const startPageProfile = (options: ProfileOptions = {}): FrameProfile => {
  const page = window as Window & {
    __PIX3_PLAYER__?: ProfiledPlayerState;
    __PIX3_PAGE_PROFILE__?: FrameProfile;
  };
  const state = page.__PIX3_PLAYER__;
  const runner = state?.runner;
  if (!runner) throw new Error('the page has no running game (window.__PIX3_PLAYER__.runner)');
  const renderer =
    state.renderer ?? (runner as unknown as { renderer?: ProfiledRenderer }).renderer ?? null;
  const profile = new FrameProfile(
    runner,
    renderer && typeof renderer.getStatsSnapshot === 'function' ? renderer : null,
    options
  );
  profile.start();
  page.__PIX3_PAGE_PROFILE__ = profile;
  return profile;
};
