import type { FrameProfilerActivity, SceneRunnerFrameSample } from '@pix3/runtime';

/**
 * The debug overlay's frame bookkeeping, DOM-free: a fixed-bucket interval histogram for the
 * session's percentiles, a ring of recent frames for the chart, and a rolling window of averages
 * (frame split, FPS, `FrameProfiler` activities) that the overlay swaps at its text cadence.
 * Everything here is O(1) per frame and allocates nothing per frame.
 */

/** Frames past this count as hitches: ~2 missed vsyncs at 60 Hz. */
export const LONG_FRAME_MS = 33.4;
const HISTOGRAM_MAX_MS = 100;

export interface FrameStability {
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly worstMs: number | null;
  /** Frames longer than {@link LONG_FRAME_MS}. */
  readonly longCount: number;
  readonly longPercent: number | null;
}

/**
 * 1 ms buckets up to 100 ms plus an overflow bucket (the 1.x Profiler's `FrameIntervalHistogram`):
 * a session can run for hours, so nothing keeps every frame. Percentiles are nearest-rank and
 * report the bucket's upper edge clamped to the worst frame, so they are never optimistic.
 */
export class FrameIntervalHistogram {
  private readonly buckets = new Uint32Array(HISTOGRAM_MAX_MS + 1);
  private count = 0;
  private long = 0;
  private worst = 0;

  reset(): void {
    this.buckets.fill(0);
    this.count = 0;
    this.long = 0;
    this.worst = 0;
  }

  record(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) return;
    this.buckets[Math.min(Math.floor(intervalMs), HISTOGRAM_MAX_MS)] += 1;
    this.count += 1;
    if (intervalMs > this.worst) this.worst = intervalMs;
    if (intervalMs > LONG_FRAME_MS) this.long += 1;
  }

  snapshot(): FrameStability {
    const empty = this.count === 0;
    return {
      sampleCount: this.count,
      p50Ms: this.percentile(50),
      p95Ms: this.percentile(95),
      p99Ms: this.percentile(99),
      worstMs: empty ? null : this.worst,
      longCount: this.long,
      longPercent: empty ? null : (this.long / this.count) * 100,
    };
  }

  private percentile(percent: number): number | null {
    if (this.count === 0) return null;
    const rank = Math.max(1, Math.ceil((percent / 100) * this.count));
    let cumulative = 0;
    for (let bucket = 0; bucket < this.buckets.length; bucket += 1) {
      cumulative += this.buckets[bucket];
      if (cumulative >= rank) {
        // The overflow bucket has no upper edge: the worst frame is the only honest answer.
        return bucket === HISTOGRAM_MAX_MS ? this.worst : Math.min(bucket + 1, this.worst);
      }
    }
    return this.worst;
  }
}

/** The last {@link capacity} frames, split the way the chart stacks them. */
export class FrameRing {
  readonly logicMs: Float32Array;
  readonly renderMs: Float32Array;
  /** Frame duration (`dt`), the bar's full height; the rest above logic + render is "not us". */
  readonly frameMs: Float32Array;
  private next = 0;
  private filled = 0;

  constructor(readonly capacity = 240) {
    this.logicMs = new Float32Array(capacity);
    this.renderMs = new Float32Array(capacity);
    this.frameMs = new Float32Array(capacity);
  }

  push(logicMs: number, renderMs: number, frameMs: number): void {
    this.logicMs[this.next] = logicMs;
    this.renderMs[this.next] = renderMs;
    this.frameMs[this.next] = frameMs;
    this.next = (this.next + 1) % this.capacity;
    this.filled = Math.min(this.filled + 1, this.capacity);
  }

  get length(): number {
    return this.filled;
  }

  /** Ring index of the `i`-th oldest retained frame (`0` = oldest). */
  indexOf(i: number): number {
    return (this.next - this.filled + i + this.capacity) % this.capacity;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }
}

export interface FrameWindow {
  readonly frames: number;
  /** Frames per second of wall clock in the window (`frames / Σdt`), null when empty. */
  readonly fps: number | null;
  readonly frameMs: number | null;
  readonly logicMs: number | null;
  readonly renderMs: number | null;
  readonly unaccountedMs: number | null;
  readonly rafLatenessMs: number | null;
  /** `FrameProfiler` activities, mean self time per frame, largest first. */
  readonly activities: readonly { readonly label: string; readonly ms: number }[];
}

export const EMPTY_WINDOW: FrameWindow = Object.freeze({
  frames: 0,
  fps: null,
  frameMs: null,
  logicMs: null,
  renderMs: null,
  unaccountedMs: null,
  rafLatenessMs: null,
  activities: Object.freeze([]),
});

/** Sums since the last {@link close}; `close` turns them into a {@link FrameWindow}. */
export class FrameWindowAccumulator {
  private frames = 0;
  private dtSec = 0;
  private logic = 0;
  private render = 0;
  private unaccounted = 0;
  private lateness = 0;
  private readonly activitySums = new Map<string, number>();

  add(sample: SceneRunnerFrameSample): void {
    this.frames += 1;
    this.dtSec += sample.dt;
    this.logic += sample.logicMs;
    this.render += sample.renderMs;
    this.unaccounted += sample.unaccountedMs;
    this.lateness += sample.rafLatenessMs;
    if (sample.profilerActivities) this.addActivities(sample.profilerActivities);
  }

  close(): FrameWindow {
    const n = this.frames;
    if (n === 0) return EMPTY_WINDOW;
    const activities = [...this.activitySums]
      .map(([label, sum]) => ({ label, ms: sum / n }))
      .sort((a, b) => b.ms - a.ms);
    const window: FrameWindow = {
      frames: n,
      fps: this.dtSec > 0 ? n / this.dtSec : null,
      frameMs: (this.dtSec * 1000) / n,
      logicMs: this.logic / n,
      renderMs: this.render / n,
      unaccountedMs: this.unaccounted / n,
      rafLatenessMs: this.lateness / n,
      activities,
    };
    this.frames = 0;
    this.dtSec = 0;
    this.logic = 0;
    this.render = 0;
    this.unaccounted = 0;
    this.lateness = 0;
    this.activitySums.clear();
    return window;
  }

  private addActivities(activities: readonly FrameProfilerActivity[]): void {
    for (const activity of activities) {
      if (!Number.isFinite(activity.selfTimeMs)) continue;
      this.activitySums.set(
        activity.label,
        (this.activitySums.get(activity.label) ?? 0) + activity.selfTimeMs
      );
    }
  }
}
