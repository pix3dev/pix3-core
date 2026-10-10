import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { LayoutManagerService } from '@/core/LayoutManager';
import { OperationService } from '@/services/core/OperationService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { DialogService, type DialogInstance } from '@/services/editor/DialogService';
import {
  AssetImportDialogService,
  type AssetImportDialogInstance,
} from '@/services/assets/AssetImportDialogService';
import {
  BehaviorPickerService,
  type ComponentPickerInstance,
} from '@/services/editor/BehaviorPickerService';
import {
  EffectPickerService,
  type EffectPickerInstance,
} from '@/services/editor/EffectPickerService';
import {
  EditorSettingsService,
  type EditorSettingsDialogInstance,
} from '@/services/editor/EditorSettingsService';
import {
  NodeTypePickerService,
  type NodeTypePickerInstance,
} from '@/services/editor/NodeTypePickerService';
import { ScriptExecutionService } from '@/services/play/ScriptExecutionService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { PeekService } from '@/services/viewport/PeekService';
import { SaveActiveResourceCommand } from '@/features/editor/SaveActiveResourceCommand';
import { OpenEditorSettingsCommand } from '@/features/editor/OpenEditorSettingsCommand';
import { OpenGeneratePanelCommand } from '@/features/editor/OpenGeneratePanelCommand';
import { DeleteObjectCommand } from '@/features/scene/DeleteObjectCommand';
import { DuplicateNodesCommand } from '@/features/scene/DuplicateNodesCommand';
import { GroupSelectedNodesCommand } from '@/features/scene/GroupSelectedNodesCommand';
import { FitGroup2DToContentsCommand } from '@/features/scene/FitGroup2DToContentsCommand';
import { BrowseNodeTypesCommand } from '@/features/scene/BrowseNodeTypesCommand';
import { UndoCommand } from '@/features/history/UndoCommand';
import { RedoCommand } from '@/features/history/RedoCommand';
import { StartGameCommand } from '@/features/scripts/StartGameCommand';
import { StartMainSceneGameCommand } from '@/features/scripts/StartMainSceneGameCommand';
import { StopGameCommand } from '@/features/scripts/StopGameCommand';
import { RestartGameCommand } from '@/features/scripts/RestartGameCommand';
import { PauseGameCommand } from '@/features/scripts/PauseGameCommand';
import { OpenGamePopoutWindowCommand } from '@/features/scripts/OpenGamePopoutWindowCommand';
import { FocusAnimationTimelineCommand } from '@/features/animation-timeline/FocusAnimationTimelineCommand';
import { AddAnimationPlayerToSelectionCommand } from '@/features/animation-timeline/AddAnimationPlayerToSelectionCommand';
import { OpenLocalizationPanelCommand } from '@/features/localization/OpenLocalizationPanelCommand';
import { createTransformModeCommands } from '@/features/viewport/SetTransformModeCommand';
import { createShowPanelCommands } from '@/features/window/ShowPanelCommand';
import { ResetLayoutCommand } from '@/features/window/ResetLayoutCommand';
import { createAlign2DMenuCommands } from '@/features/alignment/Align2DMenuCommands';
import { ToggleGridCommand } from '@/features/viewport/ToggleGridCommand';
import { ToggleAxisGizmoCommand } from '@/features/viewport/ToggleAxisGizmoCommand';
import { ToggleSnapToGridCommand } from '@/features/viewport/ToggleSnapToGridCommand';
import { ToggleLayer2DCommand } from '@/features/viewport/ToggleLayer2DCommand';
import { ToggleLayer3DCommand } from '@/features/viewport/ToggleLayer3DCommand';
import { ZoomDefaultCommand } from '@/features/viewport/ZoomDefaultCommand';
import { ZoomAllCommand } from '@/features/viewport/ZoomAllCommand';
import { FrameSelectedCommand } from '@/features/viewport/FrameSelectedCommand';
import { ZoomInCommand } from '@/features/viewport/ZoomInCommand';
import { ZoomOutCommand } from '@/features/viewport/ZoomOutCommand';
import { ToggleLightingCommand } from '@/features/viewport/ToggleLightingCommand';
import { ToggleCollidersCommand } from '@/features/viewport/ToggleCollidersCommand';
import { ToggleCollisionShapesCommand } from '@/features/viewport/ToggleCollisionShapesCommand';
import { ToggleDirectionAxesCommand } from '@/features/viewport/ToggleDirectionAxesCommand';
import { ToggleNavigationModeCommand } from '@/features/viewport/ToggleNavigationModeCommand';
import { PeekShowAllCommand } from '@/features/peek/PeekCommands';
import { NudgeNodesCommand } from '@/features/properties/NudgeNodesCommand';
import { appState } from '@/state';
import './shared/pix3-toolbar';
import './shared/pix3-toolbar-button';
import './shared/pix3-dropdown-button';
import type { DropdownItem } from './shared/pix3-dropdown-button';
import './shared/pix3-main-menu';
import './shared/pix3-confirm-dialog';
import './shared/pix3-behavior-picker';
import './shared/pix3-effect-picker';
import './shared/pix3-host-banner';
import './shared/pix3-editor-settings-dialog';
import './shared/pix3-asset-import-dialog';
import './shared/pix3-node-type-picker';
import './shared/pix3-status-bar';
import './shared/pix3-lightbox';
import './scene-tree/scene-tree-panel';
import './viewport/editor-tab';
import './viewport/game-tab';
import './object-inspector/inspector-panel';
import './logs-view/logs-panel';
import './pix3-editor-shell.ts.css';

