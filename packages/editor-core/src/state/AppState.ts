import type { ProjectManifest } from '@/core/ProjectManifest';
import type { AnimationResource } from '@pix3/runtime';

export type ThemeName = 'dark' | 'light' | 'high-contrast';

const DEFAULT_THEME: ThemeName = 'dark';

export type SceneLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type AnimationLoadState = 'idle' | 'loading' | 'ready' | 'error';

export type EditorTabType = 'scene' | 'prefab' | 'script' | 'texture' | 'animation' | 'game';

export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom?: number;
}

export interface TabSelectionState {
  nodeIds: string[];
  primaryNodeId: string | null;
}

export interface EditorTab {
  /** Unique tab id. Recommended: `${type}:${resourceId}`. */
  id: string;
  /** Resource identifier (e.g. `res://scenes/level.pix3scene`). */
  resourceId: string;
  type: EditorTabType;
  title: string;
  isDirty: boolean;
  /** Optional type-specific state (camera, selection, scroll position, etc.). */
  contextState?: {
    camera?: CameraState;
    /** 2D navigation camera; kept here so it survives a reload via the persisted tab session. */
    camera2D?: CameraState;
    selection?: TabSelectionState;
    [key: string]: unknown;
  };
}

export interface TabsState {
  tabs: EditorTab[];
  activeTabId: string | null;
}

export interface SceneDescriptor {
  id: string;
  /** File-system path relative to the project root, e.g. `res://scenes/level-1.pix3scene`. */
  filePath: string;
  name: string;
  version: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  /** Last known modification time of the file (ms), for change detection polling. */
  lastModifiedTime?: number | null;
}

export interface SceneHierarchyState {
  version: string | null;
  description: string | null;
  rootNodes: unknown[]; // NodeBase instances (avoiding circular dependency)
  metadata: Record<string, unknown>;
}

export interface ScenesState {
  /** Currently focused scene identifier. */
  activeSceneId: string | null;
  /** Map of all scene descriptors currently loaded into memory. */
  descriptors: Record<string, SceneDescriptor>;
  /** Parsed hierarchy data keyed by scene id for UI consumption. */
  hierarchies: Record<string, SceneHierarchyState>;
  loadState: SceneLoadState;
  loadError: string | null;
  /** Timestamp (ms) when the most recent scene finished loading. */
  lastLoadedAt: number | null;
  /** FIFO queue of scene file paths scheduled for loading. */
  pendingScenePaths: string[];
  /** Counter incremented when node data (properties, scripts) changes but hierarchy remains unchanged. */
  nodeDataChangeSignal: number;

  /** Per-scene editor viewport camera state keyed by scene id. */
  editorCameraStates: Record<string, CameraState>;
  /** Per-scene 2D navigation camera state keyed by scene id. */
  navigation2DCameraStates: Record<string, CameraState>;
  /** Per-scene camera node used for the viewport preview inset. */
  previewCameraNodeIds: Record<string, string | null>;

  /**
   * Editor Peek: node ids the author has masked out of their own view, keyed by scene id.
   *
   * Per-user, non-serializable, outside undo. It never reaches the `.pix3scene` (that is the whole
   * point — see `docs/pix3-specification.md`, "Editor Peek") and it is not shared in collab; it is
   * mirrored to `localStorage` by `PeekService` so a reload does not force the author to re-hide
   * everything. Ids rather than names, so renaming a node keeps the mask and deleting one drops it.
   */
  peekHiddenByScene: Record<string, string[]>;

  /**
   * Editor Peek solo: the branch ids currently soloed, keyed by scene id. Everything outside the
   * set is faded, not hidden — an empty/absent entry means no solo is active.
   */
  peekSoloByScene: Record<string, string[]>;
}

export interface AnimationDescriptor {
  id: string;
  filePath: string;
  name: string;
  version: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  lastModifiedTime?: number | null;
}

export interface AnimationsState {
  /** Currently focused animation document identifier. */
  activeAnimationId: string | null;
  /** Map of animation document descriptors currently loaded into memory. */
  descriptors: Record<string, AnimationDescriptor>;
  /** Parsed animation resources keyed by animation document id. */
  resources: Record<string, AnimationResource>;
  loadState: AnimationLoadState;
  loadError: string | null;
  /** Timestamp (ms) when the most recent animation finished loading. */
  lastLoadedAt: number | null;
}

export type ProjectStatus = 'idle' | 'selecting' | 'opening' | 'ready' | 'error';
/** Where the project lives: always the plugin's file API in 2.x (plan §F, D3). */
export type ProjectBackend = 'host';

