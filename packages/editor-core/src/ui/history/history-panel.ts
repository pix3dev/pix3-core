import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, state } from '@/fw';
import type { HistoryEntry, HistorySnapshot } from '@/core/HistoryManager';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { DialogService } from '@/services/editor/DialogService';
import { SceneJournalService } from '@/services/project/SceneJournalService';
import { SceneMergeService } from '@/services/project/SceneMergeService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import type { HostHistoryEntry } from '@/host/EditorHost';
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

const AUTHOR_LABEL: Record<HostHistoryEntry['author'], string> = {
  editor: 'Saved here',
  external: 'Changed on disk',
  restore: 'Restored',
  'rejected-draft': 'Not saved (kept)',
};

/**
 * History panel: the active scene's undo/redo stack as a list (oldest at the top). Clicking a row
 * steps the stack to just after that edit — every step goes through the `edit.undo` / `edit.redo`
 * commands, so it is exactly what pressing Ctrl+Z / Ctrl+Shift+Z that many times would do.
 *
 * Below it, **Versions on disk**: the dev server's journal of this scene file (plan §C.4) — every
 * save, every external change, every editor state a merge or a hand-over did not keep. "Restore…"
 * writes one back (`SceneMergeService.restoreVersion`); undo cannot reach across a reload, this can.
 *
 * History is per scene (`OperationService`), so both lists follow the active scene tab.
 */
@customElement('pix3-history-panel')
export class HistoryPanel extends ComponentBase {
  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(SceneJournalService)
  private readonly journal!: SceneJournalService;

  @inject(SceneMergeService)
  private readonly merges!: SceneMergeService;

  @inject(DialogService)
  private readonly dialogs!: DialogService;

  @inject(SceneBaselineService)
  private readonly baselines!: SceneBaselineService;

  @state()
  private versions: HostHistoryEntry[] = [];

  private versionsKey = '';

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
    void this.refreshVersions();
  }

  private activeDescriptor() {
    const id = appState.scenes.activeSceneId;
    return id ? (appState.scenes.descriptors[id] ?? null) : null;
  }

  /** Re-list when the scene or its disk version changed (a save, a reload, a merge). */
  private async refreshVersions(): Promise<void> {
    const descriptor = this.activeDescriptor();
    const key = descriptor
      ? `${descriptor.filePath}@${descriptor.lastSavedAt ?? ''}@${appState.scenes.lastLoadedAt ?? ''}`
      : '';
    if (key === this.versionsKey) return;
    this.versionsKey = key;
    if (!descriptor || !this.journal.available) {
      this.versions = [];
      return;
    }
    try {
      this.versions = await this.journal.list(descriptor.filePath);
    } catch {
      this.versions = [];
    }
  }

  private async restore(entry: HostHistoryEntry): Promise<void> {
    const descriptor = this.activeDescriptor();
    if (!descriptor) return;
    const confirmed = await this.dialogs.showConfirmation({
      title: 'Restore version',
      message: `Write the version of ${entry.path} from ${timeFormat.format(new Date(entry.at))} back to disk? The current version stays in this list.`,
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    await this.merges.restoreVersion(descriptor, entry.id);
    this.versionsKey = '';
    void this.refreshVersions();
  }

  private renderVersions() {
    if (!this.journal.available) return null;
    const descriptor = this.activeDescriptor();
    const currentSha = descriptor ? this.baselines.get(descriptor.filePath)?.sha : undefined;
    return html`
      <h3 class="history-section">Versions on disk</h3>
      ${this.versions.length === 0
        ? html`<p class="history-empty">No versions journaled yet.</p>`
        : html`<ol class="history-list history-versions" aria-label="Versions on disk">
            ${this.versions.map(
              entry =>
                html`<li class="history-version" data-version-id=${entry.id}>
                  <span class="history-row__icon"
                    >${this.icons.getIcon(
                      entry.author === 'rejected-draft' ? 'archive' : 'hard-drive',
                      IconSize.SMALL
                    )}</span
                  >
                  <span class="history-row__label" title=${entry.note ?? ''}
                    >${AUTHOR_LABEL[entry.author]}${entry.sha256 === currentSha
                      ? ' (on disk)'
                      : ''}</span
                  >
                  <span class="history-row__time">${timeFormat.format(new Date(entry.at))}</span>
                  <button
                    type="button"
                    class="history-btn history-version__restore"
                    title="Restore this version…"
                    aria-label="Restore this version…"
                    @click=${() => void this.restore(entry)}
                  >
                    ${this.icons.getIcon('rotate-ccw', IconSize.SMALL)}
                  </button>
                </li>`
            )}
          </ol>`}
    `;
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
        panel-description="Undo history and saved versions of the active scene."
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
        ${this.renderVersions()}
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-history-panel': HistoryPanel;
  }
}
