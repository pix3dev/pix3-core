/**
 * The browser's **Long Animation Frame** entries (LoAF, Chromium), a port of the 1.x Profiler's
 * `LongAnimationFrameObserver`. The runner's own stopwatch only sees its logic and paint; LoAF is
 * the browser's view of the same frame and the only source that says what else ran. LoAF
 * attributes only scripts that ran longer than ~5 ms, so a long frame with no script is a finding
 * (late delivery, compositing, GC), not a gap: it is kept as `script: null`.
 */

/** One `scripts[]` entry of a LoAF timing (TS's DOM lib has no LoAF types yet). */
interface LoafScriptLike {
  readonly sourceURL?: string;
  readonly sourceFunctionName?: string;
  readonly duration?: number;
  readonly invoker?: string;
}

interface LoafEntryLike {
  readonly duration?: number;
  readonly blockingDuration?: number;
  readonly scripts?: readonly LoafScriptLike[];
}

export interface LongFrameRecord {
  readonly durationMs: number;
  readonly blockingMs: number;
  /** `basename.js · function` of the longest attributed script, or null: none was attributed. */
  readonly script: string | null;
}

export interface LongFrameStats {
  /** False where the browser has no `long-animation-frame` entries (Firefox, Safari). */
  readonly supported: boolean;
  readonly count: number;
  /** The worst few of the session, longest first. */
  readonly worst: readonly LongFrameRecord[];
}

const KEEP_WORST = 4;

export class LongFrameObserver {
  readonly supported: boolean;
  private observer: PerformanceObserver | null = null;
  private count = 0;
  private worst: LongFrameRecord[] = [];

  constructor() {
    const types: readonly string[] | undefined =
      typeof PerformanceObserver === 'undefined'
        ? undefined
        : PerformanceObserver.supportedEntryTypes;
    this.supported = Array.isArray(types) && types.includes('long-animation-frame');
  }

  start(): void {
    if (!this.supported || this.observer) return;
    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) this.record(entry as PerformanceEntry & LoafEntryLike);
    });
    this.observer.observe({ type: 'long-animation-frame' });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  reset(): void {
    this.count = 0;
    this.worst = [];
  }

  stats(): LongFrameStats {
    return { supported: this.supported, count: this.count, worst: [...this.worst] };
  }

  /** One entry, as the observer's callback hands it over (public for the spec). */
  record(entry: LoafEntryLike): void {
    const durationMs = typeof entry.duration === 'number' ? entry.duration : 0;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.count += 1;
    const record: LongFrameRecord = {
      durationMs,
      blockingMs: Number.isFinite(entry.blockingDuration) ? (entry.blockingDuration as number) : 0,
      script: describeScript(longestScript(entry.scripts)),
    };
    const at = this.worst.findIndex(existing => durationMs > existing.durationMs);
    if (at === -1) {
      if (this.worst.length < KEEP_WORST) this.worst.push(record);
      return;
    }
    this.worst.splice(at, 0, record);
    if (this.worst.length > KEEP_WORST) this.worst.length = KEEP_WORST;
  }
}

const longestScript = (scripts: readonly LoafScriptLike[] | undefined): LoafScriptLike | null => {
  let longest: LoafScriptLike | null = null;
  for (const script of scripts ?? []) {
    if (!longest || (script.duration ?? 0) > (longest.duration ?? 0)) longest = script;
  }
  return longest;
};

const describeScript = (script: LoafScriptLike | null): string | null => {
  if (!script) return null;
  const url = script.sourceURL?.trim().split(/[?#]/)[0];
  const basename = url ? url.slice(url.lastIndexOf('/') + 1) || url : null;
  const fn = script.sourceFunctionName?.trim();
  if (basename && fn) return `${basename} · ${fn}`;
  return basename || fn || script.invoker?.trim() || null;
};