/**
 * The editor's one screen (plan §2.1, step 9). `mountEditor` appends it once the project is open;
 * there is no router, welcome screen or second workspace to switch to. It owns:
 *
 * - the toolbar (main menu, Play + run options, project name),
 * - `.layout-host`, where `LayoutManagerService` builds the Golden Layout studio, after which the
 *   last session's tabs are restored or the project's entry scene is opened,
 * - the status bar and the host banner (read-only / disconnected),
 * - every dialog host the services raise (confirm, pickers, settings, import, …),
 * - command registration and the global keyboard shortcuts.
 */
@customElement('pix3-editor')
export class Pix3EditorShell extends ComponentBase {
  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(PeekService)
  private readonly peekService!: PeekService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(CommandRegistry)
  private readonly commandRegistry!: CommandRegistry;

  @inject(KeybindingService)
  private readonly keybindingService!: KeybindingService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(GamePlaySessionService)
  private readonly gamePlaySessionService!: GamePlaySessionService;

  @inject(LocalizationEditorService)
  private readonly localizationEditorService!: LocalizationEditorService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(BehaviorPickerService)
  private readonly behaviorPickerService!: BehaviorPickerService;

  @inject(EffectPickerService)
  private readonly effectPickerService!: EffectPickerService;

  @inject(AssetImportDialogService)
  private readonly assetImportDialogService!: AssetImportDialogService;

  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(NodeTypePickerService)
  private readonly nodeTypePickerService!: NodeTypePickerService;

  @inject(ScriptExecutionService)
  private readonly scriptExecutionService!: ScriptExecutionService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @state() private isLayoutReady = appState.ui.isLayoutReady;
  @state() private dialogs: DialogInstance[] = [];
  @state() private componentPickers: ComponentPickerInstance[] = [];
  @state() private effectPickers: EffectPickerInstance[] = [];
  @state() private activeEditorSettingsDialog: EditorSettingsDialogInstance | null = null;
  @state() private activeAssetImportDialog: AssetImportDialogInstance | null = null;
  @state() private activeNodeTypePicker: NodeTypePickerInstance | null = null;

  @property({ type: Boolean, reflect: true, attribute: 'shell-ready' })
  protected shellReady = false;

  private disposers: Array<() => void> = [];
  private keyboardHandler?: (e: KeyboardEvent) => void;
  /** Golden Layout is built once per shell. */
  private layoutInitStarted = false;
  /** Project whose tabs were already restored (or whose entry scene was opened). */
  private sessionOpenedForProjectId: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.registerCommands();

    this.disposers.push(
      this.dialogService.subscribe(dialogs => {
        this.dialogs = dialogs;
      }),
      this.editorSettingsService.subscribe(dialog => {
        this.activeEditorSettingsDialog = dialog;
      }),
      this.assetImportDialogService.subscribe(dialog => {
        this.activeAssetImportDialog = dialog;
      }),
      this.nodeTypePickerService.subscribe(picker => {
        this.activeNodeTypePicker = picker;
      }),
      this.behaviorPickerService.subscribe(pickers => {
        this.componentPickers = pickers;
      }),
      this.effectPickerService.subscribe(pickers => {
        this.effectPickers = pickers;
      }),
      subscribe(appState.ui, () => {
        this.isLayoutReady = appState.ui.isLayoutReady;
        this.shellReady = this.isLayoutReady;
        this.requestUpdate();
      }),
      // A project that is not `ready` yet when the shell connects (specs, a slow manifest) builds
      // the studio the moment it is.
      subscribe(appState.project, () => {
        this.requestUpdate();
        void this.ensureStudioLayout();
      }),
      subscribe(appState.scenes, () => {
        this.scriptExecutionService.onSceneChanged(appState.scenes.activeSceneId);
      })
    );

