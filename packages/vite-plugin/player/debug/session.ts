import {
  getGameDebug,
  type GameDebugProvider,
  registerScriptErrorSink,
  type ResolvedRuntimeTimeConfig,
  type RuntimeRendererStatsSnapshot,
  type SceneRunnerFrameSample,
  type ScriptErrorInfo,
} from '@pix3/runtime';

import type { Pix3DebugContext } from './context';
import { readDeviceInfo, readHeapMb, type DeviceInfo } from './device-info';
import {
  EMPTY_WINDOW,
  FrameIntervalHistogram,
  FrameRing,
  FrameWindowAccumulator,
  type FrameStability,
  type FrameWindow,
} from './frame-stats';
import { LongFrameObserver, type LongFrameStats } from './long-frames';

/**
 * The debug mode's model, DOM-free: subscribes to the runner's frame stats, keeps the numbers the
 * overlay draws, and owns the pause / step controls. `snapshot()` is also what
 * `__PIX3_PLAYER__.debug.snapshot()` answers, so an agent reads the same numbers a human sees.
 */

interface DebugError {
  readonly at: number;
  readonly message: string;
  /** `phase · node · component` for a script error, null for a page error. */
  readonly where: string | null;
}

export interface DebugSnapshot {
  readonly status: string;
  readonly scene: string | null;
  readonly frameNumber: number;
  readonly paused: boolean;
  /** The last closed window (≈0.5 s): FPS, the frame split, activities. */
  readonly window: FrameWindow;
  /** Since the session started or the last reset. */
  readonly stability: FrameStability;
  /** Counters of the last rendered frame. */
  readonly renderer: RuntimeRendererStatsSnapshot | null;
  /** WebGL programs linked since the session started or the last reset (each one a stall). */
  readonly programsLinked: number;
  readonly audio: {
    readonly active: number;
    readonly playbacks: readonly {
      readonly label: string;
      readonly bus: string;
      readonly loop: boolean;
      readonly elapsedMs: number;
    }[];
  };
  readonly longFrames: LongFrameStats;
  readonly heapMb: number | null;
  readonly device: DeviceInfo;
  readonly errors: { readonly count: number; readonly recent: readonly DebugError[] };
  /** The game's own `registerGameDebug` provider snapshot, when it registered one. */
  readonly game: { readonly name: string; readonly snapshot: unknown } | null;
}

const KEEP_ERRORS = 20;
const SHOWN_PLAYBACKS = 6;