/** The editor tab's link to the dev server (`EditorHost`), see `.plans/editor-core-port.md` §2.5. */
export interface HostConnectionState {
  connection: 'open' | 'closed';
  /** Whether this tab may write: it holds the writer claim, another tab does, or nobody claimed. */
  writer: 'self' | 'other' | 'none';
  /** Open scenes whose file vanished from disk while open here (kept in memory, not written). */
  staleScenes: string[];
  /** Notices of the write model (merge results, an overwritten edit, a draft to restore). */
  notices: HostNotice[];
}

/** One notice of `HostNoticeService` (rendered by `pix3-host-banner`); actions run there. */
export interface HostNotice {
  id: string;
  tone: 'info' | 'warn';
  message: string;
  detail?: string;
  actions: { id: string; label: string }[];
}

export const createInitialHostConnectionState = (): HostConnectionState => ({
  connection: 'closed',
  writer: 'none',
  staleScenes: [],
  notices: [],
});

export type AssetBrowserViewMode = 'folders' | 'by-type';
export type ScriptLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectState {
  /** Unique ID for the project (used for persistence). */
  id: string | null;
  /** Active project storage backend. */
  backend: ProjectBackend;
  projectName: string | null;
  status: ProjectStatus;
  errorMessage: string | null;
  /** Last opened scene file relative to the project root. */
  lastOpenedScenePath: string | null;
  /** Asset browser expanded folder paths (persisted per project). */
  assetBrowserExpandedPaths: string[];
  /** Asset browser selected path (persisted per project). */
  assetBrowserSelectedPath: string | null;
  /** Asset browser view mode: raw folder structure or grouped by asset type (persisted per project). */
  assetBrowserViewMode: AssetBrowserViewMode;
  /** Asset browser expanded keys for the "group by type" view (persisted per project). */
  assetBrowserGroupedExpandedKeys: string[];
  /** Assets content-pane thumbnail tile size in px (persisted per project). */
  assetsThumbnailSize: number;
  /** Assets content-pane layout: thumbnail grid or details list (persisted per project). */
  assetsContentView: 'grid' | 'list';
  /** Current status of script compilation and loading. */
  scriptsStatus: ScriptLoadStatus;
  /** Signal counter incremented when project files change (triggers asset explorer refresh). */
  fileRefreshSignal: number;
  /** Signal counter incremented when scripts are recompiled. */
  scriptRefreshSignal: number;
  /** Directory path that was modified (e.g., 'Scenes' or 'Assets'). Used to refresh only affected folders. */
  lastModifiedDirectoryPath: string | null;
  /** Project manifest loaded from pix3project.yaml. */
  manifest: ProjectManifest | null;
  /** Connection to the dev server and the writer claim. */
  host: HostConnectionState;
}

export interface SelectionState {
  /** Nodes currently selected in the scene tree. */
  nodeIds: string[];
  /** Primary node (e.g., manipulator focus). */
  primaryNodeId: string | null;
  /** Node hovered by cursor-driven affordances. */
  hoveredNodeId: string | null;
  /**
   * Figma-style selection isolation scope: the container node whose direct
   * children are the click/hover-selectable set in the viewport. `null` means
   * the scene root (top-level nodes are selectable). Double-click drills in
   * (sets this to the entered container); Escape / empty click pops out.
   */
  focusNodeId: string | null;
}

export type FocusedArea = 'viewport' | 'scene-tree' | 'inspector' | 'assets' | null;

/**
 * Editor context state for keyboard shortcut execution context ("when" clauses).
 * Tracks which area of the editor is focused for context-sensitive shortcuts.
 */
export interface EditorContextState {
  /** Currently focused editor area/panel. */
  focusedArea: FocusedArea;
  /** True if an input element (input, textarea, contenteditable) has focus. */
  isInputFocused: boolean;
  /** True if a modal dialog is currently open. */
  isModalOpen: boolean;
}

export interface PanelVisibilityState {
  sceneTree: boolean;
  viewport: boolean;
  inspector: boolean;
  assets: boolean;
  animationTimeline: boolean;
  logs: boolean;
}

export type NavigationMode = '2d' | '3d';
export type EditorCameraProjection = 'perspective' | 'orthographic';

/**
 * Active viewport transform tool (Unity's Q/W/E/R). Declared here rather than in
 * `ViewportRenderService` because it is what the four `view.transform-mode-*` commands report as
 * their checked state: a menu check and a toolbar highlight both have to read the same snapshot,
 * and a field on a service is not in one.
 */
