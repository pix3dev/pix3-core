/**
 * The page's lifecycle, read once for everything that reacts to it: `visible` (the tab or app is on
 * screen: `visibilitychange`, `pagehide`/`pageshow` incl. a bfcache return, `freeze`/`resume`) and
 * `focused` (`blur`/`focus`). `AudioService` silences on either, `InputService` drops held
 * pointers on either, the runner pauses on {@link AppLifecycle.state} and scripts see that state
 * through `scene.app`.
 *
 * Duplicate events (`visibilitychange` + `pagehide` for one app switch) collapse into one
 * transition: listeners hear only a change of value. The DOM listeners are installed while
 * somebody subscribes; without a `window` (Node) everything reads visible and focused.
 */

export type AppState = 'active' | 'background';

export interface AppLifecycleChange {
  /** The state after the change. */
  readonly state: AppState;
  /** True when this change moved {@link AppLifecycle.state}, not only focus. */
  readonly stateChanged: boolean;
  /** On a return to `active`: how long the app was in the background, ms; else 0. */
  readonly awayMs: number;
}

export type AppLifecycleListener = (change: AppLifecycleChange) => void;

const hasDom = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

const WINDOW_EVENTS = ['blur', 'focus', 'pagehide', 'pageshow'] as const;
const DOCUMENT_EVENTS = ['visibilitychange', 'freeze', 'resume'] as const;

export class AppLifecycle {
  private readonly listeners = new Set<AppLifecycleListener>();
  private pageHidden = false;
  private frozen = false;
  private visibleNow = true;
  private focusedNow = true;
  private held = false;
  private simulatedAway = false;
  private simulatedBlur = false;
  private stateNow: AppState = 'active';
  private backgroundSince = 0;
  /** What listeners last heard, so a duplicate event is not a second transition. */
  private lastVisible = true;
  private lastFocused = true;
  private runReducedMotion: boolean | null = null;
  private gameReducedMotion: boolean | null = null;

  /** The page is on screen (not hidden, not unloaded into the bfcache, not frozen). */
  get visible(): boolean {
    if (this.listeners.size === 0) this.read();
    return this.visibleNow && !this.simulatedAway;
  }

  /** The window has keyboard focus. */
  get focused(): boolean {
    if (this.listeners.size === 0) this.read();
    return this.focusedNow && !this.simulatedAway && !this.simulatedBlur;
  }

  /**
   * What a game reacts to: `background` while the page is not visible — unless the host
   * {@link setHeld held} it active (an agent's run on a hidden tab keeps ticking).
   */
  get state(): AppState {
    if (this.listeners.size === 0) {
      this.read();
      return this.computeState();
    }
    return this.stateNow;
  }

  /**
   * Fewer, smaller movements: a test run's {@link setReducedMotion run} value, else the game's
   * (its settings toggle), else the system's `prefers-reduced-motion: reduce`. False in Node.
   */
  get reducedMotion(): boolean {
    if (this.runReducedMotion !== null) return this.runReducedMotion;
    if (this.gameReducedMotion !== null) return this.gameReducedMotion;
    try {
      return typeof matchMedia === 'function'
        ? matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
    } catch {
      return false;
    }
  }

  /** Override {@link reducedMotion}: `'run'` from `RunOverrides`, `'game'` from `scene.app`; null clears. */
  setReducedMotion(source: 'run' | 'game', value: boolean | null): void {
    if (source === 'run') this.runReducedMotion = value;
    else this.gameReducedMotion = value;
  }

  /** Hear every change of {@link visible}, {@link focused} or {@link state}. Returns the unsubscribe. */
  subscribe(listener: AppLifecycleListener): () => void {
    if (this.listeners.size === 0) this.attach();
    this.listeners.add(listener);
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.detach();
    };
  }

  /**
   * Keep {@link state} `active` whatever the page does — a host stepping the game on a hidden page
   * (the test host's worker frames). Audio and focus still follow the page.
   */
  setHeld(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    this.update();
  }

  /**
   * Go to the background and come back `awayMs` later, as one synchronous round trip
   * (`bot.background`): background listeners, held pointers dropped, then foreground with that
   * `awayMs`. Ignores {@link setHeld}; no frame runs in between.
   */
  simulateBackground(awayMs: number): void {
    this.simulatedAway = true;
    this.update();
    this.simulatedAway = false;
    this.backgroundSince = this.now() - Math.max(0, awayMs);
    this.update();
  }

  /** Lose keyboard focus and get it back at once (a replayed `blur`): held pointers dropped. */
  simulateBlur(): void {
    this.simulatedBlur = true;
    this.update();
    this.simulatedBlur = false;
    this.update();
  }

  private readonly onEvent = (event: Event): void => {
    if (event.type === 'pagehide') this.pageHidden = true;
    else if (event.type === 'pageshow') this.pageHidden = false;
    else if (event.type === 'freeze') this.frozen = true;
    else if (event.type === 'resume') this.frozen = false;
    this.read(event.type);
    this.update();
  };

  private attach(): void {
    if (!hasDom()) return;
    this.pageHidden = false;
    this.frozen = false;
    for (const type of WINDOW_EVENTS) window.addEventListener(type, this.onEvent);
    for (const type of DOCUMENT_EVENTS) document.addEventListener(type, this.onEvent);
    this.read();
    this.lastVisible = this.visibleNow;
    this.lastFocused = this.focusedNow;
    this.stateNow = this.computeState();
    if (this.stateNow === 'background') this.backgroundSince = this.now();
  }

  private detach(): void {
    if (!hasDom()) return;
    for (const type of WINDOW_EVENTS) window.removeEventListener(type, this.onEvent);
    for (const type of DOCUMENT_EVENTS) document.removeEventListener(type, this.onEvent);
  }

  /**
   * `blur` is focus lost whatever `document.hasFocus()` says in that instant (a test DOM, a
   * browser that has not updated it yet); `focus` is focus back; otherwise ask the document.
   */
  private read(eventType?: string): void {
    if (!hasDom()) return;
    this.visibleNow = document.visibilityState !== 'hidden' && !this.pageHidden && !this.frozen;
    if (eventType === 'blur') this.focusedNow = false;
    else if (eventType === 'focus') this.focusedNow = true;
    else this.focusedNow = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  }

  private computeState(): AppState {
    if (this.simulatedAway) return 'background';
    return this.visibleNow || this.held ? 'active' : 'background';
  }

  private now(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
  }

  private update(): void {
    const state = this.computeState();
    const visible = this.visible;
    const focused = this.focused;
    const stateChanged = state !== this.stateNow;
    if (!stateChanged && visible === this.lastVisible && focused === this.lastFocused) return;
    this.lastVisible = visible;
    this.lastFocused = focused;
    let awayMs = 0;
    if (stateChanged) {
      this.stateNow = state;
      if (state === 'background') this.backgroundSince = this.now();
      else awayMs = Math.max(0, Math.round(this.now() - this.backgroundSince));
    }
    const change: AppLifecycleChange = { state, stateChanged, awayMs };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch (error) {
        console.error('[AppLifecycle] listener failed', error);
      }
    }
  }
}

/** The page's one lifecycle (a page has one). */
export const appLifecycle = new AppLifecycle();
