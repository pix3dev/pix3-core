/**
 * `platform` — what a portal or a native shell gives a game: rewarded and interstitial ads, level
 * events. Not the playable-ad shim (`playable`): inside a playable ad there is no rewarded video.
 *
 * The engine, not the adapter, keeps the show contract, so a sloppy SDK cannot break a game:
 *
 * - one show at a time — a call during a show resolves `'unavailable'` at once;
 * - `onReward` runs at most once per show and may come before the close (early reward); a reward
 *   after the show settled is dropped with a warning;
 * - the promise resolves once: `'closed'` on a close (the reward is `onReward`, never the outcome),
 *   `'skipped'` on a rewarded show closed before its reward, `'unavailable'` on an SDK failure, on no
 *   close within {@link AD_CLOSE_TIMEOUT_MS}, on a scene change or stop during the show (its
 *   `onReward` is not called any more: the graph it would touch is gone), and with no adapter;
 * - while a show runs the runner holds the `ad` pause reason (time and audio stand still); it is
 *   lifted before the promise resolves, so the game resumes in the `then` — unless another reason
 *   (a hidden tab) still holds.
 *
 * A test run decides outcomes up front (`RunOverrides.ads`, `pix3 play --ads`), whatever adapter
 * the game installed. With neither, the dev server shows a placeholder; a build answers
 * `'unavailable'`.
 */
import { platformHost, type AdRunOutcome, type PlatformHost } from './platform-host';

export type AdOutcome = 'closed' | 'skipped' | 'unavailable';

export interface AdResult {
  /** The show's id (`ad-1`, `ad-2`, … per page), the one the adapter signalled with. */
  readonly id: string;
  readonly outcome: AdOutcome;
}

export interface ShowRewardedOptions {
  /** Grant the reward. At most once per show; may run before the ad closes. */
  onReward?: () => void;
}

export type AdKind = 'rewarded' | 'interstitial';

/**
 * One show as the adapter sees it: call the signals as the SDK reports them, in any order, any
 * number of times — the engine keeps the first that counts and ignores the rest.
 */
export interface AdShow {
  readonly id: string;
  readonly kind: AdKind;
  readonly placement: string;
  /** The ad is on screen (restarts the close timeout). */
  started(): void;
  /** The player earned the reward (rewarded only). */
  rewarded(): void;
  /** The ad is gone. */
  closed(): void;
  /** The SDK could not show one (no fill, an error). */
  failed(reason?: unknown): void;
}

/** A portal SDK or a native shell. Every method is optional; a missing `show*` is `'unavailable'`. */
export interface PlatformAdapter {
  showRewarded?(show: AdShow): void | Promise<void>;
  showInterstitial?(show: AdShow): void | Promise<void>;
  levelStart?(id: string): void;
  levelComplete?(id: string, result?: unknown): void;
}

/** No close this long after the call (or the last `started`) settles the show `'unavailable'`. */
export const AD_CLOSE_TIMEOUT_MS = 60_000;

let adapter: PlatformAdapter | null = null;
let fallbackAdapter: PlatformAdapter | null = null;
let showCount = 0;
let active: ActiveShow | null = null;

/** The game's portal / shell adapter; `null` removes it. */
export function setPlatformAdapter(next: PlatformAdapter | null): void {
  adapter = next;
}

/**
 * The dev server's placeholder (`player/dev/ad-placeholder.ts`): used only while the
 * game installed no adapter of its own.
 */
export function setPlatformFallbackAdapter(next: PlatformAdapter | null): void {
  fallbackAdapter = next;
}

class ActiveShow {
  private rewardDue: boolean;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly show: AdShow;
  readonly result: Promise<AdResult>;
  private resolve!: (result: AdResult) => void;

  constructor(
    readonly id: string,
    readonly kind: AdKind,
    placement: string,
    private readonly onReward: (() => void) | undefined,
    readonly host: PlatformHost | null
  ) {
    this.rewardDue = kind === 'rewarded';
    this.result = new Promise(resolve => (this.resolve = resolve));
    this.show = {
      id,
      kind,
      placement,
      started: () => {
        if (!this.settled) this.armTimeout();
      },
      rewarded: () => this.reward(),
      closed: () => this.settle(this.kind === 'rewarded' && this.rewardDue ? 'skipped' : 'closed'),
      failed: reason => {
        if (!this.settled && reason !== undefined) {
          console.warn(`[platform] ${this.kind} ad ${this.id} failed:`, reason);
        }
        this.settle('unavailable');
      },
    };
    host?.setPauseReason('ad', true);
    this.armTimeout();
  }