export class DebugSession {
  readonly ring: FrameRing = new FrameRing();
  private readonly histogram = new FrameIntervalHistogram();
  private readonly accumulator = new FrameWindowAccumulator();
  private readonly longFrames = new LongFrameObserver();
  private window: FrameWindow = EMPTY_WINDOW;
  private renderer: RuntimeRendererStatsSnapshot | null = null;
  private wantRendererStats = true;
  private programsAtReset: number | null = null;
  private frameNumber = 0;
  private readonly errors: DebugError[] = [];
  private errorCount = 0;
  private pageErrorsSeen = 0;
  /** The time mode pause replaced, or null while the overlay has not paused the game. */
  private pausedFrom: ResolvedRuntimeTimeConfig | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly context: Pix3DebugContext) {}

  start(): void {
    this.disposers.push(this.context.runner.subscribeFrameStats(this.onFrame));
    // The player registers no script-error sink of its own; the editor's lives in another page.
    this.disposers.push(registerScriptErrorSink(this.onScriptError));
    this.longFrames.start();
    this.disposers.push(() => this.longFrames.stop());
  }

  dispose(): void {
    if (this.pausedFrom) this.resume();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /** Close the current averaging window (the overlay calls this at its text cadence). */
  rollWindow(): void {
    this.window = this.accumulator.close();
    this.wantRendererStats = true;
  }

  /** Forget the session's percentiles, long frames and program count; keep the errors. */
  resetStats(): void {
    this.histogram.reset();
    this.ring.clear();
    this.longFrames.reset();
    this.programsAtReset = this.renderer?.programs ?? null;
  }

  get paused(): boolean {
    return this.pausedFrom !== null;
  }

  /**
   * Freeze the game in `manual` time mode rather than `SceneRunner.pause()`: a paused runner
   * cannot `stepFrames`. Audio is muted by the mode (`muteAudio`), not suspended.
   */
  pause(): void {
    const runner = this.context.runner;
    if (this.pausedFrom || !runner.running) return;
    const current = runner.getTimeMode();
    if (current.mode === 'manual') return; // the game drives its own ticks
    this.pausedFrom = current;
    runner.setTimeMode({ mode: 'manual', fixedDeltaSec: current.fixedDeltaSec, muteAudio: true });
  }

  resume(): void {
    if (!this.pausedFrom) return;
    const previous = this.pausedFrom;
    this.pausedFrom = null;
    this.context.runner.setTimeMode(previous);
  }

  /** One tick at the paused mode's `fixedDeltaSec`; a no-op unless the overlay paused the game. */
  step(): void {
    if (this.pausedFrom) this.context.runner.stepFrames(1);
  }

  snapshot(): DebugSnapshot {
    this.collectPageErrors();
    const { audio, state } = this.context;
    const playbacks = audio.getActivePlaybackSnapshot();
    const programs = this.renderer?.programs ?? null;
    if (programs !== null && this.programsAtReset === null) this.programsAtReset = programs;
    const provider = getGameDebug();
    return {
      status: state.status,
      scene: state.scene,
      frameNumber: this.frameNumber,
      paused: this.paused,
      window: this.window,
      stability: this.histogram.snapshot(),
      renderer: this.renderer,
      programsLinked: programs === null ? 0 : programs - (this.programsAtReset ?? programs),
      audio: {
        active: playbacks.length,
        playbacks: playbacks.slice(0, SHOWN_PLAYBACKS).map(playback => ({
          label: playback.label,
          bus: playback.bus,
          loop: playback.loop,
          elapsedMs: playback.elapsedMs,
        })),
      },
      longFrames: this.longFrames.stats(),
      heapMb: readHeapMb(),
      device: readDeviceInfo(),
      errors: { count: this.errorCount, recent: [...this.errors] },
      game: provider ? { name: provider.name, snapshot: readGameSnapshot(provider) } : null,
    };
  }

  private readonly onFrame = (sample: SceneRunnerFrameSample): void => {
    this.frameNumber = sample.frameNumber;
    const frameMs = sample.dt * 1000;
    this.histogram.record(frameMs);
    this.ring.push(sample.logicMs, sample.renderMs, frameMs);
    this.accumulator.add(sample);
    // The counters are reset at every tick's start, so only a tick that painted has them; one
    // read per window, not per frame.
    if (this.wantRendererStats && sample.renderMs > 0) {
      this.wantRendererStats = false;
      this.renderer = this.context.renderer.getStatsSnapshot();
    }
  };

  private readonly onScriptError = (error: ScriptErrorInfo): void => {
    const where = [error.phase, error.nodeName ?? error.nodeId, error.componentType]
      .filter(Boolean)
      .join(' · ');
    this.pushError({ at: Date.now(), message: error.message, where });
  };

  /** `__PIX3_PLAYER__.errors` (window errors, rejections, a failed boot), new ones only. */
  private collectPageErrors(): void {
    const errors = this.context.state.errors;
    for (; this.pageErrorsSeen < errors.length; this.pageErrorsSeen += 1) {
      this.pushError({ at: Date.now(), message: errors[this.pageErrorsSeen], where: null });
    }
  }

  private pushError(error: DebugError): void {
    this.errorCount += 1;
    this.errors.push(error);
    if (this.errors.length > KEEP_ERRORS) this.errors.shift();
  }
}

const readGameSnapshot = (provider: GameDebugProvider): unknown => {
  if (!provider.snapshot) return null;
  try {
    return provider.snapshot();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
