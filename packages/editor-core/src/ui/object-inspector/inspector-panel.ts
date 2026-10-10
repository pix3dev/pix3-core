import { ComponentBase, customElement, html, state, subscribe, inject } from '@/fw';
import { getNodePropertySchema, getRuntimeSceneRoot, NodeBase, Sprite2D } from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { appState } from '@/state';
import type { PropertySchema, PropertyDefinition } from '@/fw';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { UpdateSprite2DSizeCommand } from '@/features/properties/UpdateSprite2DSizeCommand';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { BehaviorPickerService } from '@/services/editor/BehaviorPickerService';
import { EffectPickerService } from '@/services/editor/EffectPickerService';
import { ScriptRegistry } from '@pix3/runtime';
import { IconService } from '@/services/editor/IconService';
import { AnimationEditorService } from '@/services/animation/AnimationEditorService';
import {
  AssetsPreviewService,
  type AssetPreviewItem,
} from '@/services/assets/AssetsPreviewService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { LightboxService } from '@/services/editor/LightboxService';
import { HostService } from '@/host/HostService';
import type {
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/animation/AnimationEditorService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { SpineSkeleton2D } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Polygon2DEditController } from '@/services/viewport/Polygon2DEditController';
import { boxPolygon, serializePolygonConfig } from '@pix3/runtime';
import { readAlphaMask } from '@/core/alpha-mask';
import { traceCollisionPolygon } from '@/core/contour-trace';
import { mapImagePolygonToSpriteLocal } from '@/features/scene/collider-shapes';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { emojiAsArtFieldError } from '@/services/scene/emoji-as-art';
import { InspectorResourcePreview } from './inspector-resource-preview';
import { InspectorSectionRenderers } from './inspector-section-renderers';
import {
  InspectorPropertyRenderers,
  getComponentPropertyKey,
  getPropertyDisplayValue,
  inspectorSectionStateKey,
  readInspectorCollapsedSections,
  writeInspectorCollapsedSections,
} from './inspector-property-renderers';

import '../shared/pix3-panel';
import './inspector-panel.ts.css';
import './inspector-controls.ts.css';
import './model-asset-preview';
import './property-editors';

/**
 * Poll cadence for the play-mode live read-out (~12.5 Hz). Fast enough to feel
 * "live" without re-rendering the inspector on every animation frame.
 */
const LIVE_REFRESH_INTERVAL_MS = 80;

interface PropertyUIState {
  value: string;
  isValid: boolean;
  /** Why the typed value is refused (shown under the field); nothing was written. */
  error?: string;
}

@customElement('pix3-inspector-panel')
export class InspectorPanel extends ComponentBase {
  @inject(SceneManager)
  readonly sceneManager!: SceneManager;

  @inject(CommandDispatcher)
  readonly commandDispatcher!: CommandDispatcher;

  @inject(BehaviorPickerService)
  readonly behaviorPickerService!: BehaviorPickerService;

  @inject(EffectPickerService)
  readonly effectPickerService!: EffectPickerService;

  @inject(ScriptRegistry)
  readonly scriptRegistry!: ScriptRegistry;

  @inject(IconService)
  readonly iconService!: IconService;

  @inject(ProjectStorageService)
  readonly projectStorage!: ProjectStorageService;

  @inject(EditorTabService)
  readonly editorTabService!: EditorTabService;

  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(AnimationEditorService)
  readonly animationEditorService!: AnimationEditorService;

  @inject(ViewportRendererService)
  readonly viewportService!: ViewportRendererService;

  @inject(LocalizationEditorService)
  readonly localizationEditorService!: LocalizationEditorService;

  @inject(Polygon2DEditController)
  private readonly polygonEditor!: Polygon2DEditController;

  @inject(LightboxService)
  private readonly lightbox!: LightboxService;

  @inject(HostService)
  private readonly hostService!: HostService;

  @state()
  selectedNodes: NodeBase[] = [];

  @state()
  primaryNode: NodeBase | null = null;

  /**
   * True while play mode is active AND the selected node resolves to its live
   * runtime-clone counterpart. Drives the "LIVE" badge variant and live value
   * mirroring; the read-only gate itself keys off play mode (`isPlaying`).
   */
  @state()
  isLivePlayMode = false;

  /**
   * Whether play mode is active. Reactive so the inspector can render its
   * read-only play-mode badge/tint, and used to detect transitions on the
   * (noisy) appState.ui subscription. Two-way editing during play is out of scope.
   */
  @state()
  isPlaying = appState.ui.isPlaying;

  /** Interval that re-reads live values off the runtime clone while playing. */
  private liveRefreshTimer: number | null = null;

  @state()
  propertySchema: PropertySchema | null = null;

