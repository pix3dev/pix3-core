import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { LoggingService } from '@/services/core/LoggingService';
import {
  TabPerformanceService,
  type TabPerformanceSample,
} from '@/services/editor/TabPerformanceService';
import { LayoutManagerService } from '@/core/LayoutManager';
import { IconService, IconSize } from '@/services/editor/IconService';
import { HostService } from '@/host/HostService';
import { CURRENT_EDITOR_VERSION } from '@/version';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import type { HostConnectionState } from '@/state/AppState';
import './pix3-status-bar.ts.css';

interface StatusMessage {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
}

/** What the host pill says, derived from `appState.project.host` + the dirty scene count. */
interface HostStatusView {
  readonly tone: 'is-ok' | 'is-pending' | 'is-warn' | 'is-error';
  readonly icon: string;
  readonly label: string;
}

/**
 * Bottom bar: the latest log line, play state, the dev-server link (connection, writer claim,
 * unsaved / changed-on-disk scenes), new errors since the Logs panel was last looked at, the tab's
 * CPU/GPU load, and the versions in use.
 */
@customElement('pix3-status-bar')
export class Pix3StatusBar extends ComponentBase {
  static useShadowDom = false;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(TabPerformanceService)
  private readonly tabPerformanceService!: TabPerformanceService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(HostService)
  private readonly hostService!: HostService;

  @state()
  private currentMessage: StatusMessage | null = null;

  @state()
  private projectName: string | null = null;

  @state()
  private isPlaying = false;

  @state()
  private host: HostConnectionState = { ...appState.project.host };

  @state()
  private dirtySceneCount = 0;

  /** Errors / warnings logged since the user last opened the Logs panel from here. */
  @state()
  private unseenErrors = 0;

  @state()
  private unseenWarnings = 0;

  @state()
  private perfSample: TabPerformanceSample = {
    cpuLoad: 0,
    gpuMs: null,
    renderMs: 0,
    continuousRenderReasons: [],
  };

  private messageTimeout: number | null = null;
  private disposers: Array<() => void> = [];

  connectedCallback() {
    super.connectedCallback();
    this.syncProjectState();
    this.syncDirtyCount();
    this.isPlaying = appState.ui.isPlaying;

    this.disposers.push(
      subscribe(appState.project, () => this.syncProjectState()),
      subscribe(appState.scenes, () => this.syncDirtyCount()),
      subscribe(appState.ui, () => {
        this.isPlaying = appState.ui.isPlaying;
      }),
      this.logger.subscribe(entry => {
        if (entry.level === 'error') {
          this.unseenErrors += 1;
        } else if (entry.level === 'warn') {
          this.unseenWarnings += 1;
        }
        if (entry.level === 'error' || entry.level === 'warn' || entry.level === 'info') {
          this.showMessage(
            entry.message,
            entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warning' : 'info'
          );
        }
      }),
      this.tabPerformanceService.subscribe(sample => {
        this.perfSample = sample;
      })
    );
  }

  disconnectedCallback() {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    if (this.messageTimeout !== null) {
      window.clearTimeout(this.messageTimeout);
      this.messageTimeout = null;
    }
    super.disconnectedCallback();
  }

  /** Show a temporary status message (auto-hides after 5 s). */
  showMessage(text: string, type: StatusMessage['type'] = 'info'): void {
    this.currentMessage = { text, type, timestamp: Date.now() };
    if (this.messageTimeout !== null) {
      window.clearTimeout(this.messageTimeout);
    }
    this.messageTimeout = window.setTimeout(() => {
      this.currentMessage = null;
      this.messageTimeout = null;
    }, 5000);
  }

  private syncProjectState(): void {
    this.projectName = appState.project.projectName;
    const host = appState.project.host;
    if (
      host.connection !== this.host.connection ||
      host.writer !== this.host.writer ||
      host.staleScenes.join('\n') !== this.host.staleScenes.join('\n')
    ) {
      this.host = { ...host, staleScenes: [...host.staleScenes] };
    }
  }

  private syncDirtyCount(): void {
    this.dirtySceneCount = Object.values(appState.scenes.descriptors).filter(
      descriptor => descriptor.isDirty
    ).length;
  }

  protected render() {
    return html`
      <div class="status-bar">
        <div class="status-left">
          ${this.currentMessage
            ? html`<span
                class="status-message ${this.currentMessage.type}"
                title=${this.currentMessage.text}
                >${this.currentMessage.text}</span
              >`
            : html`<span class="status-ready">Ready</span>`}
        </div>
        <div class="status-right">
          ${this.isPlaying
            ? html`<span class="status-indicator playing"
                >${this.icons.getIcon('play', IconSize.SMALL)} Playing</span
              >`
            : null}
          ${this.renderHostStatus()} ${this.renderDiagnostics()} ${this.renderPerformance()}
          <span class="status-version" title=${this.versionTitle()}>${this.versionLabel()}</span>
          ${this.projectName ? html`<span class="status-project">${this.projectName}</span>` : null}
        </div>
      </div>
    `;
  }

  /** The dev-server link: connection, writer claim, and what is not on disk yet. */
  private renderHostStatus() {
    if (!this.projectName) {
      return null;
    }
    const view = this.describeHostStatus();
    return html`
      <span class="status-indicator status-host ${view.tone}" title=${this.hostStatusTitle()}>
        ${this.icons.getIcon(view.icon, IconSize.SMALL)}
        <span>${view.label}</span>
      </span>
    `;
  }