export type TransformMode = 'select' | 'translate' | 'rotate' | 'scale';

export interface Navigation2DSettings {
  /** Pan sensitivity for mouse/trackpad scrolling in 2D mode */
  panSensitivity: number;
  /** Zoom sensitivity for mouse wheel/trackpad pinch in 2D mode */
  zoomSensitivity: number;
}

export type GameAspectRatio = 'free' | '16:9-landscape' | '16:9-portrait' | '4:3';

/**
 * Details of the most recent runtime/script failure raised while the game was
 * launching or playing. Surfaced in the Game tab and the Logs panel so a broken
 * script no longer fails silently. Ephemeral UI state — never part of undo
 * history — so it is written directly (not via the mutation gateway), the same
 * way `project.errorMessage`/`scriptsStatus` are.
 */
export interface PlayModeError {
  /** Short, human-readable summary (usually the thrown Error's message). */
  message: string;
  /** Lifecycle stage the failure came from (start/update/scene-start/…). */
  phase?: string;
  /** Node this error is attributed to, when known. */
  nodeName?: string;
  /** Script component type that threw, when known. */
  componentType?: string;
  /** Epoch ms the error was recorded. */
  at: number;
}

export interface UIState {
  theme: ThemeName;
  isLayoutReady: boolean;
  focusedPanelId: string | null;
  commandPaletteOpen: boolean;
  panelVisibility: PanelVisibilityState;
  navigationMode: NavigationMode;
  /**
   * Active transform tool of the viewport. The gizmo itself lives in
   * `ViewportTransformSession`; this is the UI truth the toolbar highlight and the
   * `View ▸ Select/Move/Rotate/Scale` menu checks read.
   */
  transformMode: TransformMode;
  /** 2D navigation settings (pan/zoom sensitivity) */
  navigation2D: Navigation2DSettings;
  /** Toggle for showing the 2D orthographic layer overlay */
  showLayer2D: boolean;
  /** Toggle for showing the 3D perspective layer */
  showLayer3D: boolean;
  /** Projection mode of the editor-controlled 3D camera */
  editorCameraProjection: EditorCameraProjection;
  /** Toggle for showing the 3D grid helper */
  showGrid: boolean;
  /** Toggle for the viewport's corner orientation gizmo (X/Y/Z view cube) */
  showAxisGizmo: boolean;
  /** Snap dragged 2D nodes to a grid */
  snapToGrid: boolean;
  /** Grid cell size in world units used for 2D snapping */
  grid2DSize: number;
  /** Toggle for editor fallback lighting used when the scene has no explicit light sources */
  showLighting: boolean;
  /** Toggle for the physics collider wireframe overlay in the running game preview */
  showPhysicsColliders: boolean;
  /**
   * Toggle for drawing every node's authored 2D collider outline in the EDITOR
   * viewport (Godot's "Visible Collision Shapes"). Selected nodes always show
   * theirs; this extends it to the whole scene. Distinct from
   * {@link showPhysicsColliders}, which is the running game's overlay.
   */
  showCollisionShapes: boolean;
  /**
   * The collision polygon currently open for vertex editing in the viewport, or
   * null. Lives in UI state rather than in a service because the inspector opens
   * it, the viewport tool consumes it, and both re-render off the same subscribe.
   */
  polygonEditing: { nodeId: string; componentId: string } | null;
  /** Toggle for per-node direction-axis gizmos in the running game preview */
  showDirectionAxes: boolean;
  /** Pause rendering when the window is unfocused for battery economy */
  pauseRenderingOnUnfocus: boolean;
  /**
   * Keep the editor running in the background while an agent is connected (`AgentKeepaliveService`):
   * the battery-saving pauses never gate work an agent asked for.
   */
  keepEditorRunningForAgent: boolean;
  /** Preferred aspect ratio for the runtime preview surface */
  gameAspectRatio: GameAspectRatio;
  /** True when the scene is in play mode (scripts running) */
  isPlaying: boolean;
  /** True when a dedicated external game preview window is open */
  isGamePopoutOpen: boolean;
  playModeStatus: 'stopped' | 'playing' | 'paused';
  /** Most recent runtime/script failure while playing, or null when clean. */
  playModeError: PlayModeError | null;
  /** Who started the running play session (plan §B.3): the agent may stop only its own. */
  playOwner: 'agent' | 'designer' | null;
  /** Epoch ms the current play session started, or null when stopped. */
  playStartedAt: number | null;
  /** True between pointerdown and pointerup of a viewport drag; a flush waits for it (§C.1). */
  gestureInProgress: boolean;
}

