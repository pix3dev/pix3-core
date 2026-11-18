import { subscribe } from 'valtio/vanilla';
import { injectable } from '@/fw/di';
import { appState } from '@/state';
import { setEditorKeepAlive } from '@/services/core/page-activity';

/**
 * **Agent keepalive** (plan §D.4): the editor pauses its viewport loop while the tab is hidden or
 * unfocused, to save battery — and in the agent loop the tab is in the background almost all the
 * time. So while an agent is working the pauses are off:
 *
 *   keepalive = setting on AND ( a bridge call is in flight, or the last one finished less than
 *                                {@link RECENT_CALL_MS} ago )
 *
 * The game never runs in the editor (plan play-in-page D4): the agent's game page keeps its own
 * frames going while hidden (the page test host's background ticks).
 *
 * The result goes to `page-activity`'s {@link setEditorKeepAlive}, which every battery gate reads
 * (`isEditorActive`, `BackgroundTicker`). The setting is "Keep the editor running while an agent
 * is connected" (`appState.ui.keepEditorRunningForAgent`, default on).
 */

/** A finished bridge call keeps the editor alive this long (the agent is likely to call again). */
export const RECENT_CALL_MS = 60_000;

@injectable()
export class AgentKeepaliveService {
  private readonly inflight = new Set<string>();
  private lastCallEndedAt: number | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispose_: (() => void) | null = null;
  private current = false;
  /** Tests replace the clock. */
  now: () => number = () => Date.now();

  initialize(): void {
    if (this.dispose_) return;
    this.dispose_ = subscribe(appState.ui, () => this.recompute());
    this.recompute();
  }

  noteCallStarted(id: string): void {
    this.inflight.add(id);
    this.recompute();
  }

  noteCallFinished(id: string): void {
    if (!this.inflight.delete(id)) return;
    this.lastCallEndedAt = this.now();
    this.recompute();
  }

  isKeepAlive(): boolean {
    return this.current;
  }

  dispose(): void {
    this.dispose_?.();
    this.dispose_ = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.inflight.clear();
    this.apply(false);
  }

  /** Visible for tests: re-evaluate now (the timer calls it when the recent-call window ends). */
  recompute(): void {
    const now = this.now();
    const calls =
      this.inflight.size > 0 ||
      (this.lastCallEndedAt !== null && now - this.lastCallEndedAt < RECENT_CALL_MS);
    this.apply(appState.ui.keepEditorRunningForAgent && calls);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.inflight.size === 0 && this.lastCallEndedAt !== null) {
      const due = this.lastCallEndedAt + RECENT_CALL_MS - now;
      if (due > 0) this.expiryTimer = setTimeout(() => this.recompute(), due + 1);
    }
  }

  private apply(value: boolean): void {
    setEditorKeepAlive(value);
    this.current = value;
  }
}
