/** A touch effect by meaning, not by milliseconds; which game event feels like which is the game's call. */
export type HapticKind =
  | 'selection'
  | 'light'
  | 'medium'
  | 'heavy'
  | 'success'
  | 'warning'
  | 'error';

/** `navigator.vibrate` pattern per kind, ms (on, off, on…); 0: a motor cannot play it (a tick). */
const PATTERN: Readonly<Record<HapticKind, number | readonly number[]>> = {
  selection: 0,
  light: 10,
  medium: 20,
  heavy: 35,
  success: [20, 50, 20, 50, 60],
  warning: [30, 60, 30],
  error: [60, 50, 90],
};

/** A pulse is dropped while one at least as heavy played less than {@link HAPTIC_GAP_MS} ago. */
const WEIGHT: Readonly<Record<HapticKind, number>> = {
  selection: 0,
  light: 1,
  medium: 2,
  heavy: 3,
  warning: 3,
  success: 4,
  error: 4,
};

const HAPTIC_GAP_MS = 60;

/**
 * What became of one `play` / `vibrate` call: `played` — handed to the adapter or
 * `navigator.vibrate` said yes (not "a motor moved"); `throttled` — dropped by weight; `off` —
 * `setEnabled(false)`; `hidden` — a hidden page; `unavailable` — nothing to play it on, or the
 * adapter / `vibrate` refused.
 */
export type HapticResult = 'played' | 'throttled' | 'off' | 'hidden' | 'unavailable';

/** One recorded call; `kind` is the {@link HapticKind}, or `'vibrate'` for a raw pattern. */
export interface HapticEvent {
  readonly kind: string;
  readonly result: HapticResult;
  /** The runner frame of the call. */
  readonly frame: number;
}

/** What a run asked of `scene.haptics` (`pix3 play --json`, `pix3 smoke --json`). */
export interface HapticsRunReport {
  /** Every `play` / `vibrate` call, whatever its result. */
  readonly calls: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byResult: Readonly<Partial<Record<HapticResult, number>>>;
  /** Calls pushed out of `events` (it keeps the last {@link HAPTICS_LOG_SIZE}). */
  readonly eventsDropped: number;
  /** The last calls, oldest first. */
  readonly events: readonly HapticEvent[];
}

const HAPTICS_LOG_SIZE = 500;

/**
 * What the device has, when it is more than `navigator.vibrate`: a native shell's feedback
 * generators (Capacitor Haptics), a portal SDK. `play` gets every kind, `vibrate` every raw pattern
 * (`0` stops).
 */
export interface HapticsAdapter {
  play(kind: HapticKind): void;
  vibrate(pattern: number | readonly number[]): void;
}

let adapter: HapticsAdapter | null = null;

/** Route `scene.haptics` to a native shell / portal SDK; `null` goes back to `navigator.vibrate`. */
export function setHapticsAdapter(next: HapticsAdapter | null): void {
  adapter = next;
}

const browserVibrate = (): ((pattern: number | number[]) => boolean) | null => {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return nav && typeof nav.vibrate === 'function' ? nav.vibrate.bind(nav) : null;
};

const pageHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * `scene.haptics`. Without an adapter it is `navigator.vibrate`, so iOS Safari (no vibrate) is
 * silent and `selection` (too short for a motor) plays nowhere. Nothing plays in a hidden tab or
 * after `setEnabled(false)`; never throws. Every `play` / `vibrate` call is recorded with its frame
 * and result, also where nothing can buzz (Node, a desktop): "did the game call haptics" must not
 * depend on the hardware.
 */
export class HapticsApi {
  private enabled = true;
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastWeight = -1;
  private calls = 0;
  /** Keyed by what the game passed (a typo too), so no prototype to collide with. */
  private readonly byKind: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly byResult: Partial<Record<HapticResult, number>> = {};
  private readonly log: HapticEvent[] = [];
  private eventsDropped = 0;

  constructor(private readonly frameOf: () => number = () => 0) {}

  /** Whether anything can buzz here: an adapter, or `navigator.vibrate`. */
  get available(): boolean {
    return adapter !== null || browserVibrate() !== null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The player's setting (a settings toggle); off also stops what is playing. */
  setEnabled(on: boolean): void {
    if (!on) this.stop();
    this.enabled = on;
  }

  /**
   * One effect by kind; false when nothing played — off, hidden, nothing to play it on, or
   * dropped because one at least as heavy played under 60 ms ago (a splash of five hits is one buzz).
   */
  play(kind: HapticKind): boolean {
    return this.note(String(kind), this.playKind(kind)) === 'played';
  }

  /** A raw pattern, ms (`30`, `[20, 40, 20]`); false where it did not buzz. */
  vibrate(pattern: number | readonly number[]): boolean {
    const result = this.blocked() ?? (this.vibrateRaw(pattern) ? 'played' : 'unavailable');
    return this.note('vibrate', result) === 'played';
  }

  stop(): void {
    if (this.enabled) this.vibrateRaw(0);
  }

  /** @internal What the run asked for, for `pix3 play --json` / `pix3 smoke --json`. */
  runReport(): HapticsRunReport {
    return {
      calls: this.calls,
      byKind: { ...this.byKind },
      byResult: { ...this.byResult },
      eventsDropped: this.eventsDropped,
      events: [...this.log],
    };
  }

  private playKind(kind: HapticKind): HapticResult {
    const weight = WEIGHT[kind];
    if (weight === undefined) return 'unavailable';
    const blocked = this.blocked();
    if (blocked) return blocked;
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (now - this.lastAt < HAPTIC_GAP_MS && this.lastWeight >= weight) return 'throttled';
    let played: boolean;
    if (adapter) played = this.call(() => adapter?.play(kind));
    else {
      const pattern = PATTERN[kind];
      played = pattern !== 0 && this.vibrateRaw(pattern);
    }
    if (!played) return 'unavailable';
    this.lastAt = now;
    this.lastWeight = weight;
    return 'played';
  }

  private blocked(): 'off' | 'hidden' | null {
    if (!this.enabled) return 'off';
    return pageHidden() ? 'hidden' : null;
  }

  private note(kind: string, result: HapticResult): HapticResult {
    this.calls += 1;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    this.byResult[result] = (this.byResult[result] ?? 0) + 1;
    this.log.push({ kind, result, frame: this.frameOf() });
    if (this.log.length > HAPTICS_LOG_SIZE) {
      this.log.shift();
      this.eventsDropped += 1;
    }
    return result;
  }

  private vibrateRaw(pattern: number | readonly number[]): boolean {
    const value = typeof pattern === 'number' ? Math.max(0, pattern) : [...pattern];
    if (adapter) return this.call(() => adapter?.vibrate(value));
    const vibrate = browserVibrate();
    if (!vibrate) return false;
    try {
      return vibrate(value);
    } catch {
      return false;
    }
  }

  private call(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  }
}
