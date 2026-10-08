import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, state } from '@/fw';
import type { HistoryEntry, HistorySnapshot } from '@/core/HistoryManager';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { appState } from '@/state';

import '../shared/pix3-panel';
import './history-panel.ts.css';

const EMPTY_SNAPSHOT: HistorySnapshot = {
  undoEntries: [],
  redoEntries: [],
  capacity: 0,
  canUndo: false,
  canRedo: false,
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** One row of the list: an applied (undoable) or an undone (redoable) step. */
interface HistoryRow {
  readonly entry: HistoryEntry;
  readonly applied: boolean;
  /** Undo (`< 0`) or redo (`> 0`) steps needed to make this row the latest applied one. */
  readonly distance: number;
}

/**
 * History panel: the active scene's undo/redo stack as a list (oldest at the top). Clicking a row
 * steps the stack to just after that edit — every step goes through the `edit.undo` / `edit.redo`
 * commands, so it is exactly what pressing Ctrl+Z / Ctrl+Shift+Z that many times would do.
 *
 * History is per scene (`OperationService`), so the list follows the active scene tab.
 */
@customElement('pix3-history-panel')
export class HistoryPanel extends ComponentBase {
  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly icons!: IconService;

  @state()
  private snapshot: HistorySnapshot = EMPTY_SNAPSHOT;

  @state()
  private stepping = false;

  private disposeOperations?: () => void;
  private disposeScenes?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh();
    this.disposeOperations = this.operations.addListener(event => {
      if (event.type === 'history:changed') {
        this.snapshot = event.snapshot;
      }
    });
    // The stack is per scene: switching tabs swaps it without a `history:changed`.
    this.disposeScenes = subscribe(appState.scenes, () => this.refresh());
  }

  disconnectedCallback(): void {
    this.disposeOperations?.();
    this.disposeOperations = undefined;
    this.disposeScenes?.();
    this.disposeScenes = undefined;
    super.disconnectedCallback();
  }

  private refresh(): void {
    this.snapshot = this.operations.history.snapshot();
  }

  private get rows(): HistoryRow[] {
    const { undoEntries, redoEntries } = this.snapshot;
    const applied = undoEntries.map((entry, index) => ({
      entry,
      applied: true,
      distance: index - (undoEntries.length - 1),
    }));
    // The redo stack's top is the next step to redo, so it reads in reverse.
    const undone = [...redoEntries].reverse().map((entry, index) => ({
      entry,
      applied: false,
      distance: index + 1,
    }));
    return [...applied, ...undone];
  }

  /** Undo or redo `distance` times; negative undoes. `-undoEntries.length` is the initial state. */
  private async step(distance: number): Promise<void> {
    if (this.stepping || distance === 0) {
      return;
    }
    this.stepping = true;
    try {
      const commandId = distance < 0 ? 'edit.undo' : 'edit.redo';
      for (let i = 0; i < Math.abs(distance); i += 1) {
        const before = this.operations.history.snapshot();
        await this.commandDispatcher.executeById(commandId);
        const after = this.operations.history.snapshot();
        if (after.undoEntries.length === before.undoEntries.length) {
          break;
        }
      }
    } finally {
      this.stepping = false;
      this.refresh();
    }
  }

  private label(entry: HistoryEntry): string {
    return entry.metadata.label || entry.metadata.description || entry.metadata.commandId || 'Edit';
  }

  protected render() {
    const rows = this.rows;
    const { canUndo, canRedo, undoEntries } = this.snapshot;
    return html`
      <pix3-panel
        panel-description="Undo history of the active scene."
        actions-label="History controls"
      >
        <div slot="toolbar" class="history-toolbar">
          <button
            type="button"
            class="history-btn"
            ?disabled=${!canUndo || this.stepping}
            title="Undo"
            aria-label="Undo"
            @click=${() => void this.step(-1)}
          >
            ${this.icons.getIcon('corner-up-left', IconSize.SMALL)}
          </button>
          <button
            type="button"
            class="history-btn"
            ?disabled=${!canRedo || this.stepping}
            title="Redo"
            aria-label="Redo"
            @click=${() => void this.step(1)}
          >
            ${this.icons.getIcon('corner-up-right', IconSize.SMALL)}
          </button>
          <span class="history-count">${undoEntries.length} / ${rows.length}</span>
        </div>
        <ol class="history-list" aria-label="Undo history">
          <li>
            <button
              type="button"
              class="history-row ${undoEntries.length === 0 ? 'is-current' : ''}"
              ?disabled=${this.stepping}
              @click=${() => void this.step(-undoEntries.length)}
            >
              <span class="history-row__icon">${this.icons.getIcon('file', IconSize.SMALL)}</span>
              <span class="history-row__label">Opened</span>
            </button>
          </li>
          ${rows.map(
            row => html`
              <li>
                <button
                  type="button"
                  class="history-row ${row.applied ? '' : 'is-undone'} ${row.applied &&
                  row.distance === 0
                    ? 'is-current'
                    : ''}"
                  ?disabled=${this.stepping}
                  title=${row.entry.metadata.description ?? this.label(row.entry)}
                  @click=${() => void this.step(row.distance)}
                >
                  <span class="history-row__icon"
                    >${this.icons.getIcon('edit-2', IconSize.SMALL)}</span
                  >
                  <span class="history-row__label">${this.label(row.entry)}</span>
                  <span class="history-row__time"
                    >${timeFormat.format(new Date(row.entry.timestamp))}</span
                  >
                </button>
              </li>
            `
          )}
        </ol>
        ${rows.length === 0
          ? html`<p class="history-empty">No edits yet in this scene.</p>`
          : html``}
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-history-panel': HistoryPanel;
  }
}