  @state()
  propertyValues: Record<string, PropertyUIState> = {};

  @state()
  componentPropertyValues: Record<string, PropertyUIState> = {};

  @state()
  selectedAssetItem: AssetPreviewItem | null = null;

  @state()
  activePreviewAnimation: string | null = null;

  @state()
  newGroupName: string = '';

  @state()
  newGroupError: string | null = null;

  @state()
  isGroupsEditorOpen = false;

  @state()
  activeAnimationState: AnimationInspectorSnapshot | null = null;

  /**
   * Collapsed inspector sections, keyed `(nodeTypeId, sectionName)` and read
   * once on connect from the single `pix3.inspector.collapsed` localStorage key.
   * Pure UI state: it is not scene state, so it never goes through a Command.
   */
  @state()
  private collapsedSections: Record<string, boolean> = {};

  private disposeSelectionSubscription?: () => void;
  private disposeSceneSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeLocalizationSubscription?: () => void;
  private disposeScriptSubscription?: () => void;
  /** `appState.project.scriptRefreshSignal` this panel last rendered against. */
  private lastScriptRefreshSignal = appState.project.scriptRefreshSignal;
  private disposeAssetPreviewSubscription?: () => void;
  private disposeAnimationEditorSubscription?: () => void;
  disposeAnimationControllerSubscription?: () => void;
  activeAnimationController: AnimationInspectorController | null = null;

  /** `${clipName}#${frameIndex}` of the last rendered animation selection (scroll-into-view guard). */
  private lastAnimationSelectionKey: string | null = null;
  private lastAnimationClipName: string | undefined = undefined;

