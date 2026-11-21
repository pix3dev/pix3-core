import { appLifecycle } from './AppLifecycle';

/** One `scene.analytics.track` call as a sink receives it. */
export interface AnalyticsEvent {
  readonly name: string;
  /** A shallow copy of what the game passed (`{}` when nothing). */
  readonly props: Readonly<Record<string, unknown>>;
  /** The runner frame it was tracked on. */
  readonly frame: number;
}

/**
 * Where events go — a vendor SDK (Amplitude, a portal's analytics), a game's own backend. Only
 * `track` is required. A sink that throws is reported once and never breaks the game or the other
 * sinks.
 */
export interface AnalyticsSink {
  track(event: AnalyticsEvent): void;
  /** The merged user properties, on `addSink` (when there are any) and on every change. */
  setUserProps?(props: Readonly<Record<string, unknown>>): void;
  /** Send what is batched: the app is going to the background (the page may never come back). */
  flush?(): void | Promise<void>;
}

/** What a run tracked (`pix3 play --json`, `pix3 smoke --json`): totals and the last events. */
export interface AnalyticsRunReport {
  readonly total: number;
  /** Events dropped from the pre-sink buffer (oldest first) before any sink was added. */
  readonly dropped: number;
  /** The last {@link ANALYTICS_LOG_SIZE} events, oldest first. */
  readonly events: readonly AnalyticsEvent[];
}

/** Events kept for sinks not added yet; past it the oldest go (counted in `dropped`). */
export const ANALYTICS_BUFFER_SIZE = 500;
/** Events kept for a run's report. */
const ANALYTICS_LOG_SIZE = 500;

/** Push onto a bounded list, dropping the oldest; true when one was dropped. */
const pushBounded = <T>(list: T[], item: T, size: number): boolean => {
  list.push(item);
  if (list.length <= size) return false;
  list.shift();
  return true;
};

/**
 * `scene.analytics` — the game's analytics facade: `track(name, props?)`, `setUserProps(props)`,
 * `addSink(sink)`. Events tracked before the first sink wait in a bounded buffer (the first sink
 * gets them in order); sinks are flushed when the app goes to the background. Vendor sinks live
 * with the game, not in the engine. Constructed on first touch, so a build that never says
 * `analytics` ships without it.
 */
export class AnalyticsApi {
  private readonly sinks = new Set<AnalyticsSink>();
  private readonly failedSinks = new WeakSet<AnalyticsSink>();
  private readonly pending: AnalyticsEvent[] = [];
  private readonly log: AnalyticsEvent[] = [];
  private userProps: Record<string, unknown> = {};
  private known: ReadonlySet<string> | null = null;
  private readonly warned = new Set<string>();
  private total = 0;
  private droppedCount = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly frameOf: () => number) {
    this.unsubscribe = appLifecycle.subscribe(change => {
      if (change.stateChanged && change.state === 'background') this.flush();
    });
  }

  /** Record an event; `props` are copied (shallow). A name outside {@link defineEvents} warns once. */
  track(name: string, props?: Record<string, unknown>): void {
    if (typeof name !== 'string' || name === '') {
      console.warn('[scene.analytics] track needs an event name; ignored.');
      return;
    }
    if (this.known && !this.known.has(name) && !this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[scene.analytics] "${name}" is not in defineEvents([...]); tracked anyway.`);
    }
    const event: AnalyticsEvent = { name, props: { ...props }, frame: this.frameOf() };
    this.total += 1;
    pushBounded(this.log, event, ANALYTICS_LOG_SIZE);
    if (this.sinks.size === 0) {
      if (pushBounded(this.pending, event, ANALYTICS_BUFFER_SIZE)) this.droppedCount += 1;
      return;
    }
    for (const sink of this.sinks) this.call(sink, 'track', () => sink.track(event));
  }

  /** Merge user properties (`level`, `cohort`, …) and hand the result to every sink. */
  setUserProps(props: Record<string, unknown>): void {
    this.userProps = { ...this.userProps, ...props };
    for (const sink of this.sinks) this.sendUserProps(sink);
  }

  /**
   * Add a sink. The first one gets the buffered events, in order; each one gets the user
   * properties so far. Returns the remove function.
   */
  addSink(sink: AnalyticsSink): () => void {
    if (this.sinks.has(sink)) return () => this.sinks.delete(sink);
    this.sinks.add(sink);
    this.sendUserProps(sink);
    for (const event of this.pending.splice(0)) {
      this.call(sink, 'track', () => sink.track(event));
    }
    return () => this.sinks.delete(sink);
  }

  /** The game's event names: a `track` of any other warns once (a typo, a stale name). */
  defineEvents(names: readonly string[]): void {
    this.known = new Set(names);
  }

  /** Ask every sink to send what it batched (done for you when the app goes to the background). */
  flush(): void {
    for (const sink of this.sinks) {
      if (!sink.flush) continue;
      this.call(sink, 'flush', () => {
        Promise.resolve(sink.flush!()).catch((error: unknown) => this.report(sink, 'flush', error));
      });
    }
  }

  /** Events dropped from the pre-sink buffer (it holds {@link ANALYTICS_BUFFER_SIZE}). */
  get dropped(): number {
    return this.droppedCount;
  }

  /** @internal What the run tracked, for `pix3 play --json` / `pix3 smoke --json`. */
  runReport(): AnalyticsRunReport {
    return { total: this.total, dropped: this.droppedCount, events: [...this.log] };
  }

  /** @internal The scene service is going away. */
  dispose(): void {
    this.unsubscribe();
    this.sinks.clear();
  }

  private sendUserProps(sink: AnalyticsSink): void {
    if (!sink.setUserProps || Object.keys(this.userProps).length === 0) return;
    const props = { ...this.userProps };
    this.call(sink, 'setUserProps', () => sink.setUserProps!(props));
  }

  private call(sink: AnalyticsSink, what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.report(sink, what, error);
    }
  }

  private report(sink: AnalyticsSink, what: string, error: unknown): void {
    if (this.failedSinks.has(sink)) return;
    this.failedSinks.add(sink);
    console.error(`[scene.analytics] a sink's ${what} threw (reported once per sink)`, error);
  }
}