  private describeHostStatus(): HostStatusView {
    const { connection, writer, staleScenes } = this.host;
    if (connection === 'closed') {
      return { tone: 'is-error', icon: 'wifi-off', label: 'Disconnected' };
    }
    if (writer === 'other') {
      return { tone: 'is-warn', icon: 'lock', label: 'Read-only' };
    }
    if (staleScenes.length > 0) {
      return {
        tone: 'is-warn',
        icon: 'alert-triangle',
        label: `${staleScenes.length} changed on disk`,
      };
    }
    if (this.dirtySceneCount > 0) {
      return { tone: 'is-pending', icon: 'edit-2', label: `${this.dirtySceneCount} unsaved` };
    }
    return { tone: 'is-ok', icon: 'check-circle', label: 'Saved' };
  }

  private hostStatusTitle(): string {
    const { connection, writer, staleScenes } = this.host;
    const lines = [
      connection === 'open'
        ? 'Dev server: connected'
        : 'Dev server: disconnected — edits stay in memory',
      writer === 'self'
        ? 'Writer: this tab'
        : writer === 'other'
          ? 'Writer: another tab (this one is read-only)'
          : 'Writer: not claimed',
      `Unsaved scenes: ${this.dirtySceneCount}`,
    ];
    if (staleScenes.length > 0) {
      lines.push(`Changed on disk while edited here:\n  ${staleScenes.join('\n  ')}`);
    }
    return lines.join('\n');
  }

  /** New errors / warnings since the Logs panel was last opened from here. */
  private renderDiagnostics() {
    if (this.unseenErrors === 0 && this.unseenWarnings === 0) {
      return null;
    }
    const hasErrors = this.unseenErrors > 0;
    const title =
      `${this.unseenErrors} new error(s), ${this.unseenWarnings} new warning(s) in the log.\n` +
      'Click to open the Logs panel.';
    return html`
      <button
        type="button"
        class="status-indicator status-diagnostics ${hasErrors ? 'error' : 'warning'}"
        title=${title}
        @click=${this.onDiagnosticsClick}
      >
        ${hasErrors
          ? html`${this.icons.getIcon('x-circle', IconSize.SMALL)} ${this.unseenErrors}`
          : null}
        ${this.unseenWarnings > 0
          ? html`${this.icons.getIcon('alert-triangle', IconSize.SMALL)} ${this.unseenWarnings}`
          : null}
      </button>
    `;
  }

  private onDiagnosticsClick = (): void => {
    this.unseenErrors = 0;
    this.unseenWarnings = 0;
    this.layoutManager.showPanel('logs');
  };

  /**
   * A glanceable CPU/GPU load readout for the whole editor tab. CPU is a main-thread load estimate
   * (event-loop lag); GPU is the viewport's measured GPU frame time, falling back to render
   * (CPU-side) frame time where the backend can't report GPU timing.
   */
  private renderPerformance() {
    const { cpuLoad, gpuMs, renderMs, continuousRenderReasons } = this.perfSample;
    const isLive = continuousRenderReasons.length > 0;
    const cpuPct = Math.round(cpuLoad * 100);
    const level = cpuLoad >= 0.75 ? 'high' : cpuLoad >= 0.4 ? 'mid' : 'low';
    const hasGpu = gpuMs !== null;
    const gpuLabel = hasGpu ? 'GPU' : 'Frame';
    const gpuValue = `${(hasGpu ? gpuMs : renderMs).toFixed(1)}ms`;
    const title =
      'Editor tab load\n' +
      `CPU ${cpuPct}% — main-thread load (event-loop lag)\n` +
      (hasGpu
        ? `GPU ${gpuValue} — viewport GPU frame time`
        : `Frame ${gpuValue} — viewport render time (GPU timing unavailable on this backend)`) +
      (isLive
        ? `\nViewport repainting every frame: ${continuousRenderReasons.join('; ')}`
        : '\nViewport idle — repaints on demand');

    return html`
      <span class="status-indicator status-perf ${level}" title=${title}>
        <span class="status-perf-metric"
          >CPU <span class="status-perf-value cpu">${cpuPct}%</span></span
        >
        <span class="status-perf-sep">·</span>
        <span class="status-perf-metric"
          >${gpuLabel} <span class="status-perf-value gpu">${gpuValue}</span></span
        >
        ${isLive
          ? html`<span class="status-perf-sep">·</span><span class="status-perf-live">Live</span>`
          : null}
      </span>
    `;
  }

  private versionLabel(): string {
    const editorCore = HostService.isInstalled() ? this.hostService.info.versions.editorCore : null;
    return editorCore ? `v${editorCore}` : CURRENT_EDITOR_VERSION.displayVersion;
  }

  private versionTitle(): string {
    if (!HostService.isInstalled()) {
      return `Pix3 Editor ${CURRENT_EDITOR_VERSION.displayVersion}`;
    }
    const { versions } = this.hostService.info;
    return [
      `@pix3/editor-core ${versions.editorCore ?? CURRENT_EDITOR_VERSION.version}`,
      `@pix3/vite-plugin ${versions.plugin}`,
      `@pix3/runtime ${versions.runtime ?? 'unknown'}`,
      `Vite ${versions.vite}`,
    ].join('\n');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-status-bar': Pix3StatusBar;
  }
}
