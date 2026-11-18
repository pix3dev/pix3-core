import { inject } from '@/fw/di';
import {
  LayoutManagerService,
  PANEL_COMPONENT_TYPES,
  PANEL_DISPLAY_TITLES,
  type PanelComponentType,
} from '@/core/LayoutManager';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';

/**
 * `Window ▸ <panel>` — open-or-focus one dockable panel.
 *
 * Every closable panel needs a way back after its tab was closed (spec §2.5), and there are five
 * of them: Scene Tree, Inspector, Assets, Logs, History.
 * Five bespoke command classes would be five copies of the same three lines, so this is one base
 * class plus one thin subclass per panel — the subclass carries nothing but the panel it shows and
 * its own metadata literal.
 *
 * The metadata stays a *literal* in each subclass on purpose: the menu guard
 * (`CommandRegistry.menu.spec.ts`) parses these literals off disk to prove `(menuPath, menuOrder)`
 * is unique, and a computed `menuOrder` reads back as `NaN` and slips past it. The title is taken
 * from `PANEL_DISPLAY_TITLES` because the rule is that a Window row reads exactly like the tab it
 * opens — one source of names, so a tab rename cannot leave the menu behind.
 *
 * Behaviour: idempotent, and **never checkable**. A checkbox would invite closing a dock from the
 * menu, and in Golden Layout that collapses the stack and moves its neighbours; closing stays on
 * the tab's × (Unity does the same). Opening a panel is also not a scene change, hence
 * `didMutate: false` — no Operation, no undo entry.
 */
export abstract class ShowPanelCommand extends CommandBase<void, void> {
  abstract readonly metadata: CommandMetadata;

  /** The panel this row shows. */
  protected abstract readonly panel: PanelComponentType;

  @inject(LayoutManagerService)
  protected readonly layoutManager!: LayoutManagerService;

  /**
   * `LayoutManager.showPanel()` focuses the panel when it is in the layout and docks it back into
   * its home stack when it is not.
   */
  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    this.layoutManager.showPanel(this.panel);
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}

export class ShowSceneTreePanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.sceneTree;

  readonly metadata: CommandMetadata = {
    id: 'window.show-scene-tree',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.sceneTree],
    description: 'Show the Scene Tree panel',
    keywords: ['scene', 'tree', 'hierarchy', 'outliner', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 100,
  };
}

export class ShowInspectorPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.inspector;

  readonly metadata: CommandMetadata = {
    id: 'window.show-inspector',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.inspector],
    description: 'Show the Inspector panel',
    keywords: ['inspector', 'properties', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 110,
  };
}

export class ShowAssetsPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.assets;

  readonly metadata: CommandMetadata = {
    id: 'window.show-assets',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.assets],
    description: 'Show the Assets panel',
    keywords: ['assets', 'browser', 'files', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 120,
  };
}

export class ShowLogsPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.logs;

  readonly metadata: CommandMetadata = {
    id: 'window.show-logs',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.logs],
    description: 'Show the Logs panel',
    keywords: ['logs', 'console', 'output', 'errors', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 210,
  };
}

export class ShowHistoryPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.history;

  readonly metadata: CommandMetadata = {
    id: 'window.show-history',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.history],
    description: 'Show the undo History panel',
    keywords: ['history', 'undo', 'redo', 'edits', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 220,
  };
}

/** Every `Window ▸ <panel>` row, in menu order. Spread into the shell's `registerMany`. */
export const createShowPanelCommands = (): ShowPanelCommand[] => [
  new ShowSceneTreePanelCommand(),
  new ShowInspectorPanelCommand(),
  new ShowAssetsPanelCommand(),
  new ShowLogsPanelCommand(),
  new ShowHistoryPanelCommand(),
];
