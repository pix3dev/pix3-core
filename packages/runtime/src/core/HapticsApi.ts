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
 * after `setEnabled(false)`; never throws.
 */
export class HapticsApi {
  private enabled = true;
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastWeight = -1;

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
    const weight = WEIGHT[kind];
    if (weight === undefined || !this.enabled || pageHidden()) return false;
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (now - this.lastAt < HAPTIC_GAP_MS && this.lastWeight >= weight) return false;
    let played: boolean;
    if (adapter) played = this.call(() => adapter?.play(kind));
    else {
      const pattern = PATTERN[kind];
      played = pattern !== 0 && this.vibrateRaw(pattern);
    }
    if (played) {
      this.lastAt = now;
      this.lastWeight = weight;
    }
    return played;
  }

  /** A raw pattern, ms (`30`, `[20, 40, 20]`); false where it did not buzz. */
  vibrate(pattern: number | readonly number[]): boolean {
    if (!this.enabled || pageHidden()) return false;
    return this.vibrateRaw(pattern);
  }

  stop(): void {
    if (this.enabled) this.vibrateRaw(0);
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
