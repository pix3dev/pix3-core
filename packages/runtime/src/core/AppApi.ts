import { appLifecycle, type AppLifecycleChange, type AppState } from './AppLifecycle';
import {
  registerSignalTargetLink,
  unregisterSignalTargetLink,
  type SignalLinkHost,
  type SignalTargetLink,
} from './signal-target-links';

export interface AppAwayInfo {
  /** How long the app was in the background, ms (0 on `onBackground`). */
  readonly awayMs: number;
}

export type AppLifecycleCallback = (info: AppAwayInfo) => void;

/** A back-button handler: `true` when it consumed the press (closed a popup, left a screen). */
export type AppBackHandler = () => boolean;

type AppSignal = 'background' | 'foreground';

/** The history entry the back guard sits on. */
const GUARD_STATE = { pix3Back: true } as const;

/**
 * `scene.app` — the app's lifecycle as a game sees it (§ nodes-and-systems "App lifecycle"):
 * `state`, `onBackground` / `onForeground` (save, pause music, show a pause screen) and the back
 * button stack (`pushBack`). A subscription is tied to its owner — dropped when that script
 * detaches or that autoload is disposed (the same safety net as signal connections), when the
 * session stops, or by the returned function.
 */
export class AppApi implements SignalLinkHost {
  private readonly subscriptions = new Map<AppSignal, Set<SignalTargetLink & { owner: object }>>([
    ['background', new Set()],
    ['foreground', new Set()],
  ]);
  private readonly backStack: AppBackHandler[] = [];
  private readonly backPops = new Set<() => void>();
  private historyGuard = false;
  private guardArmed = false;

  /** `background` while the page is hidden (an agent's held run stays `active`). */
  get state(): AppState {
    return appLifecycle.state;
  }

  /**
   * Fewer, smaller movements (`prefers-reduced-motion`, a game's settings toggle, a test run's
   * `reducedMotion`): `juice.shake` and `core:Shake` move a quarter as far, `flash` does not flash
   * the screen. Tweens are untouched — read this to skip a decorative one yourself.
   */
  get reducedMotion(): boolean {
    return appLifecycle.reducedMotion;
  }

  /** The game's own choice (its settings toggle); null follows the system again. A test run's wins. */
  setReducedMotion(value: boolean | null): void {
    appLifecycle.setReducedMotion('game', value);
  }

  /** `cb({ awayMs: 0 })` when the app goes to the background. Returns the unsubscribe. */
  onBackground(owner: object, cb: AppLifecycleCallback): () => void {
    return this.subscribe('background', owner, cb);
  }

  /** `cb({ awayMs })` when the app comes back. Returns the unsubscribe. */
  onForeground(owner: object, cb: AppLifecycleCallback): () => void {
    return this.subscribe('foreground', owner, cb);
  }

  /**
   * Put a back-button handler on top of the stack (a popup opening); the returned `pop()` takes it
   * off (the popup closing). A press goes to the top handler first, down the stack until one
   * answers `true`; nobody handling it is the platform's ordinary back.
   */
  pushBack(owner: object, handler: AppBackHandler): () => void {
    this.backStack.push(handler);
    this.armHistoryGuard();
    let popped = false;
    const link: SignalTargetLink = { host: this, signal: 'back', method: () => {} };
    const pop = (): void => {
      if (popped) return;
      popped = true;
      this.backPops.delete(pop);
      const index = this.backStack.lastIndexOf(handler);
      if (index >= 0) this.backStack.splice(index, 1);
      unregisterSignalTargetLink(owner, link);
    };
    link.method = pop;
    this.backPops.add(pop);
    registerSignalTargetLink(owner, link);
    return pop;
  }

  /** A back press (`window.__pix3Back`, the history guard): true when a handler consumed it. */
  handleBack(): boolean {
    for (let i = this.backStack.length - 1; i >= 0; i -= 1) {
      try {
        if (this.backStack[i]() === true) return true;
      } catch (error) {
        console.error('[scene.app] back handler threw', error);
      }
    }
    return false;
  }

  /**
   * Let `pushBack` arm a history entry so a browser / Android back press reaches the stack. The
   * player decides (`pix3project.yaml` `app.backButton`); the entry is pushed lazily, on the first
   * `pushBack`.
   */
  setHistoryGuard(enabled: boolean): void {
    this.historyGuard = enabled;
    if (!enabled) this.disarmHistoryGuard();
  }

  /** @internal The runner forwards each lifecycle change. */
  notify(change: AppLifecycleChange): void {
    if (!change.stateChanged) return;
    const signal: AppSignal = change.state === 'background' ? 'background' : 'foreground';
    const info: AppAwayInfo = { awayMs: change.awayMs };
    for (const sub of Array.from(this.subscriptions.get(signal) ?? [])) {
      try {
        sub.method(info);
      } catch (error) {
        console.error(`[scene.app] ${signal} callback threw`, error);
      }
    }
  }

  /** @internal Session end: every subscription and back handler goes. */
  clear(): void {
    for (const set of this.subscriptions.values()) {
      for (const sub of Array.from(set)) this.disconnect(sub.signal, sub.owner, sub.method);
    }
    for (const pop of Array.from(this.backPops)) pop();
    this.disarmHistoryGuard();
    appLifecycle.setReducedMotion('game', null);
  }

  /** @internal `SignalLinkHost`: an owner detached. */
  disconnect(signal: string, target: unknown, method: (...args: unknown[]) => void): void {
    if (signal === 'back') {
      method();
      return;
    }
    const set = this.subscriptions.get(signal as AppSignal);
    if (!set) return;
    for (const sub of set) {
      if (sub.owner === target && sub.method === method) {
        set.delete(sub);
        unregisterSignalTargetLink(target, sub);
      }
    }
  }

  private subscribe(signal: AppSignal, owner: object, cb: AppLifecycleCallback): () => void {
    const sub = {
      host: this,
      signal,
      owner,
      method: cb as (...args: unknown[]) => void,
    };
    this.subscriptions.get(signal)!.add(sub);
    registerSignalTargetLink(owner, sub);
    return () => this.disconnect(signal, owner, sub.method);
  }

  private readonly onPopState = (): void => {
    if (this.handleBack()) {
      history.pushState(GUARD_STATE, '');
      return;
    }
    // Nobody wanted it: the guard entry is spent, so take the step back the player asked for.
    this.disarmHistoryGuard();
    history.back();
  };

  private armHistoryGuard(): void {
    if (!this.historyGuard || this.guardArmed || typeof window === 'undefined') return;
    try {
      history.pushState(GUARD_STATE, '');
    } catch {
      return;
    }
    this.guardArmed = true;
    window.addEventListener('popstate', this.onPopState);
  }

  private disarmHistoryGuard(): void {
    if (!this.guardArmed) return;
    this.guardArmed = false;
    window.removeEventListener('popstate', this.onPopState);
  }
}
