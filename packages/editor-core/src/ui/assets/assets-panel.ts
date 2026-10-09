import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { ref } from 'lit/directives/ref.js';
import { subscribe } from 'valtio/vanilla';
import { appState, type AssetBrowserViewMode } from '@/state';
import {
  AssetFileActivationService,
  type AssetActivation,
} from '@/services/assets/AssetFileActivationService';
import { AssetsPreviewService } from '@/services/assets/AssetsPreviewService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AssetImportDialogService } from '@/services/assets/AssetImportDialogService';
import { ProjectService } from '@/services/project/ProjectService';
import { hasGenerationDragData } from '@/ui/shared/asset-drag-drop';
import type { AssetTree } from './asset-tree';

import '../shared/pix3-panel';
import './asset-tree';
import './assets-content';
import './assets-panel.ts.css';
import { isReadOnlyTab } from '@/services/editor/read-only';

interface ScriptRevealRequestDetail {
  scriptType: string;
  scriptName: string;
  candidatePaths: string[];
}

interface AssetsPreviewRevealPathDetail {
  path: string;
}

const MIN_TREE_PANE_WIDTH = 140;
const DEFAULT_TREE_PANE_WIDTH = 220;

/**
 * Unified Assets panel (Phase 4): a folder-only navigator (left) + thumbnail/list
 * content pane (right), split by a draggable handle. Hosts the project-root row (Import…,
 * group-by-type); delegates file rendering to `<pix3-assets-content>` and folder navigation
 * to `<pix3-asset-tree>`. Browsing only: files and folders are created, renamed, moved and
 * deleted by the coding agent or the IDE, and the listing follows the disk (`pix3:fs` frames).
 */
@customElement('pix3-assets-panel')
export class AssetsPanel extends ComponentBase {
  @inject(AssetFileActivationService)
  private readonly assetFileActivation!: AssetFileActivationService;

  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(AssetImportDialogService)
  private readonly assetImportDialogService!: AssetImportDialogService;

  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  private assetTreeRef: AssetTree | null = null;
  private splitEl: HTMLElement | null = null;

  @state()
  private assetViewMode: AssetBrowserViewMode = 'folders';

  @state()
  private treePaneWidth = DEFAULT_TREE_PANE_WIDTH;

  /** Currently-selected folder path from the AssetsPreviewService (drives root-row highlight). */
  @state()
  private selectedFolderPath: string | null = null;

  private disposeViewModeSubscription?: () => void;
  private disposePreviewSubscription?: () => void;

  private scriptFileRevealRequestHandler?: (e: Event) => void;
  private assetsPreviewRevealPathHandler?: (e: Event) => void;

  // Splitter drag bookkeeping.
  private splitterActive = false;
  private splitterStartX = 0;
  private splitterStartWidth = DEFAULT_TREE_PANE_WIDTH;