    this.keyboardHandler = this.handleKeyboardShortcuts.bind(this);
    window.addEventListener('keydown', this.keyboardHandler);

    // Tab sessions, play sessions and localization subscribe to state once, early.
    this.editorTabService.initialize();
    this.gamePlaySessionService.initialize();
    this.localizationEditorService.initialize();
    this.editorSettingsService.initialize();
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = undefined;
    }
    this.scriptExecutionService.stop();
    super.disconnectedCallback();
  }

  protected async firstUpdated(): Promise<void> {
    await this.ensureStudioLayout();
  }

  /** Every command the menus, the toolbar and the keyboard reach. */
  private registerCommands(): void {
    // Resolve PeekService here so its scene subscription and its localStorage restore happen at a
    // known moment, not whenever something first touches it (a menu precondition, the Play button).
    this.peekService.applyToActiveGraph();

    // Arrow-key nudge for selected 2D nodes (Shift = larger step).
    const nudgeCommands = (['up', 'down', 'left', 'right'] as const).flatMap(direction => [
      new NudgeNodesCommand({ direction, large: false }),
      new NudgeNodesCommand({ direction, large: true }),
    ]);

    this.commandRegistry.registerMany(
      new UndoCommand(this.operationService),
      new RedoCommand(this.operationService),
      new SaveActiveResourceCommand(),
      new DeleteObjectCommand(),
      new DuplicateNodesCommand(),
      new GroupSelectedNodesCommand(),
      new FitGroup2DToContentsCommand(),
      new StartGameCommand(this.editorTabService, this.gamePlaySessionService),
      new StartMainSceneGameCommand(this.editorTabService, this.gamePlaySessionService),
      new StopGameCommand(this.editorTabService, this.gamePlaySessionService),
      new RestartGameCommand(this.gamePlaySessionService),
      new PauseGameCommand(this.gamePlaySessionService),
      new OpenGamePopoutWindowCommand(this.gamePlaySessionService),
      new OpenEditorSettingsCommand(),
      new FocusAnimationTimelineCommand(),
      new OpenLocalizationPanelCommand(),
      new OpenGeneratePanelCommand(),
      new AddAnimationPlayerToSelectionCommand(),
      // Searchable fallback for the Create menu, whose rows are grouped by node type.
      new BrowseNodeTypesCommand(),
      // Window menu: one open-or-focus row per closable panel, plus the layout escape hatch.
      ...createShowPanelCommands(),
      new ResetLayoutCommand(),
      // Node > Align / Node > Distribute: the viewport strip's actions, as menu rows.
      ...createAlign2DMenuCommands(),
      ...createTransformModeCommands(),
      new ToggleGridCommand(),
      new ToggleAxisGizmoCommand(),
      new ToggleSnapToGridCommand(),
      new ToggleLayer2DCommand(),
      new ToggleLayer3DCommand(),
      new ZoomDefaultCommand(),
      new ZoomAllCommand(),
      new FrameSelectedCommand(),
      new ZoomInCommand(),
      new ZoomOutCommand(),
      new ToggleLightingCommand(),
      new ToggleCollidersCommand(),
      new ToggleCollisionShapesCommand(),
      new ToggleDirectionAxesCommand(),
      new ToggleNavigationModeCommand(),
      // Only Show All goes into the menu: the other Peek commands need a branch to act on and are
      // driven from `pix3-peek-strip`. This one is the guaranteed way out of a masked state.
      new PeekShowAllCommand(),
      ...nudgeCommands
    );
  }

  private handleKeyboardShortcuts(e: KeyboardEvent): void {
    const commandId = this.keybindingService.handleKeyboardEvent(e);
    if (commandId) {
      e.preventDefault();
      void this.commandDispatcher.executeById(commandId);
    }
  }

  /**
   * Build Golden Layout into `.layout-host` (once), then open the project's documents: the tabs the
   * last session of this project left open, or else its entry scene (`project.lastOpenedScenePath`,
   * which `ProjectService.openHostProject` sets to `defaultExportScenePath` / `scenes/main.pix3scene`).
   */
  private async ensureStudioLayout(): Promise<void> {
    if (appState.project.status !== 'ready' || this.layoutInitStarted) {
      await this.ensureProjectDocumentsOpen();
      return;
    }
    await this.updateComplete;
    const host = this.renderRoot.querySelector<HTMLDivElement>('.layout-host');
    if (!host || this.layoutInitStarted) {
      return;
    }
    this.layoutInitStarted = true;
    await this.layoutManager.initialize(host);
    this.shellReady = true;
    await this.ensureProjectDocumentsOpen();
  }

  private async ensureProjectDocumentsOpen(): Promise<void> {
    const projectId = appState.project.id;
    if (
      !this.layoutInitStarted ||
      appState.project.status !== 'ready' ||
      !projectId ||
      this.sessionOpenedForProjectId === projectId
    ) {
      return;
    }
    this.sessionOpenedForProjectId = projectId;

    await this.editorTabService.restoreProjectSession(projectId);
    if (appState.tabs.tabs.some(tab => tab.type === 'scene')) {
      return;
    }
    const entryScene = appState.project.lastOpenedScenePath;
    if (!entryScene) {
      return;
    }
    if (!(await this.storage.fileExists(entryScene))) {
      console.info('[Pix3EditorShell] Entry scene not found, nothing opened:', entryScene);
      return;
    }
    await this.editorTabService.focusOrOpenScene(entryScene);
  }

  protected render() {
    return html`
      <div class="editor-shell" data-ready=${this.shellReady ? 'true' : 'false'}>
        <div class="toolbar-layer">${this.renderToolbar()} ${this.renderProjectNameLabel()}</div>
        <div class="workspace" role="presentation">
          ${appState.project.status === 'error'
            ? html`<div class="shell-message shell-message--error">
                Could not open the project: ${appState.project.errorMessage ?? 'unknown error'}
              </div>`
            : null}
          <div class="layout-host" role="application" aria-busy=${!this.isLayoutReady}></div>
        </div>
        <pix3-status-bar></pix3-status-bar>
        <pix3-host-banner></pix3-host-banner>
        ${this.renderDialogHost()} ${this.renderPickerHost()} ${this.renderEffectPickerHost()}
        ${this.renderEditorSettingsHost()} ${this.renderAssetImportHost()}
        ${this.renderNodeTypePickerHost()}
      </div>
    `;
  }

  private renderToolbar() {
    const isPlaying = appState.ui.isPlaying;
    const runOptions: DropdownItem[] = [
      // Scene first: it is what the toolbar's own Play button does, and the entry scene is a menu on
      // every recipe project — a full-flow run is the deliberate choice, not the default.
      { id: 'game.start', label: 'Play Scene', icon: 'play', disabled: isPlaying },
      { id: 'game.start-main', label: 'Play Game', icon: 'film', disabled: isPlaying },
    ];
    return html`
      <pix3-toolbar aria-label="Editor toolbar">
        <pix3-main-menu slot="start"></pix3-main-menu>
        <div class="toolbar-content">
          <div class="toolbar-group toolbar-group--play">
            <pix3-toolbar-button
              icon=${isPlaying ? 'square' : 'play'}
              iconOnly
              label=${isPlaying ? 'Stop' : 'Play'}
              ?toggled=${isPlaying}
              @click=${() => this.togglePlayMode()}
              aria-label=${isPlaying ? 'Stop Scene' : 'Play Scene'}
            ></pix3-toolbar-button>
            <pix3-dropdown-button
              class="run-options-dropdown"
              aria-label="Run options"
              title="Run options"
              .items=${runOptions}
              @item-select=${this.onRunOptionSelect}
            ></pix3-dropdown-button>
          </div>
        </div>
      </pix3-toolbar>
    `;
  }

  private renderProjectNameLabel() {
    return html`
      <div class="project-identity">
        <span class="project-name-label">${appState.project.projectName ?? 'No project open'}</span>
      </div>
    `;
  }

  private togglePlayMode(): void {
    void this.commandDispatcher.executeById(appState.ui.isPlaying ? 'game.stop' : 'game.start');
  }

  private onRunOptionSelect = (event: CustomEvent<DropdownItem>): void => {
    event.stopPropagation();
    void this.commandDispatcher.executeById(event.detail.id);
  };

  // -- dialog hosts ----------------------------------------------------------

  private renderDialogHost() {
    return html`
      <div
        class="dialog-host"
        @dialog-confirmed=${(e: CustomEvent<{ dialogId: string }>) =>
          this.dialogService.confirm(e.detail.dialogId)}
        @dialog-cancelled=${(e: CustomEvent<{ dialogId: string }>) =>
          this.dialogService.cancel(e.detail.dialogId)}
        @dialog-secondary=${(e: CustomEvent<{ dialogId: string }>) =>
          this.dialogService.secondary(e.detail.dialogId)}
      >
        ${this.dialogs.map(
          dialog => html`
            <pix3-confirm-dialog
              .dialogId=${dialog.id}
              .title=${dialog.options.title}
              .message=${dialog.options.message}
              .confirmLabel=${dialog.options.confirmLabel || 'Confirm'}
              .secondaryLabel=${dialog.options.secondaryLabel || ''}
              .cancelLabel=${dialog.options.cancelLabel || 'Cancel'}
              .isDangerous=${dialog.options.isDangerous || false}
              .secondaryIsDangerous=${dialog.options.secondaryIsDangerous || false}
              .requiredInputLabel=${dialog.options.requiredInputLabel || ''}
              .requiredInputValue=${dialog.options.requiredInputValue || ''}
              .requiredInputPlaceholder=${dialog.options.requiredInputPlaceholder || ''}
              .disclaimer=${dialog.options.disclaimer || ''}
              .expandableSection=${dialog.options.expandableSection ?? null}
            ></pix3-confirm-dialog>
          `
        )}
      </div>
    `;
  }

  private renderPickerHost() {
    return html`
      <div
        class="picker-host"
        @component-selected=${(e: CustomEvent) =>
          this.behaviorPickerService.select(e.detail.pickerId, e.detail.component)}
        @component-picker-cancelled=${(e: CustomEvent) =>
          this.behaviorPickerService.cancel(e.detail.pickerId)}
      >
        ${this.componentPickers.map(
          picker => html`<pix3-behavior-picker .pickerId=${picker.id}></pix3-behavior-picker>`
        )}
      </div>
    `;
  }

  private renderEffectPickerHost() {
    return html`
      <div
        class="picker-host"
        @effect-selected=${(e: CustomEvent) =>
          this.effectPickerService.select(e.detail.pickerId, e.detail.effectType)}
        @effect-picker-cancelled=${(e: CustomEvent) =>
          this.effectPickerService.cancel(e.detail.pickerId)}
      >
        ${this.effectPickers.map(
          picker => html`
            <pix3-effect-picker
              .pickerId=${picker.id}
              .excludeTypes=${picker.excludeTypes}
              .target=${picker.target}
            ></pix3-effect-picker>
          `
        )}
      </div>
    `;
  }

  private renderEditorSettingsHost() {
    return this.activeEditorSettingsDialog
      ? html`<div class="editor-settings-host">
          <pix3-editor-settings-dialog></pix3-editor-settings-dialog>
        </div>`
      : null;
  }

  private renderAssetImportHost() {
    const dialog = this.activeAssetImportDialog;
    if (!dialog) {
      return null;
    }
    return html`
      <div
        class="asset-import-host"
        @asset-import-confirmed=${(
          event: CustomEvent<{ dialogId?: string; importedPaths?: string[] }>
        ) => {
          const { dialogId, importedPaths } = event.detail;
          if (typeof dialogId === 'string') {
            this.assetImportDialogService.confirm(dialogId, {
              importedPaths: Array.isArray(importedPaths) ? importedPaths : [],
            });
          }
        }}
        @asset-import-cancelled=${(event: CustomEvent<{ dialogId?: string }>) => {
          if (typeof event.detail.dialogId === 'string') {
            this.assetImportDialogService.cancel(event.detail.dialogId);
          }
        }}
      >
        <pix3-asset-import-dialog
          .dialogId=${dialog.id}
          .targetDirectory=${dialog.params.targetDirectory}
        ></pix3-asset-import-dialog>
      </div>
    `;
  }

  private renderNodeTypePickerHost() {
    const picker = this.activeNodeTypePicker;
    if (!picker) {
      return null;
    }
    return html`
      <div
        class="node-type-picker-host"
        @node-type-selected=${(event: CustomEvent<{ pickerId?: string; nodeTypeId?: string }>) => {
          const { pickerId, nodeTypeId } = event.detail;
          if (typeof pickerId === 'string' && typeof nodeTypeId === 'string') {
            this.nodeTypePickerService.select(pickerId, nodeTypeId);
          }
        }}
        @node-type-picker-cancelled=${(event: CustomEvent<{ pickerId?: string }>) => {
          if (typeof event.detail.pickerId === 'string') {
            this.nodeTypePickerService.cancel(event.detail.pickerId);
          }
        }}
      >
        <pix3-node-type-picker .pickerId=${picker.id}></pix3-node-type-picker>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-editor': Pix3EditorShell;
  }
}
