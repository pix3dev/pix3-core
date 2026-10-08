import { inject, injectable } from '@/fw/di';
import { LoggingService } from '@/services/core/LoggingService';
import { appState } from '@/state';

import { HostService } from './HostService';

/**
 * Which tab may write (plan §C.3 «Две вкладки — Web Locks», minimal port-phase form, D6).
 *
 * The first tab takes the Web Lock `pix3:write:<projectId>` and claims the writer slot on the dev
 * server; a later tab finds the lock held, stays read-only (`project.host.writer = 'other'`) and
 * queues for the lock, so it becomes the writer when the first tab closes. "Take over" (the host
 * banner dispatches `pix3-take-over` on `window`) steals the lock: the old tab's request is
 * aborted and it turns read-only; the server answers its late writes `409 writer_superseded`.
 *
 * The server is the authority, the lock is a UI signal: a `pix3:writer` frame naming another tab
 * turns this one read-only whatever the lock says.
 */
@injectable()
export class WriterService {
  @inject(HostService)
  private readonly hostService!: HostService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  private releaseLock: (() => void) | null = null;
  private disposers: Array<() => void> = [];

  private get lockName(): string {
    return `pix3:write:${appState.project.id ?? this.hostService.info.root}`;
  }

  async claimAtLoad(): Promise<void> {
    const host = this.hostService.host;
    this.disposers.push(
      host.writer.onChange(writerId => {
        appState.project.host.writer =
          writerId === null ? 'none' : writerId === host.info.tabId ? 'self' : 'other';
      })
    );
    const onTakeOver = (): void => void this.takeOver();
    window.addEventListener('pix3-take-over', onTakeOver);
    this.disposers.push(() => window.removeEventListener('pix3-take-over', onTakeOver));

    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) {
      await this.becomeWriter();
      return;
    }
    const acquired = await new Promise<boolean>(resolve => {
      void locks
        .request(this.lockName, { ifAvailable: true }, async lock => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          await this.holdAsWriter();
        })
        .catch(() => resolve(false));
    });
    if (!acquired) {
      appState.project.host.writer = 'other';
      // Wait our turn: when the writer tab closes, this one takes over by itself.
      this.requestLock(false);
    }
  }

  /** "Take over" from the read-only banner. */
  async takeOver(): Promise<void> {
    if (appState.project.host.writer === 'self') return;
    if (typeof navigator !== 'undefined' && navigator.locks) {
      this.requestLock(true);
    } else {
      await this.becomeWriter();
    }
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.releaseLock?.();
    this.releaseLock = null;
  }

  private requestLock(steal: boolean): void {
    navigator.locks
      .request(this.lockName, { steal }, () => this.holdAsWriter())
      .catch(error => {
        // `steal` by another tab aborts our hold: from now on this tab only reads.
        if (error instanceof DOMException && error.name === 'AbortError') {
          appState.project.host.writer = 'other';
          this.logger.warn('Another tab took over writing to this project; this tab is read-only.');
          return;
        }
        console.error('[WriterService] Web Lock request failed', error);
      });
  }

  private async holdAsWriter(): Promise<void> {
    await this.becomeWriter();
    await new Promise<void>(resolve => {
      this.releaseLock = resolve;
    });
  }

  private async becomeWriter(): Promise<void> {
    try {
      await this.hostService.host.writer.claim();
      appState.project.host.writer = 'self';
    } catch (error) {
      appState.project.host.writer = 'other';
      this.logger.error(
        `Could not claim writing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