  connectedCallback(): void {
    super.connectedCallback();

    // Track focus for context-aware shortcuts.
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'assets';
    });

    // Keep the group-by-type toggle in sync with restored per-project state.
    this.assetViewMode = appState.project.assetBrowserViewMode;
    this.disposeViewModeSubscription = subscribe(appState.project, () => {
      if (appState.project.assetBrowserViewMode !== this.assetViewMode) {
        this.assetViewMode = appState.project.assetBrowserViewMode;
      }
    });

    // Track the selected folder so the root row can reflect the "root selected" state.
    this.disposePreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      if (snapshot.selectedFolderPath !== this.selectedFolderPath) {
        this.selectedFolderPath = snapshot.selectedFolderPath;
      }
    });

    // Restore the persisted tree-pane width.
    const persisted = this.projectService.loadAssetBrowserState();
    if (persisted?.treePaneWidth && Number.isFinite(persisted.treePaneWidth)) {
      this.treePaneWidth = Math.max(MIN_TREE_PANE_WIDTH, Math.round(persisted.treePaneWidth));
    }

    this.scriptFileRevealRequestHandler = (e: Event) => {
      const customEvent = e as CustomEvent<ScriptRevealRequestDetail>;
      void this.onScriptFileRevealRequested(customEvent.detail);
    };
    window.addEventListener(
      'script-file-reveal-request',
      this.scriptFileRevealRequestHandler as EventListener
    );

    this.assetsPreviewRevealPathHandler = (e: Event) => {
      const customEvent = e as CustomEvent<AssetsPreviewRevealPathDetail>;
      void this.onAssetsPreviewRevealPath(customEvent.detail);
    };
    window.addEventListener(
      'assets-preview:reveal-path',
      this.assetsPreviewRevealPathHandler as EventListener
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();

    this.disposeViewModeSubscription?.();
    this.disposeViewModeSubscription = undefined;
    this.disposePreviewSubscription?.();
    this.disposePreviewSubscription = undefined;

    if (this.scriptFileRevealRequestHandler) {
      window.removeEventListener(
        'script-file-reveal-request',
        this.scriptFileRevealRequestHandler as EventListener
      );
      this.scriptFileRevealRequestHandler = undefined;
    }
    if (this.assetsPreviewRevealPathHandler) {
      window.removeEventListener(
        'assets-preview:reveal-path',
        this.assetsPreviewRevealPathHandler as EventListener
      );
      this.assetsPreviewRevealPathHandler = undefined;
    }
  }

  private setAssetTreeRef = (element: Element | undefined) => {
    this.assetTreeRef = (element as AssetTree) || null;
  };

  private setSplitRef = (element: Element | undefined) => {
    this.splitEl = (element as HTMLElement) || null;
  };

  private get isRootSelected(): boolean {
    return (
      this.selectedFolderPath === null ||
      this.selectedFolderPath === '' ||
      this.selectedFolderPath === '.'
    );
  }

  // ── Asset activation ─────────────────────────────────────────────────────
  private onAssetActivate = async (e: Event) => {
    const detail = (e as CustomEvent<AssetActivation>).detail;
    if (!detail) return;
    await this.assetFileActivation.handleActivation(detail);
  };

  // ── Root-row selection ───────────────────────────────────────────────────
  private selectRoot(): void {
    this.assetTreeRef?.clearSelection();
    void this.assetsPreviewService.syncFromAssetSelection('.', 'directory');
  }

  // ── Content-pane events ──────────────────────────────────────────────────
  private onFolderNavigate = (e: Event) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (path === undefined) return;
    if (path === '.' || path === '') {
      this.selectRoot();
      return;
    }
    void this.assetTreeRef?.selectPath(path);
  };

  // ── Toolbar actions ──────────────────────────────────────────────────────
  private onImportClick = async () => {
    try {
      const targetDirectory =
        this.selectedFolderPath ?? this.assetTreeRef?.getTargetDirectory?.() ?? '.';
      const result = await this.assetImportDialogService.showDialog({ targetDirectory });
      if (result && result.importedPaths.length > 0) {
        await this.assetTreeRef?.selectPath(result.importedPaths[0]);
      }
    } catch (error) {
      console.error('[AssetsPanel] Failed to import assets:', error);
    }
  };

  private onToggleViewMode = () => {
    const next: AssetBrowserViewMode = this.assetViewMode === 'by-type' ? 'folders' : 'by-type';
    this.assetViewMode = next;
    void this.assetTreeRef?.setViewMode(next);
  };

  // ── Window-event reveal handlers (external entry points) ──────────────────
  private async onScriptFileRevealRequested(detail: ScriptRevealRequestDetail): Promise<void> {
    if (!detail || detail.scriptType.length === 0 || detail.scriptName.length === 0) {
      return;
    }
    if (!detail.scriptType.startsWith('user:')) {
      return;
    }
    if (!this.assetTreeRef) {
      return;
    }

    for (const candidatePath of detail.candidatePaths) {
      if (await this.assetTreeRef.selectPath(candidatePath)) {
        return;
      }
    }

    console.warn('[AssetsPanel] Failed to reveal user script:', detail);
  }

  private async onAssetsPreviewRevealPath(detail: AssetsPreviewRevealPathDetail): Promise<void> {
    if (!detail?.path || !this.assetTreeRef) {
      return;
    }
    const selected = await this.assetTreeRef.selectPath(detail.path);
    if (!selected) {
      console.warn('[AssetsPanel] Failed to reveal folder from assets preview:', detail.path);
    }
  }

  // ── Splitter ─────────────────────────────────────────────────────────────
  private onSplitterPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    this.splitterActive = true;
    this.splitterStartX = event.clientX;
    this.splitterStartWidth = this.treePaneWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', this.onSplitterPointerMove);
    handle.addEventListener('pointerup', this.onSplitterPointerUp);
    handle.addEventListener('lostpointercapture', this.onSplitterPointerUp);
  };

  private onSplitterPointerMove = (event: PointerEvent) => {
    if (!this.splitterActive) {
      return;
    }
    const delta = event.clientX - this.splitterStartX;
    const maxWidth = this.splitEl
      ? Math.max(MIN_TREE_PANE_WIDTH, this.splitEl.clientWidth * 0.5)
      : 400;
    const next = Math.min(maxWidth, Math.max(MIN_TREE_PANE_WIDTH, this.splitterStartWidth + delta));
    this.treePaneWidth = Math.round(next);
  };

  private onSplitterPointerUp = (event: PointerEvent) => {
    if (!this.splitterActive) {
      return;
    }
    this.splitterActive = false;
    const handle = event.currentTarget as HTMLElement;
    handle.removeEventListener('pointermove', this.onSplitterPointerMove);
    handle.removeEventListener('pointerup', this.onSplitterPointerUp);
    handle.removeEventListener('lostpointercapture', this.onSplitterPointerUp);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released
    }
    this.projectService.saveAssetBrowserState({ treePaneWidth: this.treePaneWidth });
  };

  // ── Drop target for the root row (OS files, a generated image) ───────────
  private onRootDragOver = (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (isReadOnlyTab() || !transfer) {
      return;
    }
    const accepted =
      hasGenerationDragData(transfer) ||
      Array.from(transfer.items ?? []).some(item => item.kind === 'file');
    if (!accepted) {
      return;
    }
    event.preventDefault();
    transfer.dropEffect = 'copy';
  };

  private onRootDrop = (event: DragEvent) => {
    if (isReadOnlyTab() || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    void this.assetTreeRef?.handleRootDrop(event.dataTransfer);
  };

  protected render() {
    const isReadOnly = isReadOnlyTab();
    const rootLabel = appState.project.projectName ?? 'Assets';

    return html`
      <pix3-panel
        panel-description="Open a project to browse textures, models, and prefabs."
        actions-label="Assets actions"
        @asset-activate=${this.onAssetActivate}
        @folder-navigate=${this.onFolderNavigate}
      >
        <div
          class="assets-split"
          style=${`--assets-tree-width: ${this.treePaneWidth}px;`}
          ${ref(this.setSplitRef)}
        >
          <div class="assets-tree-pane">
            <div
              class="tree-root-row ${this.isRootSelected ? 'selected' : ''}"
              @click=${() => this.selectRoot()}
              @dragover=${this.onRootDragOver}
              @drop=${this.onRootDrop}
            >
              <span class="icon folder"
                >${this.iconService.getIcon('folder-solid', IconSize.MEDIUM)}</span
              >
              <span class="root-label" title=${rootLabel}>${rootLabel}</span>
              <span class="root-actions" @click=${(e: Event) => e.stopPropagation()}>
                <button
                  type="button"
                  class="root-action-btn"
                  aria-label="Import…"
                  title="Import files into the selected folder…"
                  ?disabled=${isReadOnly}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    void this.onImportClick();
                  }}
                >
                  ${this.iconService.getIcon('upload', IconSize.SMALL)}
                </button>
                <button
                  type="button"
                  class="root-action-btn ${this.assetViewMode === 'by-type' ? 'is-active' : ''}"
                  aria-label="Group by type"
                  aria-pressed=${this.assetViewMode === 'by-type'}
                  title=${this.assetViewMode === 'by-type'
                    ? 'Show project folder structure'
                    : 'Group assets by type'}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.onToggleViewMode();
                  }}
                >
                  ${this.iconService.getIcon('layers', IconSize.SMALL)}
                </button>
              </span>
            </div>
            <pix3-asset-tree ${ref(this.setAssetTreeRef)}></pix3-asset-tree>
          </div>
          <div
            class="assets-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize folder pane"
            @pointerdown=${this.onSplitterPointerDown}
          ></div>
          <pix3-assets-content></pix3-assets-content>
        </div>
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-assets-panel': AssetsPanel;
  }
}