  readonly resourcePreview = new InspectorResourcePreview(this);
  readonly sectionRenderers = new InspectorSectionRenderers(this);
  readonly propertyRenderers = new InspectorPropertyRenderers(this);
  private readonly propertyPreviewStartValues = new Map<string, unknown>();
  private readonly componentPropertyPreviewStartValues = new Map<string, unknown>();
  /**
   * Text fields showing a refused value (`E_EMOJI_AS_ART`), keyed like `propertyValues` /
   * `componentPropertyValues`. Nothing was written for them, so a resync from the node (any
   * command, including the revert of a preview) would put the old value back and hide why; the
   * refusal is laid over the synced values until the field gets a value it accepts or the
   * selection moves.
   */
  private readonly refusedPropertyValues = new Map<string, PropertyUIState>();
  private readonly refusedComponentValues = new Map<string, PropertyUIState>();

  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.isGroupsEditorOpen) {
      return;
    }

    if (!event.composedPath().includes(this)) {
      this.isGroupsEditorOpen = false;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    // Anchor the transition detector to the play state at mount time — the panel
    // may be lazily mounted (Golden Layout) while a game is already running.
    this.isPlaying = appState.ui.isPlaying;
    this.collapsedSections = readInspectorCollapsedSections();
    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      this.updateSelectedNodes();
    });
    this.disposeSceneSubscription = subscribe(appState.scenes, () => {
      this.updateSelectedNodes();
    });
    this.disposeUiSubscription = subscribe(appState.ui, () => {
      if (this.isPlaying !== appState.ui.isPlaying) {
        this.isPlaying = appState.ui.isPlaying;
        this.onPlayModeChanged();
      }
    });
    // Re-render the localization-key editor's status/preview when the preview
    // locale switches or a locale table is edited.
    this.disposeLocalizationSubscription = subscribe(appState.localization, () => {
      this.requestUpdate();
    });
    // Project scripts re-registered (a sync or an edit re-imported them): component schemas
    // come from the registry by type, so the selected node's fields are rebuilt from the new
    // classes — a field a script added shows up without reselecting.
    this.lastScriptRefreshSignal = appState.project.scriptRefreshSignal;
    this.disposeScriptSubscription = subscribe(appState.project, () => {
      if (appState.project.scriptRefreshSignal === this.lastScriptRefreshSignal) return;
      this.lastScriptRefreshSignal = appState.project.scriptRefreshSignal;
      this.updateSelectedNodes();
      this.requestUpdate();
    });
    this.disposeAssetPreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      this.selectedAssetItem = snapshot.selectedItem;
      if (snapshot.selectedItem?.previewType === 'model') {
        this.assetsPreviewService.requestThumbnail(snapshot.selectedItem.path);
      }
      this.requestUpdate();
    });
    this.disposeAnimationEditorSubscription = this.animationEditorService.subscribe(() => {
      this.sectionRenderers.syncActiveAnimationContext();
    });
    this.updateSelectedNodes();
    this.sectionRenderers.syncActiveAnimationContext();
    if (appState.ui.isPlaying) {
      this.startLiveTimer();
    }

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'inspector';
    });

    // Resource editors (texture/audio/model/animation) emit `locate-resource`
    // when the user clicks "Locate"; reveal the file in the Asset Browser and
    // Assets Preview.
    this.addEventListener('locate-resource', this.onLocateResource as EventListener);
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  /**
   * Reveal the resource behind a `locate-resource` event in the Asset Browser
   * (expand + select the file, which also drives the Assets Preview). Works from
   * any resource editor (texture / audio / model / animation).
   */
  private readonly onLocateResource = (event: Event): void => {
    const detail = (event as CustomEvent<{ url?: string }>).detail;
    const url = detail?.url?.trim();
    if (!url) {
      return;
    }
    // res:// resource URL → project-relative path (matches Asset Browser paths).
    const path = this.projectStorage.normalizeResourcePath(url);
    // syncFromAssetSelection updates the Assets Preview even when the Asset
    // Browser panel is not mounted; the reveal-path event drives the Asset
    // Browser tree (expand + select) when it is — the same channel the Assets
    // Preview uses to reveal a folder in the tree.
    void this.assetsPreviewService.syncFromAssetSelection(path, 'file');
    window.dispatchEvent(new CustomEvent('assets-preview:reveal-path', { detail: { path } }));
  };

  /**
   * Whether a property section renders collapsed. `defaultCollapsed` comes from
   * the schema (`groups[name].expanded === false`); a stored preference wins
   * over it, and a missing/malformed store means "expanded".
   */
  isSectionCollapsed(sectionName: string, defaultCollapsed = false): boolean {
    const key = inspectorSectionStateKey(this.primaryNode?.type ?? 'unknown', sectionName);
    return this.collapsedSections[key] ?? defaultCollapsed;
  }

  /** Flip a section's collapse state and persist the whole record. */
  toggleSectionCollapsed(sectionName: string, defaultCollapsed = false): void {
    const key = inspectorSectionStateKey(this.primaryNode?.type ?? 'unknown', sectionName);
    const next = {
      ...this.collapsedSections,
      [key]: !this.isSectionCollapsed(sectionName, defaultCollapsed),
    };
    this.collapsedSections = next;
    writeInspectorCollapsedSections(next);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.disposeLocalizationSubscription?.();
    this.disposeLocalizationSubscription = undefined;
    this.disposeScriptSubscription?.();
    this.disposeScriptSubscription = undefined;
    this.stopLiveTimer();
    // Reset live-mirror UI state so a reused Lit instance starts clean even if it
    // was detached mid-play and play stopped while it was disconnected.
    this.isLivePlayMode = false;
    this.disposeAssetPreviewSubscription?.();
    this.disposeAssetPreviewSubscription = undefined;
    this.disposeAnimationEditorSubscription?.();
    this.disposeAnimationEditorSubscription = undefined;
    this.disposeAnimationControllerSubscription?.();
    this.disposeAnimationControllerSubscription = undefined;
    this.removeEventListener('locate-resource', this.onLocateResource as EventListener);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);

    this.resourcePreview.dispose();
  }

  async handleCopyResourceUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      console.error('Failed to copy resource URL:', err);
    }
  }

  private updateSelectedNodes(): void {
    const previousPrimaryNodeId = this.primaryNode?.nodeId ?? null;
    const { nodeIds, primaryNodeId } = appState.selection;
    const activeSceneId = appState.scenes.activeSceneId;

    if (nodeIds.length > 0 && this.selectedAssetItem) {
      this.assetsPreviewService.clearSelectedItem();
    }

    if (!activeSceneId) {
      this.selectedNodes = [];
      this.primaryNode = null;
      this.propertySchema = null;
      return;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      this.selectedNodes = [];
      this.primaryNode = null;
      this.propertySchema = null;
      return;
    }

    // Find selected nodes
    this.selectedNodes = nodeIds
      .map(nodeId => this.findNodeById(nodeId, sceneGraph.rootNodes))
      .filter((node): node is NodeBase => node !== null);

    // Find primary node
    this.primaryNode = primaryNodeId
      ? this.findNodeById(primaryNodeId, sceneGraph.rootNodes)
      : this.selectedNodes.length > 0
        ? this.selectedNodes[0]
        : null;

    const nextPrimaryNodeId = this.primaryNode?.nodeId ?? null;
    if (previousPrimaryNodeId !== nextPrimaryNodeId) {
      this.propertyPreviewStartValues.clear();
      this.componentPropertyPreviewStartValues.clear();
      this.refusedPropertyValues.clear();
      this.refusedComponentValues.clear();
      this.isGroupsEditorOpen = false;
    }

    // Reset animation preview when selection changes
    const newPrimaryId = primaryNodeId ?? nodeIds[0] ?? null;
    if (previousPrimaryNodeId !== newPrimaryId && this.activePreviewAnimation !== null) {
      if (previousPrimaryNodeId) {
        this.viewportService.setPreviewAnimation(previousPrimaryNodeId, null);
      }
      this.activePreviewAnimation = null;
    }

    this.syncValuesFromNode();

    // While playing, immediately mirror the freshly selected node's live runtime
    // values so the panel doesn't flash authored values until the next poll tick.
    if (appState.ui.isPlaying) {
      this.refreshLiveValues();
    }
  }

  private findNodeById(nodeId: string, nodes: NodeBase[]): NodeBase | null {
    for (const node of nodes) {
      if (node.nodeId === nodeId) {
        return node;
      }
      const found = this.findNodeById(nodeId, node.children);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Refresh the cached property/component display values.
   *
   * `valueSource` lets the play-mode live read-out feed values from the running
   * runtime clone while the schema (and everything else) stays bound to the
   * authored `primaryNode`. The clone is the same concrete class, so its schema
   * is identical; only the live `getValue(target)` results differ. When omitted,
   * values come from the authored node (normal edit-mode behaviour).
   */
  syncValuesFromNode(valueSource?: NodeBase): void {
    if (!this.primaryNode) {
      this.propertySchema = null;
      this.propertyValues = {};
      this.componentPropertyValues = {};
      this.propertyPreviewStartValues.clear();
      this.componentPropertyPreviewStartValues.clear();
      this.refusedPropertyValues.clear();
      this.refusedComponentValues.clear();
      this.isGroupsEditorOpen = false;
      return;
    }

    // Get the schema for this node
    this.propertySchema = getNodePropertySchema(this.primaryNode);
    this.newGroupError = null;

    const source = valueSource ?? this.primaryNode;

    // Initialize UI values from node properties
    const values: Record<string, PropertyUIState> = {};
    for (const prop of this.propertySchema.properties) {
      if (prop.ui?.hidden) {
        continue;
      }
      const displayValue = getPropertyDisplayValue(source, prop);
      values[prop.name] = {
        value: displayValue,
        isValid: true,
      };
    }
    for (const [name, refused] of this.refusedPropertyValues) {
      if (values[name]) values[name] = refused;
    }
    this.propertyValues = values;
    this.syncComponentValuesFromNode(valueSource);
  }

  private syncComponentValuesFromNode(valueSource?: NodeBase): void {
    if (!this.primaryNode) {
      this.componentPropertyValues = {};
      return;
    }

    // Render keys off the authored components (what the template iterates), but
    // read live values from the matching runtime-clone component (same index +
    // type) when a live value source is provided.
    const liveComponents = valueSource?.components;
    const values: Record<string, PropertyUIState> = {};
    this.primaryNode.components.forEach((component, index) => {
      const schema = this.scriptRegistry.getComponentPropertySchema(component.type);
      if (!schema) {
        return;
      }
      const liveComponent = liveComponents?.[index];
      const valueComponent =
        liveComponent && liveComponent.type === component.type ? liveComponent : component;
      for (const prop of schema.properties) {
        if (prop.ui?.hidden) {
          continue;
        }
        const key = getComponentPropertyKey(component.id, prop.name);
        values[key] = {
          value: getPropertyDisplayValue(valueComponent, prop),
          isValid: true,
        };
      }
    });
    for (const [key, refused] of this.refusedComponentValues) {
      if (values[key]) values[key] = refused;
    }
    this.componentPropertyValues = values;
  }

  /**
   * Resolve the runtime-clone counterpart of the currently-selected node.
   *
   * Play mode runs an isolated clone in SceneRunner's own THREE.Scene; the
   * scene root's direct children are the runtime NodeBase roots. The clone
   * preserves authored nodeIds, so we match by id. Returns null when not
   * playing, when the runtime scene is gone, or when the node has no 1:1 clone
   * (e.g. nodes nested inside a prefab instance whose ids were remapped).
   */
  private resolveLiveNode(): NodeBase | null {
    const id = this.primaryNode?.nodeId;
    if (!id) {
      return null;
    }
    const root = getRuntimeSceneRoot() as { children?: unknown[] } | null;
    if (!root || !Array.isArray(root.children)) {
      return null;
    }
    for (const child of root.children) {
      if (child instanceof NodeBase) {
        const hit = child.findById(id);
        if (hit) {
          return hit;
        }
      }
    }
    return null;
  }

  /** Re-read live values off the runtime clone and reflect them in the inspector. */
  private refreshLiveValues(): void {
    if (!appState.ui.isPlaying) {
      this.setLivePlayMode(false);
      return;
    }
    const live = this.resolveLiveNode();
    this.setLivePlayMode(live !== null);
    if (live) {
      this.syncValuesFromNode(live);
    }
  }

  /** Toggle the live-mirror UI state, restoring authored values when leaving live mode. */
  private setLivePlayMode(active: boolean): void {
    if (this.isLivePlayMode === active) {
      return;
    }
    this.isLivePlayMode = active;
    if (!active) {
      // Restore the authored node's values now that the live mirror is gone.
      this.syncValuesFromNode();
    }
  }

  private startLiveTimer(): void {
    if (this.liveRefreshTimer !== null) {
      return;
    }
    this.liveRefreshTimer = window.setInterval(
      () => this.refreshLiveValues(),
      LIVE_REFRESH_INTERVAL_MS
    );
    this.refreshLiveValues();
  }

  private stopLiveTimer(): void {
    if (this.liveRefreshTimer !== null) {
      window.clearInterval(this.liveRefreshTimer);
      this.liveRefreshTimer = null;
    }
  }

  private onPlayModeChanged(): void {
    if (appState.ui.isPlaying) {
      this.startLiveTimer();
    } else {
      this.stopLiveTimer();
      this.setLivePlayMode(false);
    }
  }

  onTextureResourceDrop(propertyName: string, event: DragEvent): void {
    const textureUrl = this.resourcePreview.getDroppedTextureResource(event);
    if (!textureUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, { type: 'texture', url: textureUrl });
  }

  onAudioResourceDrop(propertyName: string, event: DragEvent): void {
    const audioUrl = this.resourcePreview.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, audioUrl);
  }

  onModelResourceDrop(propertyName: string, event: DragEvent): void {
    const modelUrl = this.resourcePreview.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, modelUrl);
  }

  /**
   * Rewind the selected Spine skeleton to the first frame of its current
   * animation. Pose-only and deliberately NOT an operation: like the animation
   * timeline's scrub preview this is transient editor state, so it must not enter
   * undo history or dirty the scene.
   */
  onSpinePreviewReset(): void {
    const node = this.primaryNode;
    if (!(node instanceof SpineSkeleton2D)) {
      return;
    }
    node.resetToFirstFrame();
    this.viewportService.resetSpinePreview(node.nodeId);
  }

  onFileResourceDrop(propertyName: string, event: DragEvent, extensions: string[]): void {
    const fileUrl = this.resourcePreview.getDroppedFileResource(event, extensions);
    if (!fileUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, fileUrl);
  }

  onAnimationResourceDrop(propertyName: string, event: DragEvent): void {
    const animationUrl = this.resourcePreview.getDroppedAnimationResource(event);
    if (!animationUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, animationUrl);
  }

  /** Double-clicking a texture property previews that image full-screen. */
  onOpenTextureResource(resourcePath: string): void {
    const trimmedResourcePath = resourcePath.trim();
    if (!trimmedResourcePath || !HostService.isInstalled()) {
      return;
    }

    const url = this.hostService.host.files.url(this.hostService.wirePath(trimmedResourcePath));
    const title = trimmedResourcePath.split('/').pop() ?? trimmedResourcePath;
    this.lightbox.open([{ kind: 'image', title, url, path: trimmedResourcePath }]);
  }

  onComponentAudioResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const audioUrl = this.resourcePreview.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, audioUrl);
  }

  onComponentModelResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const modelUrl = this.resourcePreview.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, modelUrl);
  }

  async handlePropertyInput(propName: string, e: Event) {
    const input = e.target as HTMLInputElement;
    const rawValue = input.value;

    const propDef = this.propertySchema?.properties.find(p => p.name === propName);
    const expectsNumber = propDef?.type === 'number' || input.type === 'number';

    const numericValue = parseFloat(rawValue);
    const parsedValue: unknown = expectsNumber ? numericValue : rawValue;
    // Emoji-only text is refused here, before it reaches the scene (`E_EMOJI_AS_ART`).
    const error = expectsNumber ? null : emojiAsArtFieldError(propName, rawValue);
    const isValid = expectsNumber ? !isNaN(numericValue) : error === null;

    // Update local state
    const next: PropertyUIState = { value: rawValue, isValid, ...(error ? { error } : {}) };
    if (error) this.refusedPropertyValues.set(propName, next);
    else this.refusedPropertyValues.delete(propName);
    this.propertyValues = { ...this.propertyValues, [propName]: next };

    if (isValid) {
      await this.previewPropertyChange(propName, parsedValue);
    }
  }

  async handlePropertyBlur(propName: string, e: Event) {
    const input = e.target as HTMLInputElement;
    let value = input.value;

    // For number inputs, format the value
    if (input.type === 'number') {
      let num = parseFloat(value);
      if (isNaN(num)) num = 0;
      value = parseFloat(num.toFixed(4)).toString();
    }

    const error = input.type === 'number' ? null : emojiAsArtFieldError(propName, value);
    if (error) {
      // Refused: nothing is written, and a preview of an earlier keystroke is taken back.
      const refused: PropertyUIState = { value, isValid: false, error };
      this.refusedPropertyValues.set(propName, refused);
      this.propertyValues = { ...this.propertyValues, [propName]: refused };
      await this.revertPropertyPreview(propName);
      return;
    }
    this.refusedPropertyValues.delete(propName);

    // Update local state
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value, isValid: true },
    };

    await this.commitPropertyChange(propName, value);
  }

  /** Put back the value a preview started from, without a history entry. */
  private async revertPropertyPreview(propertyName: string): Promise<void> {
    if (!this.propertyPreviewStartValues.has(propertyName)) return;
    const start = this.propertyPreviewStartValues.get(propertyName);
    await this.previewPropertyChange(propertyName, start);
    this.propertyPreviewStartValues.delete(propertyName);
  }

  private normalizeColorValue(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hexMatch) {
      return null;
    }

    const hex = hexMatch[1];
    if (hex.length === 3) {
      return `#${hex
        .split('')
        .map(char => `${char}${char}`)
        .join('')}`;
    }

    return `#${hex}`;
  }

  getColorPickerValue(rawValue: string): string {
    return this.normalizeColorValue(rawValue) ?? '#ffffff';
  }

  async handleColorPickerInput(propName: string, nextColor: string): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: normalized, isValid: true },
    };

    await this.previewPropertyChange(propName, normalized);
  }

  async handleColorPickerCommit(propName: string, nextColor: string): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: normalized, isValid: true },
    };

    await this.commitPropertyChange(propName, normalized);
  }

  async handleSliderPreview(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.previewPropertyChange(propName, nextValue);
  }

  async handleSliderCommit(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.commitPropertyChange(propName, nextValue);
  }

  async previewPropertyChange(propertyName: string, value: unknown): Promise<void> {
    if (!this.primaryNode || !this.propertySchema) {
      return;
    }

    const propDef = this.propertySchema.properties.find(p => p.name === propertyName);
    if (!propDef) {
      return;
    }

    if (!this.propertyPreviewStartValues.has(propertyName)) {
      this.propertyPreviewStartValues.set(propertyName, propDef.getValue(this.primaryNode));
    }

    const command = new UpdateObjectPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      propertyPath: propertyName,
      value,
      historyMode: 'preview',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to preview property', propertyName, error);
      const displayValue = getPropertyDisplayValue(this.primaryNode, propDef);
      this.propertyValues = {
        ...this.propertyValues,
        [propertyName]: { value: displayValue, isValid: true },
      };
      this.propertyPreviewStartValues.delete(propertyName);
    }
  }

  async commitPropertyChange(propertyName: string, value: unknown): Promise<void> {
    if (!this.primaryNode || !this.propertySchema) {
      return;
    }

    const hasPreviousValueOverride = this.propertyPreviewStartValues.has(propertyName);
    const previousValue = this.propertyPreviewStartValues.get(propertyName);
    this.propertyPreviewStartValues.delete(propertyName);

    await this.applyPropertyChange(propertyName, value, previousValue, hasPreviousValueOverride);
  }

  async applyPropertyChange(
    propertyName: string,
    value: unknown,
    previousValue?: unknown,
    hasPreviousValueOverride: boolean = false
  ) {
    if (!this.primaryNode || !this.propertySchema) return;

    // Find the property definition
    const propDef = this.propertySchema.properties.find(p => p.name === propertyName);
    if (!propDef) return;

    const command = new UpdateObjectPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      propertyPath: propertyName,
      value,
      ...(hasPreviousValueOverride ? { previousValue } : {}),
      historyMode: 'commit',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update property', propertyName, error);
      // Revert UI state on error
      const displayValue = getPropertyDisplayValue(this.primaryNode, propDef);
      this.propertyValues = {
        ...this.propertyValues,
        [propertyName]: { value: displayValue, isValid: true },
      };
    }
  }

  async applySpriteSizeChange(
    width: number,
    height: number,
    aspectRatioLocked?: boolean
  ): Promise<void> {
    if (!(this.primaryNode instanceof Sprite2D)) {
      return;
    }

    const command = new UpdateSprite2DSizeCommand({
      nodeId: this.primaryNode.nodeId,
      width,
      height,
      aspectRatioLocked,
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update Sprite2D size', error);
      this.syncValuesFromNode();
      this.requestUpdate();
    }
  }

  async handleComponentPropertyInput(componentId: string, prop: PropertyDefinition, e: Event) {
    const input = e.target as HTMLInputElement;
    const rawValue = input.value;
    const key = getComponentPropertyKey(componentId, prop.name);

    const expectsNumber = prop.type === 'number' || input.type === 'number';
    const numericValue = parseFloat(rawValue);
    const parsedValue: unknown = expectsNumber ? numericValue : rawValue;
    const error = expectsNumber ? null : emojiAsArtFieldError(prop.name, rawValue);
    const isValid = expectsNumber ? !Number.isNaN(numericValue) : error === null;

    const next: PropertyUIState = { value: rawValue, isValid, ...(error ? { error } : {}) };
    if (error) this.refusedComponentValues.set(key, next);
    else this.refusedComponentValues.delete(key);
    this.componentPropertyValues = { ...this.componentPropertyValues, [key]: next };

    if (isValid) {
      await this.previewComponentPropertyChange(componentId, prop, parsedValue);
    }
  }

  async handleComponentPropertyBlur(componentId: string, prop: PropertyDefinition, e: Event) {
    const input = e.target as HTMLInputElement;
    let value = input.value;
    const key = getComponentPropertyKey(componentId, prop.name);

    if (input.type === 'number') {
      let num = parseFloat(value);
      if (Number.isNaN(num)) num = 0;
      value = parseFloat(num.toFixed(4)).toString();
    }

    const error = input.type === 'number' ? null : emojiAsArtFieldError(prop.name, value);
    if (error) {
      const refused: PropertyUIState = { value, isValid: false, error };
      this.refusedComponentValues.set(key, refused);
      this.componentPropertyValues = { ...this.componentPropertyValues, [key]: refused };
      if (this.componentPropertyPreviewStartValues.has(key)) {
        const start = this.componentPropertyPreviewStartValues.get(key);
        await this.previewComponentPropertyChange(componentId, prop, start);
        this.componentPropertyPreviewStartValues.delete(key);
      }
      return;
    }
    this.refusedComponentValues.delete(key);

    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value, isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, prop, value);
  }

  async previewComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    if (!this.primaryNode) return;

    const component = this.primaryNode.components.find(c => c.id === componentId);
    if (!component) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    if (!this.componentPropertyPreviewStartValues.has(key)) {
      this.componentPropertyPreviewStartValues.set(key, propDef.getValue(component));
    }

    const command = new UpdateComponentPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
      propertyName: propDef.name,
      value,
      historyMode: 'preview',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to preview component property', propDef.name, error);
      this.componentPropertyValues = {
        ...this.componentPropertyValues,
        [key]: {
          value: getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
      this.componentPropertyPreviewStartValues.delete(key);
    }
  }

  // --- collision polygon (`editor: 'collision-polygon'`) -------------------

  /** True while this component's polygon is the one open in the viewport tool. */
  isPolygonEditing(componentId: string): boolean {
    const target = appState.ui.polygonEditing;
    return (
      target?.componentId === componentId && target?.nodeId === (this.primaryNode?.nodeId ?? '')
    );
  }

  /** Node ids whose polygon trace is running, so the button can say so. */
  @state()
  tracingPolygonComponentIds: string[] = [];

  onPolygonEditToggle(componentId: string, editing: boolean): void {
    const nodeId = this.primaryNode?.nodeId;
    if (!nodeId) {
      return;
    }
    this.polygonEditor.setTarget(editing ? { nodeId, componentId } : null);
    this.requestUpdate();
  }

  /** Replace the polygon with a box matching the node's own size. */
  async onPolygonResetBox(componentId: string, prop: PropertyDefinition): Promise<void> {
    const node = this.primaryNode;
    if (!node) {
      return;
    }
    const width = Number((node as unknown as { width?: number }).width) || 64;
    const height = Number((node as unknown as { height?: number }).height) || 64;
    await this.applyComponentPropertyChange(
      componentId,
      prop,
      serializePolygonConfig(boxPolygon(width / 2, height / 2))
    );
  }

  async onPolygonClear(componentId: string, prop: PropertyDefinition): Promise<void> {
    await this.applyComponentPropertyChange(componentId, prop, []);
  }

  /** The texture a polygon trace would read, or null when this node has none. */
  getPolygonTraceTexturePath(): string | null {
    const texture = (this.primaryNode as unknown as { texture?: { url?: unknown } } | null)
      ?.texture;
    const url = typeof texture?.url === 'string' ? texture.url.trim() : '';
    return url.length > 0 ? url : null;
  }

  /**
   * Trace an outline from the node's own texture alpha and write it into the
   * polygon — the same marching-squares + Ramer-Douglas-Peucker pipeline the
   * Sprite Editor uses on animation frames, reused here for a static sprite.
   */
  async onPolygonTrace(componentId: string, prop: PropertyDefinition): Promise<void> {
    const node = this.primaryNode;
    const texturePath = this.getPolygonTraceTexturePath();
    if (!node || !texturePath || this.tracingPolygonComponentIds.includes(componentId)) {
      return;
    }

    this.tracingPolygonComponentIds = [...this.tracingPolygonComponentIds, componentId];
    try {
      const blob = await this.projectStorage.readBlob(
        texturePath.startsWith('res://') ? texturePath.substring(6) : texturePath
      );
      const mask = await readAlphaMask(blob);
      if (!mask) {
        return;
      }
      const traced = traceCollisionPolygon(mask);
      if (traced.length < 3) {
        return;
      }

      const anchor = (node as unknown as { anchor?: { x?: number; y?: number } }).anchor;
      const local = mapImagePolygonToSpriteLocal(
        traced,
        { width: mask.width, height: mask.height },
        {
          width: Number((node as unknown as { width?: number }).width) || mask.width,
          height: Number((node as unknown as { height?: number }).height) || mask.height,
          anchorX: Number(anchor?.x ?? 0.5),
          anchorY: Number(anchor?.y ?? 0.5),
        }
      );
      if (local.length < 3) {
        return;
      }
      await this.applyComponentPropertyChange(componentId, prop, serializePolygonConfig(local));
    } finally {
      this.tracingPolygonComponentIds = this.tracingPolygonComponentIds.filter(
        id => id !== componentId
      );
    }
  }

  async commitComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    const hasPreviousValueOverride = this.componentPropertyPreviewStartValues.has(key);
    const previousValue = this.componentPropertyPreviewStartValues.get(key);
    this.componentPropertyPreviewStartValues.delete(key);

    await this.applyComponentPropertyChange(
      componentId,
      propDef,
      value,
      previousValue,
      hasPreviousValueOverride
    );
  }

  async handleComponentSliderPreview(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, nextValue);
  }

  async handleComponentSliderCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, nextValue);
  }

  async handleComponentColorPickerInput(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, normalized);
  }

  async handleComponentColorPickerCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, normalized);
  }

  async applyComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown,
    previousValue?: unknown,
    hasPreviousValueOverride: boolean = false
  ): Promise<void> {
    if (!this.primaryNode) return;

    const command = new UpdateComponentPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
      propertyName: propDef.name,
      value,
      ...(hasPreviousValueOverride ? { previousValue } : {}),
      historyMode: 'commit',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update component property', propDef.name, error);
      const component = this.primaryNode.components.find(c => c.id === componentId);
      if (!component) {
        return;
      }
      const key = getComponentPropertyKey(componentId, propDef.name);
      this.componentPropertyValues = {
        ...this.componentPropertyValues,
        [key]: {
          value: getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
    }
  }

  /**
   * Bring the Animation Inspector's clip/frame section into view when the *editor*
   * moves the selection (timeline scrub, clips rail, canvas). Keyed on the
   * clip name + frame index only, so editing a value in the Inspector never
   * scrolls; `block: 'nearest'` makes it a no-op when the section is already
   * visible.
   */
  protected updated(): void {
    const state = this.activeAnimationState;
    const key = state ? `${state.activeClipName}#${state.selectedFrameIndex}` : null;
    if (key === this.lastAnimationSelectionKey) {
      return;
    }

    const clipChanged = state?.activeClipName !== this.lastAnimationClipName;
    this.lastAnimationSelectionKey = key;
    this.lastAnimationClipName = state?.activeClipName;

    if (!state) {
      return;
    }

    const target =
      this.querySelector<HTMLElement>('.animation-frame-indicator') ??
      (clipChanged ? this.querySelector<HTMLElement>('.animation-clip-button.is-selected') : null);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  protected render() {
    const hasSelection = this.selectedNodes.length > 0;
    const hasAnimationSelection = this.activeAnimationState !== null;
    const hasAssetSelection = this.selectedAssetItem !== null && !hasAnimationSelection;

    return html`
      <pix3-panel
        panel-role="form"
        panel-description="Adjust properties for the currently selected node."
        actions-label="Inspector actions"
      >
        <div class="inspector-body ${this.isPlaying ? 'is-play-mode' : ''}">
          ${hasAnimationSelection
            ? this.sectionRenderers.renderAnimationProperties()
            : hasAssetSelection
              ? this.sectionRenderers.renderAssetProperties()
              : hasSelection
                ? this.propertyRenderers.renderProperties()
                : ''}
        </div>
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-inspector-panel': InspectorPanel;
  }
}