export interface OperationState {
  /** True while a command/operation is executing. */
  isExecuting: boolean;
  /** Count of pending commands queued for execution. */
  pendingCommandCount: number;
  /** Identifier/name of the most recently executed command. */
  lastCommandId: string | null;
  /** Identifier of the last command that produced undo data. */
  lastUndoableCommandId: string | null;
}

/**
 * UI-facing localization state. IDs/counters only — the actual locale tables
 * live in `LocalizationEditorService` (same state-vs-scene-graph separation).
 * `previewLocale` is the editor-viewport preview; `revision` bumps on any table
 * edit so subscribed panels/widgets re-read. Empty `locales` ⇒ inert.
 */
export interface LocalizationState {
  locales: string[];
  defaultLocale: string;
  previewLocale: string;
  /** Per-locale count of keys missing vs. the default locale (panel badges). */
  missingCounts: Record<string, number>;
  revision: number;
}

export interface AppState {
  project: ProjectState;
  scenes: ScenesState;
  animations: AnimationsState;
  tabs: TabsState;
  selection: SelectionState;
  editorContext: EditorContextState;
  ui: UIState;
  operations: OperationState;
  localization: LocalizationState;
}

export const createInitialAppState = (): AppState => ({
  project: {
    id: null,
    backend: 'host',
    projectName: null,
    status: 'idle',
    errorMessage: null,
    lastOpenedScenePath: null,
    assetBrowserExpandedPaths: [],
    assetBrowserSelectedPath: null,
    assetBrowserViewMode: 'folders',
    assetBrowserGroupedExpandedKeys: [],
    assetsThumbnailSize: 104,
    assetsContentView: 'grid',
    scriptsStatus: 'idle',
    fileRefreshSignal: 0,
    scriptRefreshSignal: 0,
    lastModifiedDirectoryPath: null,
    manifest: null,
    host: createInitialHostConnectionState(),
  },
  scenes: {
    activeSceneId: null,
    descriptors: {},
    hierarchies: {},
    loadState: 'idle',
    loadError: null,
    lastLoadedAt: null,
    pendingScenePaths: [],
    nodeDataChangeSignal: 0,
    editorCameraStates: {},
    navigation2DCameraStates: {},
    previewCameraNodeIds: {},
    peekHiddenByScene: {},
    peekSoloByScene: {},
  },
  animations: {
    activeAnimationId: null,
    descriptors: {},
    resources: {},
    loadState: 'idle',
    loadError: null,
    lastLoadedAt: null,
  },
  tabs: {
    tabs: [],
    activeTabId: null,
  },
  selection: {
    nodeIds: [],
    primaryNodeId: null,
    hoveredNodeId: null,
    focusNodeId: null,
  },
  editorContext: {
    focusedArea: null,
    isInputFocused: false,
    isModalOpen: false,
  },
  ui: {
    theme: DEFAULT_THEME,
    isLayoutReady: false,
    focusedPanelId: null,
    commandPaletteOpen: false,
    panelVisibility: {
      sceneTree: true,
      viewport: true,
      inspector: true,
      assets: true,
      animationTimeline: true,
      logs: true,
    },
    navigationMode: '3d',
    transformMode: 'select',
    navigation2D: {
      panSensitivity: 0.75,
      zoomSensitivity: 0.001,
    },
    showLayer2D: true,
    showLayer3D: true,
    editorCameraProjection: 'perspective',
    showGrid: true,
    showAxisGizmo: true,
    snapToGrid: false,
    grid2DSize: 16,
    showLighting: true,
    showPhysicsColliders: false,
    showCollisionShapes: false,
    polygonEditing: null,
    showDirectionAxes: false,
    pauseRenderingOnUnfocus: true,
    keepEditorRunningForAgent: true,
    gameAspectRatio: 'free',
    isPlaying: false,
    isGamePopoutOpen: false,
    playModeStatus: 'stopped',
    playModeError: null,
    playOwner: null,
    playStartedAt: null,
    gestureInProgress: false,
  },
  operations: {
    isExecuting: false,
    pendingCommandCount: 0,
    lastCommandId: null,
    lastUndoableCommandId: null,
  },
  localization: {
    locales: [],
    defaultLocale: '',
    previewLocale: '',
    missingCounts: {},
    revision: 0,
  },
});
