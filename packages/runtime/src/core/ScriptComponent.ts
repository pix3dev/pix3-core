/**
 * Script Component System
 *
 * Defines the core interfaces for the unified script component system.
 * This system follows the PropertySchema pattern for dynamic parameter configuration.
 */

import type { InteractionDescriptor } from '../fw/interactive';
import type { PropertySchema } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import type { AssetLoader } from './AssetLoader';
import type { SceneService } from './SceneService';
import type { TextureRegion } from './texture-region';
import { disconnectSignalTargetEverywhere } from './signal-target-links';

/**
 * Declarative, editor-only appearance override a script can push each preview
 * frame to change how its node draws in the editor viewport — without entering
 * play mode. Pure data (no Three.js / editor types) so it stays runtime-safe.
 * Immediate-mode: whatever a component passes to
 * {@link EditorPreviewContext.setAppearanceOverride} applies for that frame; if
 * it stops pushing, the proxy reverts to the node's document state.
 */
export interface EditorAppearanceOverride {
  /** Crop the previewed texture to a UV sub-rect (Sprite2D proxies in v1). */
  textureRegion?: TextureRegion;
  /** Multiply-tint the proxy material (CSS color string, e.g. '#ff8800'). */
  tint?: string;
  /** Show/hide the proxy without touching the node's own `visible`. */
  visible?: boolean;
}

export interface EditorPreviewContext {
  assetLoader: AssetLoader;
  requestRender: () => void;
  /**
   * Declare how this component's node should look in the editor viewport for the
   * current preview frame. Immediate-mode: not calling it again on the next tick
   * reverts the proxy to the node's document state. Never mutates the node and is
   * never serialized — it is transient presentation state, not document state.
   */
  setAppearanceOverride(override: EditorAppearanceOverride): void;
}

/**
 * Type helper for constructors
 */
export type Constructor<T> = new (...args: unknown[]) => T;

/**
 * ScriptComponent - Unified interface for all script components.
 * Replaces the previous dual system of behaviors and controllers.
 * All scripts implement this interface with lifecycle methods and configuration.
 */
export interface ScriptComponent {
  /** Unique identifier for this component instance */
  readonly id: string;

  /** Type name of this component (matches registry key) */
  readonly type: string;

  /** Reference to the node this component is attached to */
  node: NodeBase | null;

  /** Whether this component is currently active and receiving updates */
  enabled: boolean;

  /** Configuration object for this component's parameters */
  config: Record<string, unknown>;

  /** Flag to track if onStart has been called */
  _started: boolean;

  /**
   * Called when the script component is attached to a node.
   * Use this to initialize references and set up state.
   */
  onAttach?(node: NodeBase): void;

  /**
   * Called on the first frame after attachment, before the first onUpdate.
   * Use this to perform initialization that depends on the scene being fully loaded.
   */
  onStart?(): void;

  /**
   * Called once, at the end of the frame in which {@link onStart} ran — after EVERY component that
   * started that frame has run its `onStart`. Parents start before their children, so a script on
   * the scene root that drives its children (`board.newBoard()`) belongs here, not in `onStart`.
   * The component's own first `onUpdate` has already run by then.
   */
  onReady?(): void;

  /**
   * Called every frame with the delta time in seconds.
   * Use this to update state and animate properties.
   */
  onUpdate?(dt: number): void;

  /**
   * Called by the editor viewport render loop when a component wants to show
   * editor-only preview state without entering play mode.
   */
  tickEditorPreview?(dt: number, context: EditorPreviewContext): void;

  /**
   * Called when the script component is detached from a node or the scene is unloaded.
   * Use this to clean up resources and remove event listeners.
   */
  onDetach?(): void;

  /**
   * Reset the started state (internal use only).
   * Called when detaching to allow re-initialization on next attach.
   */
  resetStartedState?(): void;