  reward(): void {
    if (this.settled) {
      if (this.kind === 'rewarded') {
        console.warn(`[platform] reward for ad ${this.id} came after it ended; ignored.`);
      }
      return;
    }
    if (!this.rewardDue) return;
    this.rewardDue = false;
    try {
      this.onReward?.();
    } catch (error) {
      console.error(`[platform] onReward of ad ${this.id} threw`, error);
    }
  }

  settle(outcome: AdOutcome): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (active === this) active = null;
    // As the run outcome that replays it: a rewarded show that paid out is `reward`.
    const paid = this.kind === 'rewarded' && !this.rewardDue;
    this.host?.noteAdOutcome(
      outcome === 'unavailable' ? 'unavailable' : paid && outcome === 'closed' ? 'reward' : 'skip'
    );
    this.host?.setPauseReason('ad', false);
    this.resolve({ id: this.id, outcome });
  }

  private armTimeout(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      console.warn(`[platform] ad ${this.id} did not close in ${AD_CLOSE_TIMEOUT_MS} ms.`);
      this.settle('unavailable');
    }, AD_CLOSE_TIMEOUT_MS);
  }
}

platformHost.onSceneEnd(host => {
  if (active?.host === host) active.settle('unavailable');
});

const playRunOutcome = (show: AdShow, outcome: AdRunOutcome): void => {
  if (outcome === 'unavailable') return show.failed();
  if (outcome === 'reward') show.rewarded();
  show.closed();
};

const startShow = (kind: AdKind, placement: string, onReward?: () => void): Promise<AdResult> => {
  const id = `ad-${++showCount}`;
  if (active) {
    return Promise.resolve({ id, outcome: 'unavailable' });
  }
  const host = platformHost.current;
  const runOutcome = host?.takeAdRunOutcome() ?? null;
  const source = adapter ?? fallbackAdapter;
  const method = kind === 'rewarded' ? source?.showRewarded : source?.showInterstitial;
  if (runOutcome === null && !method) {
    host?.noteAdOutcome('unavailable');
    return Promise.resolve({ id, outcome: 'unavailable' });
  }
  const current = new ActiveShow(id, kind, placement, onReward, host);
  active = current;
  // A run's outcome lands a microtask later, as an SDK's would: never inside the caller's frame.
  if (runOutcome !== null) {
    void Promise.resolve().then(() => playRunOutcome(current.show, runOutcome));
    return current.result;
  }
  try {
    Promise.resolve(method!.call(source, current.show)).catch((error: unknown) =>
      current.show.failed(error ?? 'rejected')
    );
  } catch (error) {
    current.show.failed(error ?? 'threw');
  }
  return current.result;
};

export const platform = {
  /**
   * Show a rewarded ad. `onReward` grants the reward (at most once, maybe before the close); the
   * promise resolves once, after the game's time and audio are back (see the module doc).
   */
  showRewarded(placement: string, options: ShowRewardedOptions = {}): Promise<AdResult> {
    return startShow('rewarded', placement, options.onReward);
  },

  /** Show an interstitial; resolves `'closed'` or `'unavailable'`. */
  showInterstitial(placement: string): Promise<AdResult> {
    return startShow('interstitial', placement);
  },

  /** True while a show is on screen (a second call now would be `'unavailable'`). */
  get showing(): boolean {
    return active !== null;
  },

  /** Tell the portal a level started (passed to the adapter as is). */
  levelStart(id: string): void {
    try {
      adapter?.levelStart?.(id);
    } catch (error) {
      console.error('[platform] levelStart threw', error);
    }
  },

  /** Tell the portal a level ended, with the game's own result (passed to the adapter as is). */
  levelComplete(id: string, result?: unknown): void {
    try {
      adapter?.levelComplete?.(id, result);
    } catch (error) {
      console.error('[platform] levelComplete threw', error);
    }
  },
};
