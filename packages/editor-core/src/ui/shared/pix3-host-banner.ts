import { subscribe } from 'valtio/vanilla';
import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import './pix3-host-banner.ts.css';

/** DOM event `WriterService` listens for on `window`: this tab asks for the writer claim back. */
export const TAKE_OVER_EVENT = 'pix3-take-over';

type BannerKind = 'read-only' | 'disconnected' | null;

/**
 * The two states that must not hide in the status bar, because they mean "this tab cannot save":
 *
 * - **read-only** — another editor tab holds the writer claim (`project.host.writer === 'other'`,
 *   plan D6). "Take over" dispatches {@link TAKE_OVER_EVENT}; `WriterService` re-claims with
 *   `steal: true` and the banner goes away when the claim lands.
 * - **disconnected** — the dev server's socket is down (`project.host.connection === 'closed'`).
 *   Edits stay in memory and are written when it comes back; nothing to click.
 *
 * Disconnected wins when both are true: no claim can be taken over a closed connection.
 */
@customElement('pix3-host-banner')
export class Pix3HostBanner extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @state() private kind: BannerKind = null;
  @state() private takeOverPending = false;

  private disposeProjectSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.sync();
    this.disposeProjectSubscription = subscribe(appState.project, () => this.sync());
  }

  disconnectedCallback(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    super.disconnectedCallback();
  }

  private sync(): void {
    if (appState.project.status !== 'ready') {
      this.kind = null;
    } else if (appState.project.host.connection === 'closed') {
      this.kind = 'disconnected';
    } else if (appState.project.host.writer === 'other') {
      this.kind = 'read-only';
    } else {
      this.kind = null;
    }
    if (this.kind !== 'read-only') {
      this.takeOverPending = false;
    }
  }

  protected render() {
    if (this.kind === 'disconnected') {
      return html`
        <div class="host-banner host-banner--error" role="status">
          <span class="host-banner__icon" aria-hidden="true"
            >${this.icons.getIcon('wifi-off', IconSize.SMALL)}</span
          >
          <span class="host-banner__text"
            >Dev server disconnected — edits stay in memory.
            <span class="host-banner__detail"
              >They are written when the connection comes back; restart the dev server if it does
              not.</span
            ></span
          >
        </div>
      `;
    }

    if (this.kind === 'read-only') {
      return html`
        <div class="host-banner" role="status">
          <span class="host-banner__icon" aria-hidden="true"
            >${this.icons.getIcon('lock', IconSize.SMALL)}</span
          >
          <span class="host-banner__text"
            >Another tab is editing this project. This tab is read-only: nothing here will be
            saved.</span
          >
          <button
            type="button"
            class="host-banner__action"
            ?disabled=${this.takeOverPending}
            @click=${this.onTakeOver}
          >
            ${this.takeOverPending ? 'Taking over…' : 'Take over'}
          </button>
        </div>
      `;
    }

    return null;
  }

  private onTakeOver = (): void => {
    this.takeOverPending = true;
    window.dispatchEvent(new CustomEvent(TAKE_OVER_EVENT));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-host-banner': Pix3HostBanner;
  }
}