  /**
   * The semantic interactions this component offers on its node — the third source of
   * interactions, after the engine controls and the game-level debug provider. Declaring them is
   * what makes a clickable game object that is NOT a `UIControl2D` (a tappable enemy, a card, a
   * hotspot) addressable by name: a test bot on the direct-action channel finds and invokes it.
   *
   * Both members are optional and the pair is the whole contract ({@link Interactive}), so a
   * component opts in by simply implementing them — nothing to register, nothing to import.
   *
   * The rule the engine controls follow applies here too, and it is the only thing that keeps this
   * layer honest: **do not emit the signal or assign the field the gesture would have changed**.
   * Route the invocation through whatever path a real pointer/tick drives (the node's own handler,
   * the component's state machine), so a broken path fails the invocation instead of a shortcut
   * reporting success on a game that no player could operate.
   */
  getInteractions?(): InteractionDescriptor[];

  /**
   * Perform one of {@link getInteractions}. Return `false` — never throw — for an unknown name, a
   * missing/unusable argument, or a refusal (the component is disabled, the game state forbids it).
   * `true` means it was delivered, not that the game reacted.
   */
  invokeInteraction?(name: string, args?: Record<string, unknown>): boolean;

  /**
   * Access to the Input System.
   * Injected by the SceneRunner or runtime environment.
   */
  input?: import('./InputService').InputService;

  /**
   * Access to the Scene Service (camera control, screen fades, etc.).
   * Injected by the SceneRunner or runtime environment.
   */
  scene?: SceneService;
}

/**
 * Abstract base class for script components providing default implementations.
 * Extend this class to create custom script components.
 */
export abstract class Script implements ScriptComponent {
  readonly id: string;
  readonly type: string;
  node: NodeBase | null = null;
  enabled: boolean = true;
  config: Record<string, unknown> = {};
  _started: boolean = false;
  input?: import('./InputService').InputService;
  scene?: SceneService;

  constructor(id: string, type: string) {
    this.id = id;
    this.type = type;
  }

  /**
   * Get the property schema for this component's parameters.
   * Override this method to define editable parameters.
   */
  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Script',
      properties: [],
      groups: {},
    };
  }

  /**
   * Resolve another node in the scene by id, name, or slash-separated path of
   * names. This is the unified addressing entry point for scripts — prefer it
   * over walking `this.node` manually. When no scene service is available
   * (e.g. some editor previews) it falls back to searching from the owning
   * node's root.
   */
  protected findNode(query: string): NodeBase | null {
    if (this.scene) {
      return this.scene.findNode(query);
    }
    let root = this.node;
    while (root?.parentNode) {
      root = root.parentNode;
    }
    return root?.findNode(query) ?? null;
  }

  /**
   * Resolve another node by id, name, or slash-separated path and return it,
   * throwing if it does not exist. This is the non-null counterpart to
   * {@link findNode} (Godot's `get_node` vs `get_node_or_null`). `T` narrows
   * the result type (unchecked).
   */
  protected getNode<T extends NodeBase = NodeBase>(query: string): T {
    const node = this.findNode(query);
    if (!node) {
      throw new Error(`[${this.type}] getNode("${query}"): node not found in scene`);
    }
    return node as T;
  }

  onAttach?(node: NodeBase): void;
  onStart?(): void;
  onReady?(): void;
  onUpdate?(dt: number): void;
  tickEditorPreview?(dt: number, context: EditorPreviewContext): void;
  /**
   * Base detach: disconnects every signal handler this script connected with itself
   * as the target — on its own node AND on any other node
   * (`otherNode.connect('signal', this, fn)`). Overrides should call
   * `super.onDetach()`; `NodeBase.removeComponent` and `dispose` repeat the
   * disconnect as a safety net. Window listeners, store subscriptions and timers are
   * still the script's own to clean up.
   */
  onDetach(): void {
    disconnectSignalTargetEverywhere(this);
  }

  /**
   * Reset the started state
   */
  resetStartedState(): void {
    this._started = false;
  }
}

/**
 * Type guard to check if an object is a ScriptComponent
 */
export function isScriptComponent(obj: unknown): obj is ScriptComponent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'type' in obj &&
    'enabled' in obj &&
    'config' in obj
  );
}
