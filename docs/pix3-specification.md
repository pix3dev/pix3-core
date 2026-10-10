# Pix3 — Technical Specification

Version: 2.2

Date: 2026-10-11

> **Reading this doc economically (agents):** it is long — don't load the whole
> file. `Grep` the heading *text* below, then `Read` with `offset`/`limit`.
> **Reference sections by heading text, not by number** — the numbers are
> historically inconsistent (`§8` precedes `§6`; the systems appended under
> `6.15`–`6.23` are top-level, not children of Script Component System).

## Contents (document order — grep the heading text)

- Introduction · Key Features · Technology Stack · Architecture
- Property Schema System · Script Component System
- Group2D Sizing (Fit to Contents, Proportional Resize) · Project Templates, Target Platform and Agent Kit
- Autoload Scripts and Asset Browser Template Flow · Signals Engine · Groups Engine · Editor Peek (View Mask)
- Node Prefabs System · Keyframe Animation System · Localization (i18n) · AI Image Generation
- Scene File Format (\*.pix3scene) · Non-Functional Requirements
- Project Structure · Roadmap and Milestones · Change Log

## 1. Introduction

### 1.1 Purpose of the Document

This document describes the technical requirements, architecture, and development plan for the web application Pix3 — a modern editor for creating HTML5 games that combines 2D and 3D capabilities.

### 1.2 Product Overview

Pix3 is a browser-based editor, similar to Figma and Unity, for rapid and iterative development of game scenes. In 2.x a game is a plain Vite + TypeScript project: `@pix3/vite-plugin` serves the editor (`@pix3/editor-core`) at `/__pix3/` on the game's own dev server and builds the playable on `vite build`; the engine is `@pix3/runtime`, the CLI `@pix3/cli`, and a new project comes from `npm create pix3`. Code, files and project settings belong to the IDE or the coding agent; the editor edits the scenes of the project that is already open and follows the disk.

### 1.3 Target Audience

Pix3 targets professional and indie teams who already create playable ads and interactive experiences with WebGL engines:

- **Playable ad creators** migrating from PixiJS and Three.js pipelines who need scene tooling and rapid iteration.
- **Construct 3 and Godot users** looking for a browser-first workflow with minimal install friction.
- **Cocos and custom engine developers** who want to assemble UI overlays and scene flow visually before exporting to code.

Success metrics:

- Create a new playable ad scene from template to export in under 30 minutes on mid-tier hardware.
- Maintain ≥ 85% editor FPS on a 3-layer (UI + 3D + particle) scene in Chromium browsers on 2023+ laptops.
- Support 90% of user actions via keyboard shortcuts or palette commands within MVP.

### 1.4 Document Scope and Change Management

This specification covers Pix3 2.x as built: the engine, the scene format and the editor. Changes are tracked in the changelog at the end of the document; the as-built records of the 2.x work are in `.plans/`.

## 2. Key Features

- Hybrid 2D/3D Scene: The editor does not have a rigid separation between 2D and 3D modes. Instead, it uses a layer system, allowing 2D interfaces to be overlaid on top of 3D scenes — ideal for creating game UIs.
- Godot-style Scene Structure: The scene architecture is based on a hierarchy of "nodes." Each node represents an object (a sprite, a 3D model, a light source). Nodes can be saved into separate scene files (\*.pix3scene) and reused (instanced) within other scenes.
- **Editor on the game's dev server.** `pix3()` in `vite.config.ts` serves the editor at `/__pix3/` with a file API (`/__pix3/api/*`: sha256 `ETag`, `If-Match` → 412, changesets, a version journal in `.pix3/history/`) and pushes every change on disk to the tab as `pix3:fs` frames, so an edit made in the IDE or by an agent reaches the open editor without a reload. One tab writes (Web Lock + the plugin's writer claim, `WriterService`); another is read-only with **Take over**. `packages/vite-plugin/README.md`; port record `.plans/editor-core-port.md`.
- **Files are the truth.** The editor keeps the bytes it last read of each scene as its baseline and writes only the keys it changed (`FlushService` → `ScenePatchWriter`): on Save (Mod+S), 1.5 s after the last edit (at most 10 s under continuous work) and before play, a build, `pix3 check`, `pix3 smoke` or an agent's sync. An external change to an open scene is merged key by key (`SceneMergeService`), unflushed edits survive a dead dev server as an IndexedDB draft (`SceneDraftService`), and the History panel restores a journaled version. Locale tables follow the same rules. Record: `.plans/write-model.md`.
- **No file or project management in the editor.** It never creates, renames, moves or deletes a file, never edits `pix3project.yaml` and never builds; the coding agent or the IDE does, with the kit's recipes (`pix3-scene-format/project-files.md`; coverage audit in `.plans/kit.md` K8). It writes files only through scene/locale edits, the asset panel's Import… and OS-file drops, and the Generate panel's Save to project.
- **Coding agents drive the open tab** through Chrome DevTools MCP: the page registers the `pix3` tool group (`pix3_status`, `pix3_sync`, `pix3_scene`, `pix3_play`, `pix3_game_run`, `pix3_screenshot`, `pix3_errors`; table `packages/editor-core/src/host/bridge-tools.ts`), with `window.__PIX3_DEBUG__.call` as the inline fallback. `pix3 editor` starts the dev server and a Chrome behind a token-checked CDP proxy; `pix3 agent-setup` writes the agent's MCP configuration. There is no Pix3 MCP server and no in-editor agent. Record: `.plans/agent-bridge.md`; commands `packages/cli/README.md`.
- **Agent keepalive.** A hidden or unfocused tab pauses its play and viewport loops to save battery, except while an agent works — a bridge call in flight or finished less than 60 s ago, or play an agent started (`AgentKeepaliveService`); a hidden tab then ticks from `BackgroundTicker`'s worker. Setting: Editor Settings → **Keep the editor running while an agent is connected** (`appState.ui.keepEditorRunningForAgent`, default on).
- **Scripts through Vite.** Project scripts and bot policies reach the editor as Vite modules (`virtual:pix3/editor-scripts`, `virtual:pix3/bot-policies`) and register as `user:<Export>`; the editor compiles nothing and has no code editor, and the sync barrier proves the tab runs what is on disk. Record: `.plans/scripts-vite.md`.
- **Playable build.** `npm run build` (`vite build`) writes one self-contained `dist/index.html` (or a zip) and `dist/<name>.report.json`; the editor has no build or export UI. Record: `.plans/player-build.md`.
- Multi-tab Interface: Users can open and edit multiple scenes in different tabs simultaneously, simplifying work on complex projects.
- Drag-and-Drop Assets: Project resources (images, models) can be dragged directly from the editor's asset panel into the scene viewport to create nodes.
- Customizable Interface: The user can move and dock editor panels to different areas of the window, similar to VS Code, and save their layout between sessions.

## 3. Technology Stack

| Category | Technology | Justification |
| :--- | :--- | :--- |
| UI Components | Lit + `fw` utilities | A lightweight library for creating fast, native, and encapsulated web components. Uses the project `fw` helpers (`ComponentBase`, `inject`, and related exports) as the default building blocks instead of raw `LitElement` to simplify behavior (light vs. shadow DOM), dependency injection, and consistency across the codebase. |
| State Management | Valtio | An ultra-lightweight, high-performance state manager based on proxies. Ensures reactivity and is simple to use. |
| Rendering (3D) | Three.js | Modern WebGL renderer for 3D content. |
| Panel Layout | Golden Layout | A ready-made solution for creating complex, customizable, and persistent panel layouts. |
| Language | TypeScript | Strong typing to increase reliability, improve autocompletion, and simplify collaboration with AI agents. |
| Build Tool | Vite | The game's own dev server and build; `@pix3/vite-plugin` serves the editor on it and builds the playable. |
| File System | `@pix3/vite-plugin` file API | The editor reads and writes the project through the dev server (`/__pix3/api/*`, behind `EditorHost`), so the project may live on another machine (Remote SSH, `.plans/agent-bridge.md`). |

### 3.1 Target Platforms

- **Browsers:** Chromium-based desktop browsers (Chrome, Edge, Arc, Brave) latest two stable versions.
- **Operating Systems:** Windows 11+, macOS 13+, Ubuntu 22.04+ (via Chromium).
- **Hardware Baseline:** Integrated GPU (Intel Iris Xe / AMD Vega) with WebGL2 support, 8 GB RAM, 4-core CPU.

Non-Chromium browsers (Firefox, Safari) are out of scope for MVP but should degrade gracefully by displaying a compatibility banner.

## 4. Architecture

The application is built on the principles of unidirectional data flow and clear separation of concerns.

- **State**: A centralized Valtio proxy (`appState`), serving as the single source of truth for UI, scenes metadata, and selection. It is passive and contains no business logic.
- **Nodes**: Scene nodes (inheriting from Three.js Object3D) are managed by `SceneManager` in `SceneGraph` objects. **Nodes are not stored in reactive state** — only node IDs are tracked in state for selection and hierarchy reference. This separation reduces reactivity overhead and keeps node mutations fast.
- **Operations**: First-class objects encapsulating business logic and state mutations. The `OperationService` is the gateway for executing operations, but all actions must be initiated via **Commands** through the `CommandDispatcher` Service.
- **Commands**: Thin wrappers that validate context (`preconditions()`) and invoke operations via `OperationService`. Commands are registered and discovered via metadata for the command palette. Commands never implement their own undo/redo.
- **CommandDispatcher**: Primary entry point for all user actions. Ensures consistent lifecycle management, preconditions checking, and telemetry for all commands.
- **Command Metadata**: Commands declare menu integration via metadata properties: `menuPath` (menu section), `shortcut` (display), and `addToMenu` (inclusion flag). Menu is generated from registered commands, not hardcoded.
- **Core Managers**: Classes that orchestrate the main aspects of the editor (HistoryManager, SceneManager, LayoutManager). They manage their respective domains and emit events.
- **Services**: Infrastructure layer for interacting with the outside world (`ProjectStorageService` — project files through the `EditorHost` file API; `ExternalChangeService` — changes on disk from `pix3:fs` frames; `FlushService`, `ViewportRenderService`, `DialogService`, `LoggingService`). They implement `dispose()` and are registered with DI.
- **UI Components**: "Dumb" components extending `ComponentBase` from `src/fw`. They subscribe to state changes, render based on snapshots, and dispatch commands via CommandDispatcher rather than mutating state directly.
- **Property Schema System**: Godot-inspired declarative property metadata system for dynamic inspector UI generation. Node classes expose editable properties via `static getPropertySchema()`, enabling automatic editor creation.

### Recommended component pattern

Use the `fw` utilities exported from `src/fw` when creating UI components. Example:

```typescript
import { customElement, html, ComponentBase, inject } from '@/fw';

@customElement('my-inspector')
export class MyInspector extends ComponentBase {
  @inject()
  dataService!: DataService; // resolved from fw/di container

  render() {
    return html`<div class="inspector"><h3>Inspector</h3></div>`;
  }
}
```

Notes:

- `ComponentBase` defaults to light DOM but allows opting into shadow DOM via a static `useShadowDom` flag.
- The `inject` decorator automatically resolves services registered with the `fw/di` container. Services can be registered using the `@injectable()` helper in `fw/di`. Ensure `emitDecoratorMetadata` and `reflect-metadata` are enabled within the build configuration.

### UI Portals and Floating Elements

Floating UI elements such as dropdowns, context menus, and tooltips must use the **portal pattern** via `DropdownPortal` or a similar utility. Rendering these elements inline inside a panel's DOM tree is discouraged because:

1. Panels often use `overflow: hidden` or `overflow: auto`, which clips any child element that extends beyond the panel's boundaries.
2. Portals allow rendering the element at the `document.body` level with `position: fixed`, ensuring it appears on top of all other panels and UI layers.
3. The `DropdownPortal` utility automatically handles viewport collision detection, ensuring the menu stays within the visible area.

When implementing a context menu or dropdown, use `DropdownPortal` (`packages/editor-core/src/ui/shared/dropdown-portal.ts`).

### 4.1 Core Architecture Contracts

- **Operation Lifecycle (source of truth):** An operation implements `perform(context)` and returns an `OperationCommit` object containing closures for `undo()`/`redo()` and metadata for coalescing. OperationService executes operations, pushes commits to history when requested, emits telemetry, and is solely responsible for undo/redo.
- **Command Lifecycle (thin wrappers):** `preconditions()` → `execute()`; commands delegate to OperationService to invoke operations and never implement their own undo/redo. They remain idempotent and emit telemetry via OperationService.
- **SceneGraph & Node Lifecycle:** `SceneManager` owns a `SceneGraph` per loaded scene. Each `SceneGraph` contains a `nodeMap` (for fast lookup) and `rootNodes` array. Nodes extend Three.js `Object3D` and are **not stored in Valtio state**. State only maintains node IDs for selection and hierarchy reference via `SceneHierarchyState.rootNodes`.
- **HistoryManager Contract:** Maintains a bounded stack of command snapshots and exposes `canUndo`/`canRedo` signals to the UI.
- **Service Layer:** Services implement `dispose()` and must be registered via DI. Singleton services load lazily on first injection.
- **CommandDispatcher Contract:** Executes all commands; invokes preconditions, executes, and handles telemetry. All user actions route through CommandDispatcher.
- **Property Schema Contract:** Node classes implement `static getPropertySchema(): PropertySchema` returning an object with `properties` array, `nodeType`, and optional `groups`. The Inspector uses `getNodePropertySchema()` to retrieve and render properties dynamically. Each property includes `getValue`/`setValue` closures for node interaction.

### 4.2 Glossary

- **Node:** Atomic element in the scene graph representing an entity (sprite, mesh, light).
- **Scene:** YAML document describing root node hierarchy and references.
- **Instance:** Inclusion of another scene file inside the active scene with optional overrides.
- **Preset:** Saved layout configuration.
- **Command:** Unit of business logic that mutates the state and can be undone/redone.
- **Property Schema:** Declarative metadata describing editable properties of a node type, used for dynamic inspector UI generation.

### 4.3 Operations-first Pipeline

- **OperationService:** Central orchestrator for operations. Methods: `invoke(op)`, `invokeAndPush(op)` (also record history), `undo()`, `redo()`. Maintains bounded stacks (default 100 items), clears redo on new pushes, supports coalescing, and emits typed events for UI updates and telemetry.
- **Operation Contract:** `perform()` returns an `OperationCommit` with `undo`/`redo` closures. Optionally includes metadata like affected node IDs and structure flags for efficient scene diffing.
- **Bulk operations:** Tools can compose granular operations into one undo step via a helper that produces a single coalesced commit.
- **CommandDispatcher:** Primary entry point for all actions. All UI panels and tools must use CommandDispatcher to execute commands, ensuring consistent lifecycle management, preconditions checking, and telemetry. Direct invocation of operations via OperationService is discouraged and should be replaced with appropriate commands.
- **Telemetry Hooks:** All mutations flow through OperationService, making it the ideal hook for analytics, autosave, and sync.

### 4.4 Rendering Architecture Notes

- **Three.js Unified Pipeline:** All rendering (3D + 2D) is handled by Three.js to minimize complexity and bundle size. 2D overlays (HUD, selection outlines, gizmos) use an orthographic camera and sprite/material system.
- **Layer Separation:** Logical separation is maintained via internal render phases (viewport pass, overlay pass) rather than different engines.
- **Testing Path:** Planned integration tests validate resize, DPR scaling, and render ordering across the unified rendering pipeline.

## 8. Property Schema System

### 8.1 Overview

Pix3 uses a **Godot-inspired property schema system** for dynamic object inspector UI generation. This system allows node classes to declaratively define their editable properties with type information, validation rules, and UI hints. The Inspector automatically renders appropriate editors for each property type.

### 8.2 Schema Structure

```typescript
interface PropertySchema {
  nodeType: string;
  extends?: string;
  properties: PropertyDefinition[];
  groups?: Record<string, { label: string; description?: string; expanded?: boolean }>;
}

interface PropertyDefinition {
  name: string;
  type: PropertyType;
  ui?: PropertyUIHints;
  validation?: PropertyValidation;
  defaultValue?: unknown;
  getValue: (node: unknown) => unknown;
  setValue: (node: unknown, value: unknown) => void;
}

type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'vector2'
  | 'vector3'
  | 'vector4'
  | 'euler'
  | 'color'
  | 'enum'
  | 'select'
  | 'object';
```

### 8.3 Node Schema Example

```typescript
export class Node2D extends NodeBase {
  static getPropertySchema(): PropertySchema {
    const baseSchema = NodeBase.getPropertySchema();
    return {
      nodeType: 'Node2D',
      extends: 'NodeBase',
      properties: [
        ...baseSchema.properties,
        {
          name: 'position',
          type: 'vector2',
          ui: {
            label: 'Position',
            group: 'Transform',
            step: 0.01,
            precision: 2,
          },
          getValue: node => ({ x: node.position.x, y: node.position.y }),
          setValue: (node, value) => {
            node.position.x = value.x;
            node.position.y = value.y;
          },
        },
        {
          name: 'rotation',
          type: 'number',
          ui: {
            label: 'Rotation',
            group: 'Transform',
            step: 0.1,
            precision: 1,
            unit: '°',
          },
          getValue: node => node.rotation.z * (180 / Math.PI), // radians → degrees
          setValue: (node, value) => {
            node.rotation.z = value * (Math.PI / 180); // degrees → radians
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Transform: { label: 'Transform', expanded: true },
      },
    };
  }
}
```

### 8.4 Inspector Integration

The Inspector panel uses these utilities:

- `getNodePropertySchema(node)` - Retrieves schema for a node instance
- `getPropertiesByGroup(schema)` - Groups properties by their `group` field
- `getPropertyDisplayValue(node, prop)` - Formats value for display

Property changes are handled through `UpdateObjectPropertyOperation`, which uses the schema's `getValue`/`setValue` methods for semantic transformations.

### 8.5 Custom Editors

Vector and rotation properties use specialized Web Components:

- `Vector2Editor` - Single-row X/Y inputs
- `Vector3Editor` - Single-row X/Y/Z inputs
- `EulerEditor` - X/Y/Z rotation in degrees

Transform group renders with 6-column CSS Grid (1rem 1fr 1rem 1fr 1rem 1fr) with color-coded axis labels (X: red, Y: green, Z: blue).

## 6. Script Component System

### 6.1 Overview

Pix3 includes a unified script component system for attaching runtime logic to nodes. This system enables game-like interactivity and logic within the scene editor, similar to Unity's MonoBehaviour or Godot's nodes. All scripts are components attached to nodes via the `components` array.

### 6.2 Script Component Types

Components use a namespace prefix system to distinguish between built-in and user-defined scripts:

- **Built-in Components**: Use `core:` prefix (e.g., `core:TestRotate`)
- **User Components**: Use `user:` prefix (e.g., `user:MyScript`)

Multiple components can be attached to a single node, and all components follow the same lifecycle and interface.

### 6.3 Script Lifecycle

All script components implement the `ScriptComponent` interface with the following methods:

- `onAttach(node: NodeBase)`: Called when the script component is attached to a node. Use this to initialize references and set up state.
- `onStart()`: Called on the first frame after attachment, before `onUpdate`. Use this for initialization that depends on the scene being fully loaded.
- `onUpdate(dt: number)`: Called every frame with delta time in seconds. Use this to update state and animate properties.
- `onDetach()`: Called when the script component is detached from a node or scene is unloaded. Use this to clean up resources and remove event listeners.
- `resetStartedState()`: Called when detaching to allow re-initialization on next attach.

### 6.4 Base Class

- **Script**: Abstract base class for all components. Extend this class to create custom scripts. Components expose parameters via `static getPropertySchema()` for dynamic property editing.

### 6.5 Script Registry

The `ScriptRegistry` service maintains a unified registry of script component types:

- Register components: `registry.registerComponent(info: ComponentTypeInfo)`
- Create instances: `registry.createComponent(typeId, instanceId)`
- Get property schemas: `registry.getComponentPropertySchema(typeId)`
- List all components: `registry.getAllComponentTypes()`

### 6.6 Script Execution Service

The `ScriptExecutionService` manages the game loop and script lifecycle:

- **Game Loop**: Runs `requestAnimationFrame` to tick all nodes in the active scene
- **Node Ticking**: Calls `tick(dt)` on all root nodes, which recursively updates children
- **Lifecycle Management**: Automatically calls `onAttach` when scenes load, `onDetach` when scenes unload
- **Start/Stop**: Control script execution via `start()` and `stop()` methods
- **Scene Change Handling**: Detaches old scripts and attaches new ones when scenes change

### 6.7 Component Picker

The `BehaviorPickerService` provides a modal dialog for selecting components:

- Promise-based API: `showPicker()`
- Search and filtering by name, description, and keywords
- Category grouping (Built-in, Project) for organized display
- Integration with inspector panel for adding components

### 6.8 Inspector Integration

The inspector uses the same compact density as the editor header and scene tree: 12px primary text, 24px fields, 4px between property rows and 8px outer padding. Numeric fields use the normal UI font with tabular digits, align text left in both display and edit modes, and omit trailing decimal zeros (`30.00` → `30`, `1.50` → `1.5`), retaining the schema's display precision without changing stored values. Colored axis labels use regular font weight with an 8px gap before the number. Section headings retain their weight and dividers. Density rules are scoped to `pix3-inspector-panel` in `inspector-controls.ts.css`; inherited `--inspector-font-size`, `--inspector-control-height` and `--inspector-number-gap` also size shadow-DOM property editors, whose fallback sizes remain available in other hosts.

The Object Inspector displays a "Components" section for each node:

- Lists all attached components
- Provides button to add new components
- Enable/disable components via toggle buttons
- Remove components via delete buttons
- Components expose their parameter schemas for inline editing

### 6.9 Node Integration

Nodes store components in the `components: ScriptComponent[]` property.

Nodes implement a `tick(dt)` method that:

1. Updates all enabled components (calls `onUpdate`)
2. Recursively ticks children

### 6.10 Scene Serialization

Components are serialized in scene files as part of node definitions using the namespace prefix format:

```yaml
root:
  - id: 'node_001'
    type: 'Node3D'
    name: 'RotatingCube'
    properties:
      position: { x: 0, y: 0, z: 0 }
    components:
      - id: 'component_001'
        type: 'core:TestRotate'
        enabled: true
        config:
          rotationSpeed: 2.5
```

### 6.11 Example Component

```typescript
export class TestRotate extends Script {
  private rotationSpeed: number = 1.0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { rotationSpeed: this.rotationSpeed };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TestRotate',
      properties: [
        {
          name: 'rotationSpeed',
          type: 'number',
          ui: {
            label: 'Rotation Speed',
            group: 'Component',
            min: 0,
            max: 10,
            step: 0.1,
          },
          getValue: c => (c as TestRotate).config.rotationSpeed,
          setValue: (c, value) => {
            (c as TestRotate).config.rotationSpeed = Number(value);
          },
        },
      ],
      groups: { Component: { label: 'Component Parameters' } },
    };
  }

  onUpdate(dt: number): void {
    if (!this.node || !(this.node instanceof Node3D)) return;
    this.node.rotation.y += this.rotationSpeed * dt;
  }
}
```

### 6.12 Juice & time-scale primitives (P0.3)

The runtime ships a small "juice" toolkit for the punchy, emotional feedback that
sells mini-games and playable ads. It is exposed two ways with identical results:
as a **script API** on `SceneService` (`this.scene.time` / `this.scene.juice`) and
as **`core:` behavior presets** a designer can attach in the inspector.

**Global time scale.** `SceneRunner` multiplies the per-frame delta fed to all
gameplay (ECS, node ticks, scripts/behaviors, keyframe clips, fixed-step physics)
by a single `GameTime.scale`. The `render()` pass is unscaled, so a frozen frame
still paints. Timers advance on the real delta, so they expire even while frozen.

- `scene.time.hitstop(ms)` — freeze (scale → 0) for `ms` of real time; overlapping
  calls take the longest **single request**, and a repeat no longer than the one that
  started the current freeze cannot postpone its end. Hitstop is edge-triggered juice:
  call it when a contact *begins*. Calling it every frame while an overlap lasts used to
  deadlock the game (gameplay `dt` is 0 while frozen, so the contact could never
  separate); it now only slows the game down and logs one warning naming the fix.
- `scene.time.slowMotion(scale, { durationMs?, blendMs? })` — ease into a slow-mo
  scale, optionally hold then blend back to 1.
- `scene.time.setScale(x)` / `reset()` / `scale` / `isFrozen`.

Frame samples report the **real** (unscaled) delta so FPS stays accurate; scaled
game time accumulates separately.

**Juice effects** (`scene.juice`, and the matching presets):

- `shake(target, { amplitude, frequency, duration, decay })` — smooth-noise
  positional shake, **additive** over other motion (removes/re-applies its offset
  each frame, so it composes with a follow and restores cleanly). `target` is a
  node, a node query, or `'camera'` for the active 3D camera. Preset: `core:Shake`.
- `punchScale(target, { amount, duration, vibrato })` — squash-and-stretch scale
  punch that settles back to the resting scale. Preset: `core:PunchScale`.
- `popIn(target, { from, duration, easing })` — spawn pop from `from`× up to the
  authored scale with an overshoot easing. Preset: `core:PopIn` (plays on start).
- `flash({ color, intensity, durationSec })` — full-screen impact flash overlay,
  independent of the fade-to-black overlay and run on real time (plays during a
  hitstop).

Each transform effect is one reused component per node (no per-call allocation)
and, being ticked through `node.tick`, automatically respects `Time.scale`. The
canonical "juicy hit" is three calls:

```typescript
this.scene.time.hitstop(80);
this.scene.juice.shake('camera', { amplitude: 12 });
this.scene.juice.flash();
```

### 6.13 Cutscene Director (P1 M)

A scripts-facing runtime API — `this.scene.cutscene` — that plays a keyframe clip
authored on a node's `core:AnimationPlayer` as a **cinematic**: letterbox bars, a
gameplay-input lock, a skip gesture, and an optional one-shot `core:CameraBrain`
blend override into and out of the cinematic camera. It adds no node type and no
serialized state — camera moves, VFX, and gameplay beats are authored as ordinary
keyframe + event tracks on the clip, exactly like any other animation.

```typescript
const { done } = this.scene.cutscene.playCinematic('IntroCutscene', {
  skippableAfter: 2,   // real-time seconds before the skip gesture arms (omit = unskippable)
  blendDuration: 0.8,  // one-shot CameraBrain blend into + out of the cinematic vcam
});
await done; // 'finished' | 'skipped' | 'stopped'
```

- **`playCinematic(id, options)`** resolves the node by id / name / path, finds its
  (or a descendant's) `core:AnimationPlayer`, and plays `options.clip` (or the
  player's default). Options: `clip`, `skippableAfter`, `blendDuration` /
  `blendEasing`, `letterbox` / `letterboxSize` (0–0.45) / `letterboxEnterSec`,
  `lockInput`, `fireSkippedEvents`, `skipKeys` (`KeyboardEvent.code` list, default
  `Escape` / `Space` / `Enter`). Returns a handle with `done` (a promise that never
  rejects), `isActive`, `skip()`, and `stop()`.
- **Input lock** is a depth-counted `InputService.lock()` / `unlock()`: while held
  the polled-input surface (`getAxis` / `getButton` / `pointerEvents` /
  `pointerPosition`, and every UI control that reads it) goes quiet with no
  per-consumer change. The skip gesture uses independent raw DOM listeners so it
  works through the lock.
- **Skip** fast-forwards via `AnimationPlayerBehavior.finish(fireRemainingKeys)`,
  which fires the event/audio keys between the skip point and the clip end (so
  state-changing beats — "spawn boss", "unlock door" — are not dropped), snaps to
  the end pose, and emits `animation_finished`. Set `fireSkippedEvents: false` for
  a purely-visual cutscene.
- **Camera blend** uses `CameraBrainBehavior.overrideNextBlend(duration, easing)`,
  a one-shot override consumed by the next camera activation that wins even when
  the brain's *Blend On Switch* is off.
- **Chrome runs on real time** (`performance.now` + `requestAnimationFrame`): the
  bars and skip arming never freeze under `hitstop()` or stretch under slow-mo,
  while the clip itself runs on scaled gameplay `dt`.
- **Teardown** is automatic: `SceneRunner.stop()` hard-stops any active cutscene
  (cancels rAF, removes bars, detaches listeners, releases the lock) before the
  runtime graph is disposed, so nothing leaks across play/stop. Starting a new
  cutscene while one is active hard-stops the current one first.

### 6.14 Scene transitions (`scene.changeScene`)

A scripts-facing runtime API — `this.scene.changeScene(path, options)` — that swaps
the running scene to a different `.pix3scene` file, the analogue of Godot's
`get_tree().change_scene_to_file()`. It lets a project split its flow across
separate scene files (menu → game → results) instead of toggling everything inside
one scene, so each scene runs standalone in the editor and the exported build boots
the entry scene (`defaultExportScenePath` in `pix3project.yaml`, or `pix3({ entryScene })`).

```typescript
await this.scene.changeScene('res://scenes/main.pix3scene', {
  transition: 'fade',   // 'fade' (default) | 'none'
  durationSec: 0.3,     // each of fade-out and fade-in
  onLoaded: () => {},   // fires at full black, after the new scene starts
});
```

- **Loading** reads the *saved* file through the runtime `ResourceManager` (project
  files in the editor, embedded/fetched assets in a build) and parses it with
  `SceneManager.parseScene` — a pure parse that never registers the graph in the
  (editor-shared) `SceneManager`, so an in-editor play-mode transition can't corrupt
  editor tab/scene state. The target lives only in `SceneRunner`'s private runtime
  graph and is disposed on the next swap or stop.
- **Timeline:** fade-out → (the old scene keeps ticking under the black overlay) →
  `SceneRunner` tears down the old scene and starts the new one at full black →
  `onLoaded` → fade-in. Because the old scene isn't stopped until the new one parses,
  a missing/invalid target fades back in and the promise rejects instead of stranding
  a black screen.
- **Re-entrancy:** an overlapping call is ignored (warns) and returns the in-flight
  transition, so a double-clicked button is harmless. `transition: 'none'` swaps
  without touching the fade overlay.
- Works identically in play-mode and exports; additive to the runtime contract
  (consumed by DeepCore via yalc).

## 6.15 Group2D Sizing: Fit to Contents and Proportional Resize

> Legacy: the `Layout2D` node that used to be documented here was removed. Scene roots are plain
> `Node2D`/`Group2D` with anchor layout, and the game viewport comes from project settings
> (`viewportBaseSize`). `SceneLoader` rejects a `Layout2D` node with a validation error, and the
> per-child `updateLayout(width, height)` cascade no longer exists.

Group2D is center-origin with an explicit `width`/`height` box and `isContainer = true`. The box is
*authored* — it does not track its children — so the editor provides the two inverse authoring
gestures below. Both are **editor-only**: the math lives in `packages/editor-core/src/features/scene/group2d-resize-utils.ts`
(pure, dependency-light) and the runtime is untouched. Games get responsive behavior from anchor
layout (`Node2D.layoutEnabled` + align modes), not from these gestures.

### 6.15.1 Fit to Contents

`FitGroup2DToContentsCommand` / `Operation` (Inspector *Size* section button, **Node → Fit Group to
Contents**, `Mod+Alt+F`) recomputes the group's `width`/`height` and shifts its origin so the box
wraps its contents, **without moving anything in world space**:

1. Union of every `Node2D` descendant's node-only rect (anchor-aware per node type, plus each nested
   Group2D's own box), mapped into the group's local frame through the matrix chain — so children's
   rotation/scale and nesting depth are handled, and the result is independent of the group's own
   transform. Visibility-agnostic: hidden nodes count.
2. New size = the union's extent (clamped ≥ 1); the origin moves onto the union's center `c`.
3. Compensation: the group's parent-space position becomes `p + L·c` (`L = R(θ)·diag(sx, sy)`, the
   group's own linear part) and every **direct** child shifts by `−c` in group-local. Deeper
   descendants are relative to their own parents and stay untouched. Rotation and scale never change.

No `Node2D` descendants → no-op (the inspector button is disabled).

### 6.15.2 Proportional child resize (Figma-style)

Resizing a Group2D — gizmo handles or the Inspector W/H fields (`ResizeGroup2DCommand`) — scales its
children's positions **and sizes** by `(fx, fy) = (newW/oldW, newH/oldH)` about the center origin:

| Child | Position | Size | Recurse |
|---|---|---|---|
| `layoutEnabled` (anchored) | skip | skip | no — anchor layout owns its subtree |
| exposes numeric `width` + `height` | `q → (q.x·fx, q.y·fy)` | `width·fx`, `height·fy` (`scale` untouched) | **yes**, same factors |
| no width/height | `q → (q.x·fx, q.y·fy)` | `scale·(fx, fy)` | no — descendants inherit via the transform |

Invariant: *handled via width/height ⇒ recurse; handled via scale ⇒ stop* — no double-scaling at any
nesting depth. A zero-size axis forces that factor to 1. Rotated children under non-uniform factors
are an approximation (a true proportional resize would be a shear, which `Object3D` cannot represent);
uniform factors are exact for any rotation. The same rules apply to any size-bearing 2D container, not
just Group2D (e.g. a Sprite2D parenting other sprites).

- **Live drag** captures each descendant's base state once at drag start and reapplies from it every
  frame — idempotent, so min-clamps and long gestures cannot accumulate drift.
- **Hold `Ctrl` while dragging a resize handle** for a box-only resize (children keep their positions
  and sizes — the "ignore constraints" analog); releasing `Ctrl` mid-drag resumes proportional scaling
  from the same base states.
- Non-editor writes to `width`/`height` (generic `UpdateObjectPropertyCommand`, an agent's file edits, scripts,
  animation) keep box-only semantics plus anchor reflow. Proportional scaling is an *editor authoring*
  gesture, not a property semantic.

### 6.15.3 History and grouping

A whole gesture is **one** undo step: `Transform2DBatchOperation` composes per-node
`Transform2DCompleteOperation` commits through `BulkOperationBuilder`, ordered container-first (its
anchor reflow runs before the explicit child plans; undo replays reversed). This also collapses plain
multi-select move/rotate/scale drags into a single history entry.

`GroupSelectedNodesOperation` creates a new Group2D **pre-sized and pre-positioned to the selection's
bounds** (same measurement as Fit to Contents, expressed in the new group's parent frame) before
attaching the children — `attach()` preserves their world transforms, so no compensation pass is
needed and a freshly created group already hugs its contents.

## 6.16 Project Templates, Target Platform and Agent Kit

A project is created by `npm create pix3 [dir] -- --template 2d|3d` (asks in a terminal), which runs `pix3 new <2d|3d> [dir]` of `@pix3/cli`. `packages/create-pix3/templates/` holds a shared layer `base/files/` (`package.json` with `@pix3/runtime`, `three`, `postprocessing`, `lit` and dev `vite`, `@pix3/vite-plugin`, `@pix3/editor-core`, `@pix3/cli`, `typescript`; `vite.config.ts` with `pix3()`; `index.html`; `src/main.ts` calling `startGame('#app')`; `tsconfig.json`; `README.md`; `gitignore`, renamed on copy) and two layers that `extends: base` in their `template.yaml` and add one empty entry scene each — `2d` (a stretched `Group2D` root and a background) and `3d` (camera, key light, ambient). The manifest is generated (`defaultExportScenePath: scenes/main.pix3scene`). Nothing that plays a game ships, and there are no mechanic recipes; the 1.x recipes and playable templates survive only as the spec corpus in `packages/runtime/fixtures/scene-corpus/`. Record: `.plans/templates.md`.

**Full-screen UI lives in `scenes/ui/`, never inline in the gameplay scene.** The editor opens the entry scene (`defaultExportScenePath`, else `scenes/main.pix3scene`; `ProjectService.entryScenePath`) when a project opens, so an overlay authored there is the first thing a user sees of their own game. Each overlay — tap-to-start gate, win/lose card, settings modal — is its own `.pix3scene` under `scenes/ui/`, referenced from its host scene as `{ id, name, instance: res://scenes/ui/<file>.pix3scene, properties: { visible: false } }`. The two visibility flags are deliberately different mechanisms and both are needed:

- `visible` is applied at load by `NodeBase` — an **editor** hide, so `main.pix3scene` opens on the game. Ticking the eye previews the overlay composited; it must not be saved on.
- `initiallyVisible` is applied by `SceneRunner.applyInitialVisibility` when **play mode** starts, and is authored on the overlay file's own root node (`true` for a tap gate that must be up at t=0, `false` for a result card a script reveals). Hiding an overlay with `initiallyVisible` alone was the old shape and does nothing in the editor.

Instance children keep their authored ids when unique, so scripts keep addressing `result-label` / `retry-button` / `cta-button` by id across the split. Overlay scenes ship like any other asset but are excluded from the navigable scene list and never booted (`isPrefabPath` in `packages/vite-plugin/src/build/scan.ts`), on the same grounds as `prefabs/`: they are instantiated, not booted into. The 2.x starters have no overlays; the corpus that still carries them is checked by the loader and saver goldens.

The manifest also carries **`fonts:`** — the web fonts the project ships, each
`{ family, path, weight, style, unicodeRange? }` with a project-relative `path`.
`ProjectFontLoader` (runtime) registers them as `FontFace`s and is awaited **before
the first frame**, for the same reason the locale seed is: a face that lands late
repaints every caption, and a paused or unfocused session freezes on the frame
drawn in the substituted face. The editor registers the same list on project open
(its viewport draws its own canvas text), the player reads it from
`virtual:pix3/scene-manifest` (`runtimeFonts`) and a build ships the files, and a
missing file is a warning — the caption falls back to a system face and the game
still starts.

The project manifest (`pix3project.yaml`) additionally stores `projectType`, `targetPlatform` (`mobile`|`desktop`|`universal`) and `quality` (`antialias`, `shadows`, `maxPixelRatio`; defaults derived from the platform). Play mode (`GamePlaySessionService`) and the player (`runtimeQuality` of `virtual:pix3/scene-manifest`) apply the preset. The editor never writes the manifest (except backfilling `metadata.projectId`); its keys are listed in the kit's `pix3-scene-format/project-files.md` → "`pix3project.yaml`".

The 1.x manifest's `export:` block (`pruneUnusedAssets`, `extraRootScenePaths`, `includeGlobs`, `excludeGlobs`) is still parsed but the 2.x build does not apply it yet; build options are `pix3({ … })` in `vite.config.ts` (`packages/vite-plugin/README.md`), and what a build shipped and why is `dist/<name>.report.json`.

`pix3 new` also installs the **agent kit** (`pix3 kit`: `AGENTS.md`, `CLAUDE.md`, `.claude/skills/pix3-*`, the bot-policy types, `.pix3/kit-manifest.json`; `packages/cli/README.md` → "`pix3 kit`"); the agent's MCP configuration is `pix3 agent-setup`. A 1.x kit is migrated by `pix3 kit --migrate` (`.plans/kit.md`).

## 6.17 Autoload Scripts and Asset Browser Template Flow

Pix3 supports project-level autoload scripts configured in `pix3project.yaml` under `autoloads`.
Each autoload entry includes:

- `scriptPath` - file path relative to project root (for example, `scripts/Events.ts`)
- `singleton` - global singleton name
- `enabled` - whether the autoload is active

Autoload management is available in two editor entry points:

- **Project Settings > Autoload tab** for add/remove/enable/reorder.
- **Asset Browser > Create dropdown > Create autoload script** for fast scaffolding.

When `Create autoload script` is used, the editor:

1. Prompts for a singleton name.
2. Creates `scripts/<SingletonName>.ts` from the autoload template.
3. Triggers project script compilation.
4. Adds the autoload entry to `pix3project.yaml`.
5. Reveals the created script in the Asset Browser.

### 6.17.1 Autoload Runtime Model

- Autoload scripts are instantiated as script components and attached to an internal global root node.
- They are initialized from project manifest order and persist across scene changes.
- They are ticked before active-scene root nodes.
- They are not serialized into `.pix3scene` files.

### 6.17.2 `pix3project.yaml` Example

```yaml
version: 1.0.0
autoloads:
  - scriptPath: scripts/Events.ts
    singleton: Events
    enabled: true
  - scriptPath: scripts/GameManager.ts
    singleton: GameManager
    enabled: true
export:
  pruneUnusedAssets: true
  extraRootScenePaths:
    - res://src/assets/scenes/level-2.pix3scene
  includeGlobs:
    - src/assets/audio/voice/**/*.mp3
  excludeGlobs:
    - src/assets/scenes/scratch/**
```

## 6.18 Signals Engine

Pix3 provides a node-local signal system on `NodeBase` for script-to-script communication.

### 6.18.1 API

- `signal(name)` - declares a signal channel (optional but recommended).
- `connect(signalName, target, method)` - subscribes target method.
- `emit(signalName, ...args)` - dispatches event payload to subscribers.
- `disconnect(signalName, target, method)` - removes one specific subscription.
- `disconnectAll(signalName?)` - clears one signal or all signal subscriptions on the emitter node.
- `disconnectAllFromTarget(target)` - removes all subscriptions matching a target object.

### 6.18.2 Lifecycle Safety

- Every connection whose target is a script is dropped when the script detaches — on its own node **and** on any other node it connected to (`otherNode.connect('signal', this, fn)`). Nodes keep a reverse index per target (`core/signal-target-links.ts`) filled by `connect` and emptied by `disconnect` / `disconnectAll` / `disconnectAllFromTarget` / `dispose`; `emit` never touches it.
- The cleanup runs in `Script.onDetach()` and again, as a safety net for overrides that skip `super.onDetach()`, in `NodeBase.removeComponent` (so `queueFree`), `NodeBase.dispose` and `SceneRunner` stop. A disposed emitter is a no-op.
- This avoids leaking listeners (and the closures that keep nodes alive) tied to detached script instances. Window listeners, store subscriptions and timers are not signals and stay the script's responsibility.
- Preferred connection style: `node.connect('signal_name', this, this.onSomething)`.
- Avoid using `.bind(this)` when connecting signals; bound functions are harder to match for exact disconnects.

### 6.18.3 Example

```typescript
// emitter
this.node?.signal('score_changed');
this.node?.emit('score_changed', scoreValue);

// listener
playerNode.connect('score_changed', this, this.onScoreChanged);

private onScoreChanged(newScore: number): void {
  // update UI
}
```

## 6.19 Groups Engine

Groups provide runtime categorization for nodes (for example, `enemies`, `ui`, `interactables`).

### 6.19.1 Node API

- `addToGroup(group)`
- `removeFromGroup(group)`
- `isInGroup(group)`

### 6.19.2 Scene API

`SceneManager` provides group-based queries and invocation:

- `getNodesInGroup(group)` - returns matching nodes in the active scene.
- `callGroup(group, method, ...args)` - calls matching component methods across grouped nodes.

`callGroup` performs runtime method checks and warns if no callable method is found.

### 6.19.3 Serialization

Groups are serialized in `.pix3scene` nodes via `groups: []`.

```yaml
root:
  - id: player_001
    type: Node3D
    name: Player
    groups: [actors, player]
```

## 6.19a Editor Peek (View Mask)

Peek is the editor's answer to "let me see what is UNDER this" — three stacked UI screens, a HUD over
the world. It is a **per-user, non-serializable view mask**, and the only reason it needs a spec
section is to say what it is *not*: **no part of it belongs to the scene file format.**

### 6.19a.1 What it is not

| Mechanism | Answers | Why Peek is not it |
| --- | --- | --- |
| `visible` / `initiallyVisible` | authored and starting visibility of a node | serialized — an author's "let me peek under this" would ship |
| `editorOnly` | annotation nodes: authored, stripped from play and export | about scene CONTENT, not about this session |
| `groups` (§6.19) | runtime querying and `callGroup` | logic and queries, no visibility semantics |
| `CanvasLayer2D`, `zIndex` | draw band and paint order | Peek changes draw order **never** |
| "Show 2D" / "Show 3D" | viewport dimension filter | a filter over the whole viewport, not per branch |

### 6.19a.2 Mechanism

`NodeBase.visible` is an accessor (defined on the prototype, below the class) returning
`authoredVisible && !hiddenByEditor`. `hiddenByEditor` is stamped by the editor's `PeekService` on
**branch roots only** — three.js already skips a hidden subtree at render time — and every existing
reader follows for free: the render walk, the editor's 2D proxy mirroring, viewport picking, and
`isVisibleInTree()`, which is what `UIControl2D` gates input on, so a masked HUD stops taking taps
instead of merely going invisible. A second flag, `dimmedByEditor`, drives the *solo* fade
(rendered, faded back, not pickable) and is inherited by a walk (`isDimmedInTree()`) because a
material property has no three.js cascade to lean on.

Writes to `visible` set the authored flag and mirror `properties.visible`, which is what keeps
`node.visible = false` from a game script persisting the way it always has.

### 6.19a.3 Where the state lives

- **Not in `.pix3scene`.** With a mask active, `SceneSaver`'s output is byte-for-byte what it would
  be without one (pinned by `packages/runtime/src/core/editor-peek.spec.ts`).
- **Not in a build**, by construction: the mask lives in no file the build reads.
- **Per-user**: the agent's picture can differ from the author's, which is paid for by making the
  state visible — the "N hidden · Show all" pill, and `hiddenByEditor: true` on a masked node in
  the bridge's node answers (`packages/editor-core/src/core/agent-introspection.ts`).
- **`appState.scenes.peekHiddenByScene` / `peekSoloByScene`**, mirrored to `localStorage` keyed by
  the scene's file path so a reload does not force the author to re-hide everything.
- **Outside undo.** The operation returns `didMutate` with no `commit`. Ctrl+Z after hiding the HUD
  must undo the last *edit*, not restore the HUD; a chip is its own undo.

### 6.19a.4 Play mode

The mask stays live while the game runs — that is the headline use case. A play graph is a
serialize→parse clone, so it cannot carry the flags: the editor pushes them in with
`SceneRunner.setEditorPeekMask(ids)`, which the runner re-applies on every start and restart.

### 6.19a.5 Branches

Phase 0 adds no taxonomy. The toggleable branches are derived from structure the scene already has:
top-level nodes — one level deeper when there is a single root — plus any prefab instance root or
`CanvasLayer2D` met on those levels. Identity is `node.id` (stable in the file), so a rename keeps
the mask and a deletion silently drops it.

### 6.19a.6 Where the mask shows itself

A per-user mask that only one panel knows about is a mask the author forgets they set, so the state
is reported wherever it changes what is on screen:

- **The scene tree**, which sits beside the viewport and until now showed an open eye over a branch
  the viewport was not drawing. A masked branch root and everything under it render dimmed with a
  struck-through name — the same language the chips use — and the row tooltip names Peek as the
  reason. On the masked ROOT the eye clears the mask instead of writing `visible: true` into a file
  that never said otherwise; on a descendant it keeps editing that node's own authored visibility,
  because taking down a mask from a row that does not show it would be an edit the user cannot see
  coming. The tree reads the mask from `PeekService.getSnapshot()`, never from the persisted id
  list, which keeps ids whose node has stopped being a branch (§6.19a.5).
- **The strip's chips**, in the other direction: a branch with an authored `visible: false` draws as
  an off eye too — the chip answers "is this on screen" — struck through and inert, with a tooltip
  pointing at the scene tree. Peek neither caused that state nor can clear it, and a toggle that
  moved the mask while nothing on screen changed would be worse than a control that says why it is
  not offering itself. A chip that is authored-hidden *and* masked stays live: clearing the mask is
  a real step back towards seeing it.

## 6.20 Node Prefabs System

### 6.20.1 Overview

Pix3 supports a prefab system for reusing node hierarchies across scenes. Prefabs are standard `.pix3scene` files that can be instantiated (instanced) in other scenes — `.pix3scene` is the only scene/prefab extension; there is no dedicated `.pix3prefab` format, and "prefab" describes how a scene file is used (instanced via `instance:`), not a distinct file type. When a node branch is saved as a prefab, it becomes a reusable asset that can be placed multiple times in any scene. Changes to the source prefab can be propagated to all instances.

### 6.20.2 Prefab Metadata

Each prefab instance stores metadata in `node.metadata.__pix3Prefab`:

```typescript
interface PrefabMetadata {
  localId: string; // Node's original ID in the prefab file
  effectiveLocalId: string; // Current effective local ID
  instanceRootId: string; // ID of the root node of this instance
  sourcePath: string; // Path to the source prefab file (res://...)
  basePropertiesByLocalId?: Record<string, Record<string, unknown>>; // Original property values
}
```

### 6.20.3 Prefab Utilities

The `prefab-utils.ts` module provides helper functions:

- `getPrefabMetadata(node)` - Returns prefab metadata or null if not a prefab node
- `isPrefabNode(node)` - True if node is linked to a prefab
- `isPrefabInstanceRoot(node)` - True if node is the root of a prefab instance
- `isPrefabChildNode(node)` - True if node is a child within a prefab instance
- `findPrefabInstanceRoot(node)` - Walks up the parent chain to find the instance root

### 6.20.4 Instance Creation

Creating a prefab instance uses the `instance:` YAML key:

```yaml
root:
  - id: scene_root
    type: Node3D
    children:
      - id: player_instance_1
        instance: res://prefabs/player.pix3scene
        name: Player1
        properties:
          position: { x: 0, y: 0, z: 0 }
```

The `properties` block allows overriding base prefab values. Overrides are tracked separately from the base values.

### 6.20.5 Prefab Operations

The prefab lifecycle is managed by these operations:

1. **CreatePrefabInstanceOperation** - Instantiates a prefab file as nodes in the active scene
   - Parses the prefab file
   - Creates nodes with prefab metadata
   - Registers nodes in scene graph
   - Updates hierarchy state and selection
   - Accepts an optional `viewportScreenPoint` to position a root-level drop at the cursor (Node2D vs Node3D resolved via `ViewportRendererService`)

2. **RefreshPrefabInstancesOperation** - Rebuilds instance hierarchy from source prefab
   - Triggered when a source prefab file changes on disk (§6.20.9)
   - Can target a specific prefab path or refresh all instances
   - Preserves property overrides while updating base structure

3. **UnlinkPrefabInstanceOperation** (Unity "Unpack Prefab") - Converts an instance into plain, editable nodes
   - Strips `__pix3Prefab` markers from the outer instance and clears its `instancePath`, so its nodes serialize as ordinary children
   - **Nested instances stay linked**: their markers are re-rooted onto themselves (`instanceRootId`/`effectiveLocalId` recomputed relative to the nested root) and their `basePropertiesByLocalId` is rebuilt by freshly parsing the nested source prefab, so they keep round-tripping as `instance:` references with their overrides intact (empty-map fallback on read failure is lossless-but-verbose)
   - Shallow (one level); undo/redo restore before/after marker+`instancePath` snapshots without a scene reparse, so node identity and the rest of undo history survive
   - `OpenPrefabCommand` (not an operation; opens a tab) opens an instance's source prefab in its own scene tab, optionally pre-selecting the corresponding node by `localId`

There is no "Save Branch as Prefab" in 2.x: the agent extracts a branch into a prefab file (kit `pix3-scene-format/project-files.md` → "Extract a branch into a prefab").

### 6.20.6 Inspector Integration

When inspecting a node that is part of a prefab instance:

- Base prefab values are displayed alongside current values
- A "Revert" button allows resetting overridden properties to base values
- Visual indicators distinguish between base values and overrides
- `getPrefabBaseValueForProperty()` retrieves original values for comparison
- Component actions are locked on instance nodes: **Add/Remove/Enable/Disable Component** and **component property value editors** are disabled on every instance node (component config is not serialized as an override), and the **name** field is disabled on instance children (the root keeps an editable name). See §6.20.8
- **Default overrides (placement)**: on an instance **root**, `position`, `rotation`, `scale`, `name`, and the 2D anchored-layout keys (`layoutEnabled`, `horizontalAlign`, `verticalAlign`, the margins `layoutLeft` … `layoutBottom`) describe where the instance sits in the host scene, not the prefab's content (Unity "default overrides"). They are **not** flagged as overrides and have no Revert button, even though they still serialize on the `instance:` definition — so moving, scaling, or anchoring an instance (e.g. pinning a panel to a window edge) is placement, not a content edit. The same properties on a child (or a nested-instance root) remain real content overrides. Implemented via `isInstancePlacementProperty` (`packages/editor-core/src/features/scene/prefab-utils.ts`)

### 6.20.7 Scene Tree Integration

The scene tree distinguishes prefab nodes:

- **Prefab root** (🔗) - Marks the root of a prefab instance; accent-colored name
- **Prefab child** - Dimmed row (~80% opacity), a small lock glyph, and a tooltip explaining the node is instance-locked
- Instance roots are **collapsed by default** on scene load (once per load; user expand/collapse toggles are preserved afterward). Selecting a node still auto-expands its ancestors
- **Double-click** a prefab node (root or child) opens its source prefab in a scene tab (a child pre-selects its corresponding node)
- Context menu is prefab-aware: shows **Open Prefab** for any instance node and **Unlink Prefab Instance** for an instance root; hides Duplicate/Group/Delete for prefab children; keeps them for instance roots

### 6.20.8 Structural Editing & Instance Lock

An instance's child structure is owned by its prefab file, and the save format only round-trips **property** overrides (`instance:` + root `properties:` + `overrides.byLocalId`). Structural edits inside an instance are therefore **not representable** and would be silently lost on save, so they are blocked at every entry point:

- Dragging/reparenting a prefab child (blocked in `canDropNode` and refused at drag start)
- Dropping or creating any node **inside** an instance subtree (blocked in `canDropNode`, the scene-tree asset-drop handler, and `node-placement` which redirects creation to the nearest non-prefab ancestor)
- Duplicating or grouping prefab children (filtered in the operations; commands report a reason)
- Adding/removing/toggling components and editing component property values on **any** instance node, and renaming prefab **children** (disabled in the Inspector; guarded in `AddComponentCommand`/`RemoveComponentCommand`/`UpdateComponentPropertyCommand`/`ToggleScriptEnabledCommand`)

Instance **roots** stay fully editable structurally (move, delete, duplicate as a second instance, rename). To edit an instance's contents in place, either open the prefab (edit the source) or **Unlink** the instance to convert it to plain nodes (§6.20.5). Deleting a prefab child is also blocked (`DeleteObjectOperation`).

### 6.20.9 Auto-Refresh Workflow

1. A prefab file changes on disk — an agent's or the IDE's write, or the editor's own flush of the prefab's tab — and reaches the editor as a `pix3:fs` frame
2. `ExternalChangeService` stabilises it and hands the batch to `ExternalReloadService` (`packages/editor-core/src/host/`)
3. Every other open scene runs `RefreshPrefabInstancesCommand` for that prefab and re-derives its baseline (the override base moved); switching back to a scene tab also refreshes its instances on activation
4. Property overrides are preserved during refresh

## 6.21 Keyframe Animation System

Godot/Unity-style keyframe animation of node properties with tweened interpolation and audio cues. Runtime lives in `packages/runtime/src/animation/`; the editor UI is the bottom-docked **Animation** timeline panel (`animation-timeline`).

### 6.21.1 Runtime Model

- **`core:AnimationPlayer`** is a built-in script component (`AnimationPlayerBehavior`), registered like other behaviors. It plays clips on its host node and the host's descendants.
- Clip data lives in the component's `config.animations` (`KeyframeAnimationSet`), so it serializes with the scene verbatim — no SceneLoader/SceneSaver changes.
- Data model (`animation/keyframe-types.ts`, all plain JSON): `KeyframeAnimationSet { version, clips[] }` → `KeyframeClip { name, duration, loop, tracks[] }` → property tracks (`{ targetPath, property, valueType, keys: [{ time, value, easing }] }`), audio tracks (`{ name, keys: [{ time, audioPath, volume }] }`), and event tracks (`{ name, targetPath, keys: [{ time, signal, args }] }`). Vector values are stored as arrays (`[x, y]`, `[x, y, z]`); rotations are stored in **degrees** (the property schema converts to radians internally). `normalizeKeyframeAnimationSet()` defensively coerces arbitrary data; the component's hidden `animations` schema property applies it on scene load.
- **Event tracks** are the cutscene glue: when the playhead crosses a key it emits `signal` on the track's target node (`emit(signal, ...args)`), so a single clip can synchronize camera, VFX, audio, and gameplay. `args` is a raw string parsed by `parseEventArgs()` at fire time — empty → no args, a JSON array → spread, any other JSON → one arg, unparseable text → the raw string as one arg. Gameplay scripts (typically on the host node) `connect()` to these signals; the signal engine already routes them.
- **Track targeting** uses relative name paths from the host node (`''` = host itself, `'Child/GrandChild'` with `findByPath` semantics). Name paths survive prefab instancing (node ids are regenerated on instantiation, names are not); renaming a targeted node breaks the track and surfaces a warning icon in the timeline.
- **Evaluation** (`animation/clip-evaluator.ts`): pure sampling (`sampleTrack`, hold semantics outside the key range, per-segment easing from the left key) plus a node-applying layer (`createClipBindings` resolves targets/schema once, `applyClipAtTime` writes through `PropertyDefinition.setValue`). Easing curves (`animation/easing.ts`): `linear`, `step`, and Penner sine/quad/cubic/expo/back/elastic/bounce × in/out/inOut. Discrete types (boolean/string) always step. Colors interpolate per sRGB channel.
- **Playback**: `onUpdate(dt)` advances time × `speed`, applies the pose, and fires time-window keys — audio and events alike — crossed in `(prev, next]` (shared boundary rule in `collectTimedKeysInRange`, loop-wrap aware; `fireTimeWindow` runs both so each key fires exactly once per crossing). Non-looping clips clamp to the final pose and emit `animation_finished` on the host node; `play()` emits `animation_started`. Public API: `play(clipName?)`, `stop()`, `pause()/resume()`, `seek(t)`, `currentTime`, `duration`, `isPlaying`, `getAnimationSet()`, `invalidateBindings()`. `autoplay` config starts a clip in `onStart`.

### 6.21.2 Editor

- **Panel**: `pix3-animation-timeline-panel`, docked in the bottom stack next to Assets Preview/Logs. It binds to the `core:AnimationPlayer` of the selected node or its nearest ancestor; empty states offer adding the component (seeded with one clip) and creating clips. Toolbar: clip selector + clip actions (new/rename/duplicate/delete), preview transport, playhead readout, clip duration, loop, snap toggle + step, zoom, Add Track, add/delete key, easing selector for the selection.
- **Editing** flows through a single operation, `animation-timeline.update-clips` (`UpdateAnimationPlayerClipsOperation`): an updater closure mutates a normalized draft of the set; undo/redo restore whole-set snapshots. Key drags commit per pointer-move with an `options.coalesceKey` plus the drag-start set as `previousSet`, so one history entry spans the whole drag. Pure helpers live in `features/animation-timeline/clip-edit-utils.ts`.
- **Add Track** lists the host subtree with computed relative paths (ambiguous sibling names flagged), then the target's animatable schema properties (number/vector2/vector3/euler/color/boolean/string, minus hidden/read-only/already-tracked). New tracks seed a key at t=0 from the node's live value; "Add Key" captures the sampled value between keys or the live value on empty tracks. Audio keys are created by dragging audio assets onto an audio track lane. **Audio Track** and **Event Track** entries in the Add-Track menu add host-scoped tracks; event keys are inserted by double-click / right-click on the lane (seeded `signal: 'event'`) and edited via the key context menu (signal name + JSON args). Event tracks store a `targetPath` for retargeting via YAML/agents even though the button seeds the host.
- **Preview** (`AnimationTimelinePreviewService`): scrubbing/playback samples clips onto live nodes **without** dirtying the scene, touching history, or bumping `nodeDataChangeSignal`. Original values are snapshotted per animated property on session start and restored on stop. Guards via `OperationService` events: scene saves restore authored values before serialization and re-apply after; undo/redo or any foreign mutating operation (including play-mode start) ends the preview; the panel's own clip edits refresh bindings in place. Audio keys are audible during preview playback (not while scrubbing); event keys also fire during preview (a no-op in the editor since no game scripts are connected, but timing stays WYSIWYG with play mode).
- Panel-local shortcuts (local keydown listener, not global keybindings): Space play/pause, Delete removes selected keys, arrows nudge keys/playhead by the snap step (Shift ×5), Home/End jump the playhead.

## 6.22 Localization (i18n)

Godot-inspired localization (`TranslationServer`/`tr()` adapted to Pix3): per-locale JSON tables + explicit key properties on nodes. Runtime lives in `packages/runtime/src/core/localization/`; editor authoring in `LocalizationEditorService` + the **Localization** panel + `src/features/localization/` commands/operations.

### 6.22.1 Data Model

- **Tables**: `locales/<locale>.json` at the project root, loaded via `res://locales/<locale>.json` (so exported-build embedding is free). Each file: `$meta` (`locale`, `name`, optional `direction`), `strings` (flat dot-namespaced key → text, `{param}` interpolation tokens), `sprites` (sprite key → `res://` texture path — for sprites/skins with baked per-language text). Written pretty-printed with sorted keys.
- **Manifest**: `pix3project.yaml` gains an optional `localization:` block (`defaultLocale`, `fallbackLocale`, `locales: [...]`). Absent block ⇒ auto-discovery from `locales/*.json`; no locales ⇒ the whole system is inert.
- **Resolution never throws**: `tr(key)` falls current locale → fallback locale → the key itself; `trSprite(key)` falls current → fallback → `null` (caller keeps the authored texture). Empty (`""`) entries count as *untranslated* and fall through the same chain (Godot semantics) — they are the template placeholders key extraction seeds for translators.

### 6.22.2 Runtime

- **`LocalizationService`** (plain class, no editor DI): `configure(cfg)`, `attachResources(rm)`, `setLocale(id)` (lazy table load + cache), `setTable(table)` (editor live-feed), `tr(key, params?)`, `trPlural(key, count, params?)` (convention suffix keys `key.one/.few/.many/.other` selected via `Intl.PluralRules(locale)`, falls to `.other` → bare key; `{count}` always interpolable), `trSprite(key)`, `has(key)`, `onChange(cb)`.
- **Active-instance pointer** (`active-localization.ts`, globalThis sink like `project-texture-filtering.ts`): the editor activates a preview instance; `SceneRunner.startScene` swaps in an isolated play-mode instance seeded with the editor's preview locale (or `defaultLocale` in exports) and restores the previous pointer on stop. The seed locale's table load is **awaited before the first frame** (`runGraph` → `setupLocalization`), so keyed labels never flash the raw key — critical when a paused/background session freezes on frame one.
- **Node integration**: `UIControl2D.labelKey` (all subclasses render `getDisplayText()` = `tr(labelKey)` falling back to the literal `label`; key wins when both set); `Label2D.setTextKey(key, params?)` for dynamic labels (re-resolves on locale switch; `setText` clears the key); `Sprite2D.textureKey` and `Button2D.stateTextureKeys` (`textureNormalKey` etc. in the schema) resolve through the `sprites` table with the authored texture ref as fallback.
- **Locale-change walk**: `applyLocaleToTree(roots, textureLoader?)` repaints every keyed label and re-resolves/reloads keyed sprite textures (stale async loads are dropped). Shared verbatim by `SceneRunner` (play) and the editor preview.
- **Scripts**: `this.scene.localization` (`tr`, `setLocale`, `onChange`, …) mirroring the `scene.audio` facade; data modules can `import { getActiveLocalization } from '@pix3/runtime'`.

### 6.22.3 Editor

- **`LocalizationEditorService`**: loads tables at project open (manifest or auto-discovery), owns the preview instance, exposes the authoring API (`setEntry`/`removeKey`/`renameKey`/`getMissing`, all section-aware: `'strings' | 'sprites'`), mirrors counters into `appState.localization` (IDs/counts only — tables stay in the service). Each edit writes through with `If-Match`; a table changed on disk is followed and merged key by key, and a write that got no answer is drafted in IndexedDB (`.plans/write-model.md` W20, W22).
- **Localization panel** (`pix3-localization-panel`, Window → Localization): Strings/Sprites section tabs; rows = keys, columns = default locale + one target locale; filter, missing-only view with per-cell warning tint; add/remove key; preview-locale dropdown that live-updates the viewport (labels *and* localized sprite proxies). A locale is a file: adding or removing one is the agent's (kit `pix3-scene-format/project-files.md` → "Add or remove a locale").
- **Inspector**: `labelKey`/`textureKey` render via the `localization-key` editor hint — autocomplete over known keys, resolve-status icon (checks both `strings` and `sprites`), and an **Extract** button that creates the key from the literal label in the default locale.
- **Mutations** ride Commands/Operations under `packages/editor-core/src/features/localization/` (`UpdateLocaleEntry`, `RemoveLocalizationKey`, `RenameLocalizationKey`, `ExtractLocalizationKeys`, `SetPreviewLocale` — the last is non-dirtying, editor-view state). Node key properties ride the existing `UpdateObjectPropertyOperation`.
- **Key rename** (`RenameLocalizationKeyCommand`/`Operation`, panel row pencil or double-click on the key): moves the key in every locale table AND rewrites `labelKey` / `textureKey`-family references in all **open** scenes through the property schema (touched scenes marked dirty); one undoable step. Refuses when the new key already exists. Closed scene files and script literals are not rewritten — a follow-up panel Scan reports the stale script keys.
- **Key extraction** (the POT analog): the panel's **Scan** button runs `ExtractLocalizationKeysCommand` → `LocalizationExtractionService.scan()` finds (a) `UIControl2D` `label:` literals without a `labelKey` in every `.pix3scene` (the active scene is read from its live graph, so unsaved edits are honored) and (b) `tr`/`trSprite`/`trPlural`/`setTextKey` string-literal keys in project scripts that are missing from the default table (interpolated template literals are skipped; `trPlural` resolves through its suffix keys). The report renders in the panel: per-item **Extract** (creates the key in the default locale + sets `labelKey` via the property op; suggested keys are name-slugs deduped against the table — identical literals share a key) and per-item **Add** for missing script keys. `ExtractLocalizationKeysOperation` then seeds keys present in the default locale but absent from other locales as `""` placeholders (undo removes only still-empty ones).

### 6.22.4 Build

- The build's asset scan (`packages/vite-plugin/src/build/scan.ts`) ships the `locales/*.json` tables of the effective localization config (`defaultLocale` + `fallbackLocale` + `locales`; without a `localization:` block, every table in `locales/`) and every texture path in their `sprites` sections (invisible to the `res://` scan of scenes and scripts). A `null` config (localization inert) ships no table.
- `virtual:pix3/scene-manifest` exports `runtimeLocalization` (the effective config or `null`); the player calls `runner.setLocalizationConfig(...)` before the scene starts, so the first frame renders in `defaultLocale` and a single-file build works offline from its embedded tables.

## 6.23 AI Image Generation

The **Asset Generator** panel (`pix3-generate-panel`, Window → Asset Generator) makes raster art with Gemini or OpenAI; a result reaches the project only through the panel's **Save to project**. Keys are set in the panel or in Editor Settings → AI Images and stored by the plugin in `~/.pix3/keys.json` (0600; `.pix3/local/keys.json` when the home is not writable); the page sees only "set" and the last four characters, and every request goes through `/__pix3/api/proxy/{gemini,openai}`, which adds the key and forwards the generation endpoints only. Record: `.plans/editor-core-port.md` §11 ("Image-gen key proxy").

## 7. Scene File Format (\*.pix3scene)

The scene file uses the YAML format to ensure readability for both humans and machines (including AI agents).

### 7.1 Key Principles

- Declarative: The file describes the composition and structure of the scene, not the process of its creation.
- Asset Referencing: Assets (models, textures) are not embedded in the file but are referenced via relative paths with a res:// prefix (path from the project root).
- Flat Asset Layout: a game project keeps one folder per asset type **at its root** — `scenes/`, `sprites/` (images/textures), `models/`, `audio/`, `fonts/`, `spine/` (skeleton + atlas + pages together), `scripts/`, `locales/` — with free subdivision inside (`sprites/ui/…`). There is no `assets/` wrapper folder; `pix3 new` creates this layout.
- SVG textures: an `.svg` works as a `Sprite2D` / `Button2D` texture only when its root `<svg>` carries `xmlns="http://www.w3.org/2000/svg"` and px `width`/`height` (a viewBox alone has no intrinsic size), it is self-contained, and the Blob it is decoded from is typed `image/svg+xml` — the editor types the bytes it reads by extension (`packages/editor-core/src/services/project/file-content-type.ts`) and a build embeds every asset with its type (`packages/vite-plugin/src/files/content-type.ts`). `pix3 validate` checks referenced SVGs (`E_SVG_INVALID`, `E_SVG_NO_SIZE`, `W_SVG_VIEWBOX_ONLY`, `W_SVG_EXTERNAL_REF`).
- Composition: Complex scenes are assembled from simpler ones by instantiating other scene files.
- Unambiguous Structure: An explicit children key is used to denote the list of child nodes, which separates the hierarchy from the properties of the node itself.
- Unique Identification: Every node must have an id field. The value is a short, cryptographically secure unique identifier (similar to Nano ID) to provide a balance between file readability and the absolute reliability of references.
- Versioned Schema: Each file includes a `version` field; migrations are maintained in the SceneManager and run automatically on load.
- Conflict Resolution: Instance overrides always win over parent definitions. Duplicate IDs trigger validation errors during import.
- Forgiving Vocabulary: a `type:` the loader does not know does **not** fail the load — the node is built as a bare `NodeBase` placeholder that does nothing, so a scene written by a newer version (or with a typo) stays openable and editable. Because such a node is otherwise indistinguishable from a working one, it is reported on three surfaces: the renderability lint (`inert-nodes`, a warning when play starts and in `pix3_game_run` observations), the loader diagnostic (`describeUnknownNodeType`, which suggests the nearest known name), and the Scene Tree row, which carries a warn badge and states the reason in its tooltip. `isInertNode` (`packages/runtime/src/core/renderability-lint.ts`) is the one predicate behind all three; `pix3 validate` reports the same node as `E_UNKNOWN_NODE_TYPE`.

### 7.2 Example Structure

```yaml
# --- Metadata ---
version: 1.0
description: 'Main scene for the first level'

# --- Node Hierarchy ---
root:
  # Each node has a unique ID, type, name, and properties
  - id: 'V1StGXR8_Z5jdHi6B-myT'
    type: 'Node3D'
    name: 'World'
    properties:
      position: { x: 0, y: 0, z: 0 }
      rotation: { x: 0, y: 0, z: 0 }

    # Explicit definition of child nodes for clarity
    children:
      - id: 'b-s_1Z-4f8_c-9T_2f-3d'
        # Instance of another scene (prefab)
        instance: 'res://scenes/player.pix3scene'
        name: 'Player'
        properties:
          # Overriding instance properties
          position: { x: 0, y: 1, z: 5 }

      - id: 'k-9f_8g-7h_6j-5k_4l-1'
        type: 'MeshInstance3D'
        name: 'Ground'
        properties:
          # Reference to an asset
          mesh: 'res://models/ground_plane.glb'
          scale: { x: 100, y: 1, z: 100 }
```

### 7.2.1 Spine skeleton nodes

A `SpineSkeleton2D` references its Spine export by two `res://` paths — the
skeleton (`.json` or `.skel`) and the atlas (`.atlas`). The atlas' page images are
NOT listed: they are named inside the atlas text and resolved relative to it (the
build's asset scan, `packages/vite-plugin/src/build/scan.ts`, parses `.atlas` files for the same reason). `texture` is an
optional single-page override.

```yaml
- id: 'ZP2h-9kQ_1sVb0Ac-7mnE'
  type: 'SpineSkeleton2D'
  name: 'Hero'
  properties:
    transform:
      position: { x: 0, y: -120 }
      scale: { x: 1, y: 1 }
    skeletonPath: 'res://spine/hero.json'
    atlasPath: 'res://spine/hero.atlas'
    animation: 'idle'
    loop: true
    isPlaying: true
    skin: ''
    timeScale: 1
    defaultMix: 0.15
    color: '#ffffff'
    # Omitted unless enabled: twoColorTint, freeOnFinish, previewInEditor
```

Rendering requires the optional `@esotericsoftware/spine-threejs` (`~4.3`) module,
registered by the host through `setSpineModuleLoader`. A scene with a Spine node
still loads without it — the node keeps its authored properties and warns.

### 7.2.2 Skinned 2D UI controls

Physical UI gestures have one target: the topmost enabled, visible interactive
control under the pointer, ordered by overlay band, effective `zIndex`, then tree
paint order. Display-only labels and bars do not intercept the gesture. Ownership
lasts until release/cancel, even when a callback hides its target or opens a modal;
a newly revealed close button cannot reuse the opening press. A fresh press can
close immediately, with no timer or debounce. Each pointer is independent.

Hover uses this same topmost target. A `ColorRect2D` with
`blocksPointerInput: true` participates as a non-interactive input barrier within
its transformed rectangle. Visible modal backdrops therefore suppress hover and
presses on controls behind them, including HUD buttons outside the panel; modal
controls painted above the backdrop remain interactive. Hidden backdrops block
nothing, and opacity does not change input eligibility during fades. The flag
defaults to false and survives scene save/load and play-mode cloning.

`Button2D`, `Checkbox2D`, `Slider2D` and `Bar2D` are colour-driven by default and
skinned by pointing their texture slots at `res://` sprites. A slot that is set
replaces the corresponding flat colour (the material tint goes white); a slot that
is unset keeps the colour, so an existing scene is unchanged and **every one of
these keys is omitted from a saved scene at its default**.

Slots per node: `Button2D` — `textureNormal` / `textureHover` / `texturePressed` /
`textureDisabled` (a missing state falls back to normal); `Checkbox2D` —
`textureBox`, `textureBoxChecked` (optional; falls back to `textureBox`),
`textureMark` (drawn over the box only while checked); `Slider2D` —
`textureTrack`, `textureFill`, `textureThumb`; `Bar2D` — `textureTrough`,
`textureFill`.

The four `sliceBorderLeft/Right/Top/Bottom` scalars are the same nine-slice insets
`TiledSprite2D` uses — source-texture pixels, Godot's `patch_margin_*` — so one
64x64 skin fits a control of any size instead of being smeared. They apply to
`Button2D`'s state skins, `Slider2D`'s track and fill, and `Bar2D`'s trough and
fill; the slider thumb is drawn at its authored size and is never sliced. A fill
that shrinks with `value` is **re-cut** at the new width, so its end caps keep
their pixel size. All-zero (the default) is the plain stretch. A sliced skin opts
out of the 2D quad batcher, because the batcher extracts four *unit* corners, and
is excluded from the pre-launch texture atlas for the same reason.

```yaml
- id: 'q7Bd-1mZ_kTn0-Vx4pA'
  type: 'Button2D'
  name: 'PlayButton'
  properties:
    transform:
      position: { x: 0, y: -80 }
    width: 240
    height: 72
    label: 'Play'
    buttonAction: 'Submit'
    textureNormal: { type: 'texture', url: 'res://sprites/ui/btn_normal.png' }
    textureHover: { type: 'texture', url: 'res://sprites/ui/btn_hover.png' }
    texturePressed: { type: 'texture', url: 'res://sprites/ui/btn_pressed.png' }
    # 64x64 skin with 16 px corners -> fits 240x72 without smearing
    sliceBorderLeft: 16
    sliceBorderRight: 16
    sliceBorderTop: 16
    sliceBorderBottom: 16

- id: 'w3Kf-8sQ_2rLm-Yc6tB'
  type: 'Bar2D'
  name: 'HealthBar'
  properties:
    width: 200
    height: 24
    value: 100
    maxValue: 100
    textureTrough: { type: 'texture', url: 'res://sprites/ui/bar_trough.png' }
    textureFill: { type: 'texture', url: 'res://sprites/ui/bar_fill.png' }
    sliceBorderLeft: 12
    sliceBorderRight: 12

- id: 'e5Nh-4tW_9pJk-Zd1uC'
  type: 'Checkbox2D'
  name: 'MusicToggle'
  properties:
    size: 32
    checked: true
    label: 'Music'
    textureBox: { type: 'texture', url: 'res://sprites/ui/check_off.png' }
    textureBoxChecked: { type: 'texture', url: 'res://sprites/ui/check_on.png' }
    textureMark: { type: 'texture', url: 'res://sprites/ui/check_tick.png' }
```

### 7.2.3 2D transform and anchor layout

A 2D node's placement is its `transform` block (`position: [x, y]` — the node's centre relative to
its parent, X right, Y up — `scale`, `rotation` in degrees) and, when it is anchored, its `layout`
block:

```yaml
- id: score
  type: Label2D
  properties:
    width: 200
    height: 60
    transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
    layout: { enabled: true, horizontalAlign: left, verticalAlign: top, left: 40, top: 30 }
- id: bar
  type: Group2D
  properties:
    height: 40                                   # no width: stretch derives it
    transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
    layout: { enabled: true, horizontalAlign: stretch, verticalAlign: bottom, left: 40, right: 40, bottom: 20 }
```

`horizontalAlign` is `left | center | right | stretch`, `verticalAlign` `top | center | bottom |
stretch` (default `center`). **An anchored axis is placed by its margins** — `left` / `right` /
`top` / `bottom`, the distance in design pixels from the parent's edge to the node's same edge; a
`left` alignment keeps `left`, `right` keeps `right`, `stretch` keeps both and sizes the node from
them, a centred axis keeps none and uses `position` as authored. What the margins derive is not
stored: the saver writes `0` for the `position` component of an anchored axis (the loader ignores
it when the margin is present) and omits `width` / `height` under `stretch`. That is what lets a
parent be resized without touching a single child entry — the layout re-resolves each child from
its margins and the parent's current size, in the editor and in the game alike (`.plans/write-model.md`
W21). A node directly under a parent flow (`flow.enabled`) has no margin on the flow's main axis:
the flow places it there. A **root** 2D node's reference is the project's `viewportBaseSize`, which a
scene file does not know, so a root keeps its authored rect and resolves against the screen as
before; margins written on a root by hand are honoured.

**Files without margins** (every scene written before W21, and any file an agent writes with the
anchors alone) load exactly as they always did: the margins are derived once from the node's
rect against the parent's authored size. The editor converts such a file to the margin form on its
first write of it (`legacy-anchor-conversion.ts`): a partial patch of a legacy entry would not be
sound, since a parent's new `width` changes what every child rect in the file means. There is no
scene-format version bump — the loader reads both forms, `pix3 validate` accepts both — and no
migration command: a project moves over file by file as the editor saves them. On a prefab
**instance**, the same values use the schema names `layoutLeft` / `layoutRight` / `layoutTop` /
`layoutBottom` beside `layoutEnabled` / `horizontalAlign` / `verticalAlign` and `position: {x, y}`
(the instance's placement, §6.20 "Default overrides"), whatever the file's key order.

### 7.3 Validation Rules

- The root section must contain at least one node entry.
- Node ids must be unique within a file (`E_DUPLICATE_ID`); an instance's inner ids that collide with the host scene's are renamed `<id>-1`, `<id>-2`, … by the loader.
- `instance` entries must point to existing `.pix3scene` files; SceneManager resolves relative to project root.
- Optional `metadata` block can include analytics tags, localization keys, and QA notes.
- CI and agents check committed scenes with `pix3 validate` / `pix3 check` (below).

**Strict profile — `pix3 validate`.** The loader stays forgiving (above); strictness lives in the CLI (`packages/cli/src/validate/`), which reports every problem as `{severity, code, file, nodeId?, path, line?, message, fix?}` (`--json` adds the sha256 of each validated file; exit code 1 on any error). Level 1 reads files only — no project code, no DOM: document/node/component shape, `type:` vocabulary, property keys and values, `core:` component config, `user:` components by existence (a file under `scripts/` with `extends Script` exporting that name), `res://` targets, prefab targets/cycles/roots, override targets, duplicate ids, emoji-as-art. Level 2 (on unless `--no-hydrate`) hydrates the scene with the real `SceneLoader` in plain Node (`@pix3/runtime/node`: canvas-only `document` shim, disk `ResourceManager`, existence-checking `AssetLoader`) after compiling the project scripts with native esbuild, and reports loader rejections/warnings, still-pending components, `user:` config keys against the compiled schema, and the renderability lint as warnings. "Unknown property" is decided by the **disk format**, not by `getPropertySchema()`: `packages/runtime/src/core/scene-disk-format.ts` lists, per node type, which keys the loader reads under `properties:` (flat schema names, `transform`/`layout`/`flow`/`material`/`stateTextureKeys` nesting, per-type extras and read-compat aliases), and `scene-disk-format.spec.ts` pins it against what `SceneLoader` actually honours and what `SceneSaver` actually writes. There are no scene-format migrations today: `version` other than `1.0.0` is only a warning.

## 10. Non-Functional Requirements

- **Performance:** Maintain ≥ 85 FPS in viewport on baseline hardware. Initial load (cold) < 6s, warm reload < 2s. Command execution should visually update UI within 80ms.
- **Accessibility:** WCAG 2.1 AA minimum for editor chrome; ensure keyboard navigation for panel focus and command palette. Provide high-contrast theme preset.
- **Security & Privacy:** Project contents never leave the machine through Pix3. The plugin's file API answers loopback peers only (unless `allowRemote`) and refuses a mutation without `X-Pix3: 1` and the page's own `Origin`; image-generation keys live in `~/.pix3/keys.json` (0600) behind the plugin's proxy and never reach the page; the agent reaches Chrome only through the token-checked CDP proxy of `pix3 editor` (`.plans/agent-bridge.md`, threat model).
- **Reliability:** An edit is never lost silently: unflushed scene and locale-table edits survive a dead dev server as an IndexedDB draft, every scene write is journaled under `.pix3/history/`, and a write over a version the editor has not seen is refused (`If-Match` → 412) and merged instead (`.plans/write-model.md`). Undo history keeps at least the last 100 operations.
- **Internationalization:** The editor's UI is English. A game's text is localized through locale tables and key properties (§6.22 Localization), never through strings in the scene file.

## 11. Project Structure

npm workspaces, versions lockstep from the root `package.json`; `CLAUDE.md` → "Repository topology" is the authoritative list.

```
packages/
├── runtime/        # @pix3/runtime — nodes, Script, ECS, SceneLoader/SceneSaver, SceneRunner (TS sources)
├── vite-plugin/    # @pix3/vite-plugin — editor at /__pix3/, file API, sync, build (src/build/), player (player/)
├── editor-core/    # @pix3/editor-core — the Lit editor, mounted through EditorHost (src/host/)
│   └── src/        # core/ fw/ features/<area>/ services/<domain>/ state/ ui/<panel>/
├── cli/            # @pix3/cli — validate, check, smoke, tree, kit, editor, agent-setup, …; kit-src/ = the agent kit
└── create-pix3/    # npm create pix3 — templates/ (base + 2d/3d layers)
```

## 12. Roadmap and Milestones

Phases and gates are §G of `../pix3/.plans/pix3-core.md`; what is built and what is not is the status paragraph of `CLAUDE.md` and the as-built records in `.plans/`.

## 13. Change Log

> Section numbers cited in older entries reflect the numbering at that release; the appended systems were renumbered to 6.15–6.22 to remove duplicate numbers. Refer to sections by heading text.

- **2.2 (2026-10-11):** **The editor-facing sections describe 2.x.** The 1.x machinery that 2.x does not have is cut from Key Features, Technology Stack, Architecture, Project Templates (now "…and Agent Kit"), Peek, Prefabs, Keyframe Animation and Localization: the `pix3 serve` workspace and its token, co-authoring (autosave, protected set, merge log, acks, recovery journal), the live agent channel and `pix3 mcp`, the in-editor agent, Flow and Vibe, the New Project wizard and its agent overlay, Install Agent Kit, the PWA and `esbuild.wasm`, the export dialog and its reachability report, Save as Prefab, the UI Kit Assets section (UI Kit Forge is not in 2.x and nothing in the runtime reads its files), AI image generation through Codex, the MVP plan and the 1.x source tree. In their place, briefly and pointing at the as-built records: the editor on the game's dev server, the write model, the agent bridge over Chrome DevTools MCP, scripts through Vite, the plugin's build, and the kit's recipes for the file and project work the editor no longer does. Engine and format sections are unchanged except for verified drift: Key Principles' SVG typing and inert-node surfaces, Spine atlas pages in the build scan, Validation Rules' id uniqueness.
- **2.1 (2026-10-10):** **Anchor margins are stored in `layout:`.** An anchored 2D node's margins — the distance from the parent's edge to its own — used to exist only implicitly, as the node's rect against its parent's *authored* size (`Node2D.resolveHorizontalLayout`), so resizing a container in the editor had to rewrite every stretched or edge-anchored child's `width`/`height`/`position` (`.plans/write-model.md` W16's open debt). The `layout:` block now carries `left` / `right` / `top` / `bottom` for the sides the alignment keeps, the saver writes nothing they derive (`0` for the position component of an anchored axis, no `width`/`height` under `stretch`), the loader resolves the rect from the margins and the parent's current size, and a parent resize writes the parent alone (§7.2.3). Files without margins load as before — the margins are derived once from the rect — and the editor converts such a file on its first write of it (a partial patch of a legacy entry is not sound once a parent's size changes); no scene-format version bump, no migration command. `pix3 validate` knows the four keys; the inspector shows the margins the anchors keep under the anchor modes; on an instance root they are `layoutLeft` … `layoutBottom`. The merge rule's `laid-out` drop reason is gone with the rects it protected. Proven over the whole scene corpus and DeepCore: the margin form places every node where the legacy rect did, at the design size and on a wider or taller screen. Also: `Sprite2D` fills only the axis the file leaves out from the texture (it used to replace both), and the runner lays 2D roots out before the pre-roll tick so `onStart` reads resolved rects. In the editor, a locale table's write that got no answer is drafted in IndexedDB and offered on the next open like a scene's (W22).
- **2.0 (2026-10-08):** **pix3-core repository seeded.** This spec, the runtime, the CLI and the project templates moved from `pix3` (now `pix3-full`, frozen on 1.6.x) into `pix3-core` with their history; this file is the version of record from here on. Pix3 2.x is a Vite plugin (`@pix3/vite-plugin`) that serves the editor (`@pix3/editor-core`) on the game's own dev server, plus `@pix3/runtime`, `@pix3/cli` and `create-pix3` (`.plans/pix3-core.md` in `pix3`). Editor-facing sections below still describe the 1.x editor until the port lands; entries up to 1.42 are the `pix3` history.
- **1.42 (2026-09-28):** **Library insert reuses content the project already has, and lands in one refresh.** Dropping a published Seven character back into its own project wrote a second copy of all 137 files under `assets/library/<slug>/`, one sequential request per file, and bumped `fileRefreshSignal` after every file — over a remote `pix3 serve` that re-listed the asset tree ~140 times, and because the prefab and flipbook were written first, each refresh loaded a character whose frames did not exist yet (hundreds of "Resource not found" failures). `LibraryInsertService` now dedups by content: a bundle file whose sha256 matches a project file at any path is referenced there instead of copied — hashes come from the backend's manifest (`ProjectStorageService.getContentHashIndex`: `pix3 serve` and cloud already carry sha256; local FSA has none, so only the file's own original path is hashed and compared). Text files are matched after their references are remapped, so a flipbook whose frames were all found compares equal to the project's own and is reused too; among byte-identical files (a looping flipbook repeats frames) the file's own path wins, or the remap would rewrite `…_0009.png` to its twin `…_0005.png` and defeat that match. Writes go binaries → text files in dependency order → entry last, six at a time, with each directory created once; a reference cycle is copied into the target folder rather than stalling. `ProjectStorageService.batchMutations(fn)` coalesces the local listing signal of every write inside it into one (collaborators still see each write). Measured on the live Seven project: re-inserting Knight wrote 1 file and signalled once. Guarded by `LibraryInsertService.spec.ts` (order, cycle, hash dedup at another path, twin frames, local fallback, differing content) and `ProjectStorageService.spec.ts` (coalescing, including a failing batch).
- **1.41 (2026-09-27):** **Flipbook clips are independent, and a character is a variant/state vocabulary.** Phase 0 of `.plans/asset-store-packs.md` (semantic Store packs), which starts from a runtime defect the plan's review confirmed by test: `SceneLoader.loadAnimatedSprite2DAsset` keyed every sequence frame texture by the frame's index *inside its clip*, merged across all clips, so `attack[0]` replaced `idle[0]` — of a resource with an idle of three frames and an attack of two, only three files were ever requested and idle rendered attack pixels. The editor viewport never showed it (its proxy holds the current frame's texture by path), which is why it survived: it is a play-mode and export defect, and the acceptance for anything flipbook-related is play mode / export, not the viewport. `AnimatedSprite2D` now keys frame textures by `texturePath` (`setFrameTexture(path, texture)`; a numeric index is still accepted and resolves through the ACTIVE clip only), and the loader loads each distinct path once. New **`AnimatedSprite2D.play(name?, { restart? })`** — the same shape as `SpineSkeleton2D.play`: `false` (nothing changes) for a clip the loaded resource lacks, no silent fallback to the first clip as writing `currentClip` still does; a different clip starts at frame 0 with a fresh play-clock; the current clip keeps its position unless `restart`, which is also what replays a finished one-shot (a second `attack` must begin at frame 0). Because the loader fetches the `.pix3anim` asynchronously and a component's `onStart` usually runs first, a name given before the resource arrives is accepted and resolved on load (an unknown one is warned about there). `getClipNames()` added. New **`core:CharacterVisual2D`** — `variant + state → clip` over the naming convention `<variant><separator><state>` (`sword.idle`; a clip without the separator is a variant-less state): `playState`, `setVariant` (keeps the state, restarts its clip), `getVariants`/`getStates`, and a `state-finished (state, variant)` signal on the host when the current one-shot ends. Deliberately Unity's Sprite Library + Sprite Resolver and not an AnimationTree: no movement, physics, AI or automatic transitions, and **no new file format** — the mapping IS the clip names and the chosen pair is the component's config in the prefab, so a Store character stays one prefab + one flipbook and `pix3 validate` already checks it (the plan's `.pix3character` descriptor was dropped in review for exactly that). **`compileCharacter`** (`src/services/library/character-compiler.ts`, pure, deterministic) turns grouped frame files into that shape — a managed sprite folder `sprites/<slug>/<slug>.pix3anim` + `<variant>_<state>_<nnnn>.png` and `prefabs/<Name>.pix3scene` — with `scanNumberedSequences` as the generic numeric-suffix grouping (gaps, duplicates and mixed sizes reported, never guessed); fps 12 and one-shot `attack`/`die` are proposals surfaced as warnings. Resource-graph walking got its one table: **`RESOURCE_GRAPH_EXTENSIONS`** (`src/core/asset-categories.ts` — scenes, prefabs, `.pix3anim`) now feeds publish-to-library (which recursed into scenes and scripts only, so a re-published character came back without its frames), playable export, insert-time remap and move-remap (which rewrote `.pix3scene` only, so moving a frame folder broke its flipbook). Guarded by the multi-clip and `play` cases in `AnimatedSprite2DAnimation.spec.ts`, `CharacterVisual2DBehavior.spec.ts`, `character-compiler.spec.ts`, and `character-compiler.headless.spec.ts`, which boots the compiled prefab through the real loader and drives idle → attack → attack (restart) → idle → die → variant switch with zero script errors.
- **1.40 (2026-09-15):** **Vibe's stage has an aspect picker.** The Vibe stage letterboxes the game rather than stretching it, but the shape it letterboxed to was fixed: the project's authored `viewportBaseSize`, with no way to ask "what would this look like on a phone turned sideways?" short of switching to Studio. The stage bar now carries a five-way segmented control — Project / 9:16 / 16:9 / 4:3 / Fill — sitting left of the run controls with its own gap, so a mis-click lands on another shape (harmless, reversible) rather than on Stop. It is a segmented control and not a dropdown because the whole use is flipping between two shapes and back while watching the game, which a menu that closes on every pick turns into a three-click loop. The setting is `appState.ui.flowStageAspect` (`UpdateEditorSettingsOperation`, persisted with the other editor settings, undoable) and is **deliberately not** `ui.gameAspectRatio`: the two differ in what "no opinion" means — Studio's default `free` fills the panel, Vibe's default `project` is the authored viewport — and one value cannot carry both defaults. Sharing it is what the stage's fit logic used to guard against by ignoring the Studio setting outright, since a `16:9-landscape` picked once in the Game tab would silently render a 1080x1920 game into a wide box with its anchored HUD out at the edges. That guard is now stated rather than implied: Vibe reads its own setting, so a non-default shape is always one the user picked and can see is picked.
- **1.39 (2026-09-12):** **Play mode can be paused.** `game.pause` (F7, Project menu) freezes the running game and lets it go again — a toggle, on the Game tab toolbar, the Vibe stage bar and the popout window, plus `__PIX3_DEBUG__.play.pause()`. The main editor toolbar deliberately keeps only Play/Stop: pause belongs where the game is on screen, and beside Play a resume triangle reads as a second way to start it — which is also why the button keeps a pause glyph in every surface and shows the held pause as an active state instead of flipping its icon. The plumbing was already there: `GamePlaySessionService.setPauseRequested` holds a *host* pause that, unlike a bare `runner.pause()`, survives focus and visibility events (the automatic `pauseRenderingOnUnfocus` freeze is the other input to the same decision, and either one holds the game). What was missing was the user-facing half. `appState.ui.playModeStatus` — declared as `'stopped' | 'playing' | 'paused'` and never once set to `'paused'` — now moves with the pause flag, and the sync hangs off `setPauseRequested` rather than off the command, so a pause nobody pressed (`game_run` freezing on its outcome frame, `GameInputService` releasing one) moves the buttons too. It is written by `SetPlayPausedOperation`, deliberately **commit-less**: a pause is a view onto the running game, not an edit to the project, and an undo that silently resumed it would be one nothing on screen explains. A stop or a restart always resumes — `detachRuntime` drops the host pause with the runner it belonged to, and a relaunch re-syncs the status, so the next scene never starts frozen for a reason the user cannot see. Engine side: `SceneRunner.pause()`/`resume()` now suspend and restore the `AudioContext` through a new `AudioService.setPaused`, because a frozen scene playing on over its own music reads as a hang, not as a pause. The mixer has two independent reasons to be silent (page activity, host pause) and comes back only when both are happy; suspending the context rather than stopping playbacks is what makes resume seamless, and `stop()` clears the flag so a stop-while-paused cannot leave the shared `AudioService` singleton mute for the editor's own audio previews.
- **1.38 (2026-09-10):** **A new project opens on the game, not on a GAME OVER card.** Every bundled template authored its full-screen UI inline in `scenes/main.pix3scene` — the scene the editor opens for every project it creates or reopens — hidden behind `initiallyVisible: false`. That flag is read by `SceneRunner.applyInitialVisibility` when **play mode starts**; the editor never reads it, so the editor drew the overlays: `playable-2d`/`playable-3d` opened onto a 65 % black TAP TO START dim with a 75 % END SCREEN dim stacked behind it, and all five `recipe-*` templates onto a 70 % dim with GAME OVER and a RETRY button. The first thing anyone did with their own game was hunt through the scene tree switching nodes off. Overlays now live one-per-file under **`scenes/ui/`** (`result.pix3scene`, `intro.pix3scene`, `end-screen.pix3scene`, and `minigame-2d`'s `settings-window.pix3scene`, moved out of `scenes/`), and the host scene carries each as a one-line `instance:` marked **`visible: false`** — an *editor-only* hide applied by `NodeBase` at load, which `applyInitialVisibility` overrides from the overlay file's own `initiallyVisible` the moment play begins (`true` for the playables' tap gate, which must be up at t=0 because the first tap is what unlocks browser audio in an ad container; `false` for a result card a script reveals). Nothing else moved: prefab-instance children keep their authored ids when unique, so every `resultLabel: result-label` / `retryButton: retry-button` / `cta-button` config keeps resolving and no template script changed. The overlay is now editable full-screen in its own tab (right-click → Open Prefab), and ticking the eye in `main.pix3scene` previews it composited. `ProjectBuildService.isPrefabPath` treats `scenes/ui/` like `prefabs/`: still embedded in exports as an asset, but out of the navigable scene manifest and the entry-scene picker, because booting a build into a result card is never what anyone means. HUD widgets (`score-label`, `time-label`, `lives-bar`, `menu-button`) deliberately stay in `main.pix3scene` — they are gameplay feedback and they cover nothing. The convention is documented for project agents in `src/templates/agent/AGENTS.md` (rule 3) and enforced four ways: `recipes.spec.ts` fails on a `scenes/ui/` instance without `visible: false`, on an inline translucent full-viewport `ColorRect2D` in `main.pix3scene`, and on an overlay file nothing instances; `ProjectTemplateScenes.spec.ts` loads `main.pix3scene` through the real `SceneLoader` and fails if anything sourced from `scenes/ui/` comes back `isVisibleInTree()`.
- **1.37 (2026-09-06):** **The kit's typography reaches the game, and a container can stack its children.** Two more things were fixed while closing the track. The manifest's nine-slice insets are now the GENERATOR's own numbers scaled, not a re-derivation from the theme: `buildSkin` knows which shape it drew and answers a recess or a fill (`slot`, `slider-track`, `bar-trough`, `bar-fill`) with the arithmetic those are actually painted with, and re-deriving threw that away — a 240x36 trough got insets that met in the middle, so `Bar2D` squashed it. Pixel read-back is now an opt-in check (`verifyPixels`) instead of a decode per part, and the bake rasterizes in batches of eight (deterministic manifest order, results written by index): **104 sprites in ~2.6 s where the sequential loop took 20-30 s**, with the elapsed time reported in the result and shown in the panel. Three gaps made a generated dialog look nothing like the page that designed it. (1) **Captions had no recipe.** The art carries no text by design, but nothing carried the *face* either, so every prefab node fell back to `UIControl2D`'s defaults — 16 px Arial, no outline — beside a kit drawn in a display face at `height × 0.38` with a sticker edge. `TemplateSpec` now derives a `fontSize` per captioned node from its own element height (button `× 0.38`, header title `× 0.44`, settings row `× 0.5` of the row) and carries a `typography` block (primary + Cyrillic family, each at its OWN weight — a CSS stack has one, and the Latin display faces are 400 — plus outline width/colour, drop shadow, tracking, ink); `design/ui-kit.json` records the same block, so applying a kit is a lookup and not a re-render. `UIControl2D` gained the properties to receive it (`labelFontWeight`, `labelOutlineWidth/Color`, `labelShadowColor`, `labelShadowOffsetX/Y`, `labelLetterSpacing`), painted through a new shared `core/styled-text.ts` that `Label2D` uses too, so a label and a button caption of one kit cannot drift. A size is written only onto a node still on the default, so a hand-set caption survives a re-skin. (2) **A family name is not a font.** New `ProjectManifest.fonts` (`{family, path, weight, style, unicodeRange}`) plus `core/ProjectFontLoader.ts`, which registers the faces as `FontFace`s and is **awaited before the first frame** — same argument as the localization seed, since a face that lands late repaints every caption and a paused session freezes on the wrong one. It runs in play mode, on project open in the editor (the viewport draws its own canvas text), and at boot in an export, where the font files are reachability roots (`project-font`) and the list is baked into the generated scene manifest. The bake downloads the theme's faces into `fonts/` and merges them into `pix3project.yaml` by family+weight+style; failures are warnings, never errors. (3) **A column had to be authored by hand.** `Node2D` gained `flow` — `{enabled, direction, gap, paddingX, paddingY, align, autoSize}`, serialized next to `layout`, inspector group "Flow" — which stacks a container's children in tree order along the main axis while each child's anchor keeps the cross axis. The settings template's rows now live in such a container, so an added row lands in the column. This is not a return of the `Layout2D` node: the config sits on the container that already exists, exactly as the anchor config does. Also fixed along the way: the editor's own viewport proxy built its canvas font as `` `${size}px ${family}` ``, which is invalid CSS for a family with a space (`Baloo 2`) — the assignment was dropped and the proxy silently measured and drew in the default face, so a skinned dialog wrapped its captions in the editor while the runtime laid them out correctly; it now shares `cssFont`/`drawStyledText` with the runtime and draws the outline and drop shadow as well. The proxy also draws the sub-sprites it used to omit — a bar's fill, a slider's fill and thumb, a checkbox's mark — so the editor and play mode agree on the same scene.
- **1.30 (2026-08-02):** **Unified Sprite Editor** — the flipbook animation panel (`pix3-animation-panel`, `src/ui/animation-editor/`) is retired and the Sprite Editor (`pix3-sprite-editor-panel`) is now the single surface for both a bare image and a `.pix3anim` (plan `.plans/done/sprite-editor-design.md` §9, commits C1–C8). Layout: toolbar (select / frame tools / crop / rotate / flip / Generate… / background removal / slice / zoom / save) over **clips rail | canvas**, with the **frame timeline** as a full-width band underneath — the clips rail, timeline and stage overlays are standalone components (`<pix3-sprite-clips-rail>`, `<pix3-sprite-timeline>`, `frame-stage-overlays.ts`) and the whole document (clips, frames, selection, transport, every mutation) lives in `AnimationDocumentController`, which the shell owns one of and registers with `AnimationEditorService` so the Inspector keeps rendering against a service, never a component. **Frame ↔ canvas:** selecting a frame binds the one canvas to that frame’s texture, and crop / rotate / flip / background-removal / generated images are written **back** into the frame as a new `<clip>_<nnnn>.png` (undo restores metadata pointing at untouched pixels) with the cache fan-out that follows — texture preview cache, `AssetLoader.evictTexture`, `Viewport2DProxyRegistry.invalidateTexture` + `requestRender()`. **Generation moved out** into `<pix3-generate-panel>` (dockable Golden Layout panel titled “Generate”, `editor.open-generate-panel`, reachable from View or the shell’s “Generate…” action): prompt, references, model/aspect/key chrome and the generation history now outlive any one editor tab, and the shell mediates through `ImageEditTargetService` (the shell registers as the active `ImageEditTarget`; with no target the panel is the standalone asset generator it always was). Both surfaces share `StageZoomPanController`’s canonical zoom/pan model (content anchored top-left, pan the sole offset, content sized `size × zoom`). **Tabs:** the `animation` tab *type* is unchanged — ids stay `:`, `animation:res://…` entries in stored sessions still restore — it simply mounts the shell now; a restored tab reopens on the clip **and frame** its `contextState` recorded (`selectedFrameIndex` was persisted but previously ignored on load). Dead `panelVisibility.animation` removed.
- **1.29 (2026-08-02):** Sprite Editor phases 2–4 plus the runtime frame-presentation track (`.plans/done/sprite-editor-design.md`). **Shared slicing:** spritesheet cell extraction is now the pure `sliceImageBlob` in `services/image-gen/image-ops.ts` (so agent `generate_asset` post-processing gets it too); the animation panel keeps only naming + writing, and the auto-slice dialog was generalised from clip-specific copy to a `contextLabel`/caption/confirm-copy contract shared by both surfaces. **Sprite Editor** gained "Slice into frames" (cells into `<name>_frames/`) and "Create animation" — the latter builds a **managed sprite folder** (`<dir>/<stem>/<stem>.pix3anim` + `<clip>_<nnnn>.png`, the project convention) via the new `CreateAnimationAssetCommand` and opens the animation editor on it. `buildAnimationFrameResourcePath` gained a clip name, killing a real bug: two clips sliced into one folder used to overwrite each other's `frame_NNNN.png`. OS image files dropped on the animation editor are copied in by the same convention, and dropping on a frame card inserts before it. **Runtime R1 — frame presentation:** `AnimationFrame.anchor` existed and was editable but the runtime never applied it, so every frame was stretched to the node box and cropped frames of differing sizes could not align. `AnimatedSprite2D` gains `anchor` (node pivot, `Sprite2D` semantics) and `sizeMode: 'stretch' | 'native'` (default `stretch` — existing scenes render byte-identically; the editor creates new nodes as `native`), and `AnimationFrame.sourceSize` is stamped by the editor on add/import/slice so native layout never waits on a load. The composition math is one shared pure module (`core/animated-sprite-layout.ts`) applied by both the runtime node and `Viewport2DProxyRegistry`, because the editor draws separate proxy meshes. **Runtime R2 — named frame points:** additive `AnimationFrame.points` (`{name,x,y,angle?}`, frame space, y from the top) with `getFramePoint`/`getFramePointWorld`/`getClipPointNames` and the `core:PointAttachment` component (parks a child on a parent sprite's named socket every tick); authored in a new **points** mode on the animation stage (drag dot / drag angle handle, previous-frame onion-skin ghosts, per-clip add/rename/copy/remove). **Entry points:** `OpenSpriteEditorForNodeCommand` — double-click a sprite node in the viewport (drill-until-leaf-*then*-open, so the Figma scope model is preserved), in the scene tree (prefab still wins), or a texture property in the inspector. **Assets:** a managed sprite folder now renders as ONE card (film icon, frame-count badge, the `.pix3anim`'s own path so preview/drag/double-click/inspector binding all work unchanged), with "Show Files" to descend and a header toggle (persisted, on by default). Shared `StageZoomPanController` (`ui/shared/stage-zoom-pan.ts`) gives the animation stage wheel-zoom-to-cursor and panning. **Not done** (see the plan): the Construct-3 single-canvas shell (§8.3 phases 3b/3c — decomposing the animation panel into controller/timeline/clips-rail and hosting them around one canvas) and the generation "place mode" (§8.6), which depends on it.
- **1.5 (2025-09-26):** Added target platforms, non-functional requirements, detailed architecture contracts, validation rules, and roadmap updates. Synced guidance on `fw` helpers.
- **1.7 (2025-10-01):** Removed PixiJS dual-engine plan; consolidated rendering to single Three.js pipeline (perspective + orthographic). Updated project structure, removed obsolete adapter references, clarified rendering notes.
- **1.8 (2025-10-05):** Adopted operations-first model. Commands are thin wrappers that delegate to `OperationService`. UI invokes operations directly. Code organized into `core/features/*/{commands,operations}`. Deprecated `CommandOperationAdapter` in documentation.
- **1.9 (2025-10-27):** Updated to reflect current architecture where Nodes are NOT in reactive state. Nodes are managed by SceneManager in SceneGraph objects. State contains only UI, scenes metadata, and selection IDs. CommandDispatcher Service is the primary entry point for all actions. Updated project structure section to annotate (non-reactive) for nodes and clarify state boundaries. Enhanced implementation status with current feature list.
- **1.10 (2025-12-30):** Added comprehensive Property Schema System section (5.0-5.5). Updated technology stack to include Pixi.js v8 for 2D rendering alongside Three.js. Added LoggingService and FileWatchService to architecture. Updated feature list to reflect all implemented commands/operations. Added vector4 property type. Updated MVP plan and roadmap to reflect completed milestones. Added format:check script to project scripts.
- **1.11 (2025-12-30):** Removed Pixi.js from technology stack. Updated to Three.js-only rendering pipeline. Removed Pixi.js references from architecture notes and rendering architecture sections. Updated MVP plan to remove 2D rendering requirements via Pixi.js. Added details about the Icon Service under the Services section.
- **1.12 (2026-01-01):** Added Script Component System section (6.0-6.11). Implemented behaviors and controller scripts attachments in inspector. Nodes now support `behaviors` array and optional `controller`. Added ScriptRegistry service for registering script types. Added BehaviorPickerService for modal dialog. Added ScriptExecutionService for game loop and script lifecycle management. Added commands for Attach/DetachBehavior, Set/ClearController, ToggleScriptEnabled, PlayScene, StopScene. Updated inspector panel to display "Scripts & Behaviors" section. Updated scene tree to show script indicators. Updated project structure to include `behaviors/` directory and `features/scripts/`. Added example RotateBehavior implementation. Updated node lifecycle with `tick(dt)` method for script updates.
- **1.13 (2026-02-03):** Added Layout2D Node System section (6.5). Implemented Layout2D node class in `packages/runtime/src/nodes/2D/Layout2D.ts` with properties for width, height, resolutionPreset, and showViewportOutline. Added Layout2D YAML parsing support in SceneLoader with Layout2DProperties interface. Modified SceneManager to add `skipLayout2D` parameter to `resizeRoot()` and `findLayout2D()` helper method. Created CreateLayout2DCommand/Operation and UpdateLayout2DSizeCommand/Operation for mutation support. Updated ViewportRenderService with `layout2dVisuals` map, `createLayout2DVisual()` method (purple dashed border), and Layout2D handling in processNodeForRendering, syncAll2DVisuals, updateNodeTransform, and updateNodeVisibility. Removed isViewportContainer property from Group2D and all related logic. Updated startup scene template to use Layout2D root instead of Group2D. Layout2D size is now independent of editor viewport and only changeable via inspector properties.
- **1.14 (2026-02-23):** Added project autoload manifest support (`pix3project.yaml`) with editor commands/operations for add/remove/toggle/reorder. Added node-local signal and group APIs, scene group serialization, and inspector group editing UI. Added Asset Browser create action `Create autoload script` that scaffolds a template script in `scripts/`, compiles scripts, and auto-registers the singleton in project autoloads.
- **1.15 (2026-02-26):** Added Node Prefabs System section (6.15). Prefabs are `.pix3scene` files instanced via `instance:` YAML key. Added PrefabMetadata interface stored in node metadata with localId, effectiveLocalId, instanceRootId, sourcePath, and basePropertiesByLocalId. Added prefab-utils.ts with getPrefabMetadata, isPrefabNode, isPrefabInstanceRoot, isPrefabChildNode, and findPrefabInstanceRoot helpers. Implemented CreatePrefabInstanceOperation, SaveAsPrefabOperation, and RefreshPrefabInstancesOperation. Added corresponding commands. Inspector shows base prefab values with revert override capability. Scene tree displays prefab badges. FileWatchService triggers auto-refresh when prefab files change.
- **1.16 (2026-07-04):** Added Keyframe Animation System section (6.16). New runtime module `packages/runtime/src/animation/` (easing curves, JSON keyframe clip model with defensive normalization, pure clip evaluator, `AnimationPlayerBehavior` registered as `core:AnimationPlayer`). Clips serialize inside the component `config`; tracks target nodes by relative name paths (prefab-safe). New bottom-docked Animation timeline panel (`animation-timeline`) with clip management, property/audio tracks, keyframe drag with snap and coalesced undo, per-key easing, and a scrub/playback preview service (`AnimationTimelinePreviewService`) that snapshots and restores node state without dirtying the scene, guarded against saves, undo/redo, and play-mode start.
- **1.17 (2026-07-12):** Added Project Templates, Target Platform and Agent Overlay section (6.11.5). Two-step New Project wizard with a bundled template catalog (`packages/create-pix3/templates/`, served by `ProjectTemplateService`); five v1 templates (empty-2d/3d, playable-2d/3d with tap-to-start + CTA, minigame-2d with a settings-window prefab). Manifest extended with `projectType`, `targetPlatform` and `quality` (applied in play mode and exported builds via the generated `runtimeQuality`). Runtime gains the Playable SDK shim (`playable.openStore`/`gameEnd`, MRAID-aware). New projects receive a `design/` folder, `AGENTS.md`/`CLAUDE.md` and bundled agent skills (`src/templates/agent/`). Editor is installable as a PWA via `vite-plugin-pwa`. Full rapid-prototyping design (remote preview relay, agent HTTP API) recorded in `.plans/done/rapid-prototyping-design.md`.
- **1.18 (2026-07-12):** Added Remote Preview (live relay) and the Agent HTTP API. Collab server gains anonymous token-gated preview sessions (`POST /api/preview/sessions`) and a dumb WebSocket relay on `/preview` (JSON messages + length-prefixed binary frames; caches the latest session-config/script-bundle for late joiners; ring buffers for logs/metrics/last screenshot). New standalone player entry (`player.html` + `src/player/`) runs scenes on `@pix3/runtime` with a `RemoteResourceManager` that streams `res://` files from the editor host with sha-256 revalidation and Cache API persistence; reports console logs, 1s frame-stat aggregates and JPEG screenshots back. Editor gains `PreviewHostService` + `project.start-remote-preview` command with a QR/join-link dialog; saves push `scene-updated` automatically and `.pix3/preview-session.json` is written for agent discovery. Agent HTTP API: `GET /sessions/:id` (+`/logs?since`, `/metrics`, `/screenshot?fresh=true`) and `POST /sessions/:id/commands` (restart, reload-from-disk, screenshot, set-property, snapshot, inspect, game-action with peer acks); the `pix3-remote-preview` project skill documents the curl workflow. Export gains a zip variant (`project.export-playable-zip`, index.html + plain asset files via jszip); runtime builds now use a relative resource base. Playable SDK extended with DAPI `openStoreUrl()` CTA support and viewport helpers (`getViewport`/`getOrientation`/`onResize` incl. MRAID `sizeChange`/DAPI `adResized`).
- **1.20 (2026-07-12):** Added the Asset Library (Phase 1 / MVP) — a catalog of reusable, standard and personal assets available across projects. One `LibraryItem` model (`item.json` manifest: id/slug/name/type/tags/entry/files/license) with three storage scopes behind a common `LibraryProvider` interface: `builtin` (read-only, `public/library/index.json` + bundles served over HTTP), `user` (personal, editor-level — OPFS files under `pix3-user-library/<itemId>/` + IndexedDB manifest index, survives project switches), and `team` (collab-server, Phase 2). `AssetLibraryService` aggregates providers, holds the search index (name+tags+type+scope) and routes bundle reads/writes; item data is intentionally NOT in `appState` (only panel-local filter/selection UI state is). New dockable **Library** panel (`src/ui/asset-library/`, card grid + scope/type filters + text search + context menu) tabbed with the Asset Browser. Insertion is a *snapshot copy* (not a live link): `LibraryInsertService` copies a bundle under `res://assets/library/<slug>/`, remaps `res://` references, deduplicates re-inserts, then dispatches the existing `CreatePrefabInstanceCommand`/`CreateSprite2DCommand` (so undo removes the node while copied files remain, as with any import). Drag from a card into the viewport/scene tree via the new `application/x-pix3-library-item` MIME. `PublishToLibraryService` + `library.publish-node` command pack a selected node/subtree into a personal item (serialize subtree, collect `res://` dependencies recursively incl. nested prefabs, copy into the bundle). Asset Generator gains a **Save to Library** action. Bundled minimal builtin pack (`Library Sprite` prefab, `Rounded Panel` image). Phase 2 (team scope + agent HTTP/preview commands) and Phase 3 (versioning, render previews, bulk import) remain per `.plans/asset-library.md`.
- **1.21 (2026-07-18):** Renamed the **Asset Generator** editor tab to the **Sprite Editor** (Phase 1). It is still the surface for editing images (crop, background removal, rotate/flip, resize) and AI generation; only user-facing naming and the entry points changed. Internal tab-type id migrated `asset-generator` → `sprite-editor` (asset-generator tabs were never session-persisted, so the migration is side-effect-free; a legacy drop-filter for `asset-generator` is kept on session restore). Component `pix3-asset-generator-panel` → `pix3-sprite-editor-panel` (`src/ui/sprite-editor/`), command `editor.open-asset-generator` → `editor.open-sprite-editor` (palette keeps legacy "asset generator" keywords), menu/title/context-menu strings updated. **Double-clicking an image asset now opens it in the Sprite Editor** (matching scene/animation/code activation) instead of creating a `Sprite2D` node; node creation moved to an explicit **"Add to Scene as Sprite2D"** entry on the Assets Preview context menu (drag-to-viewport/tree unchanged). Fixed a bug in `AssetFileActivationService.SUPPORTED_IMAGE_EXTENSIONS` (listed `webm`/`aif` — video/audio — now the real web image set: png/jpg/jpeg/gif/webp/bmp/svg/tif/tiff/avif). The flipbook animation tab was retitled **"Sprite Animation"** to end its display-title collision with the keyframe **Animation** timeline. Phases 2 (shared spritesheet slicing + "Create Animation from image" linkage) and 3 (Construct-3-style shell hosting Image/Animation modes) are designed in `.plans/done/sprite-editor-design.md`.
- **1.23 (2026-07-19):** Localization key extraction + rename (6.17.3): `LocalizationExtractionService` + `ExtractLocalizationKeysCommand`/`Operation` — panel **Scan** finds unlocalized scene `label:` literals (per-item Extract → default-locale key + `labelKey` bind) and script-literal keys missing from the default table (per-item Add), then seeds missing keys into non-default locales as `""` placeholders (undoable). `RenameLocalizationKeyCommand`/`Operation` — rename across all locale tables + rewrite `labelKey`/`textureKey`-family references in open scenes, one undo step. Runtime: empty table entries now count as untranslated and fall through the fallback chain (6.17.1).
- **1.22 (2026-07-19):** Added Localization (i18n) section (6.17). Per-locale JSON tables (`locales/<id>.json`: `$meta` + `strings` + `sprites`) with a never-throwing fallback chain; runtime `LocalizationService` + globalThis active-instance pointer (editor preview vs isolated play-mode instance, seeded with the preview locale); `UIControl2D.labelKey` / `Label2D.setTextKey` for text and `Sprite2D.textureKey` / `Button2D.stateTextureKeys` for localized sprite skins (authored values stay as fallback); shared `applyLocaleToTree` locale-change walk repaints labels and reloads keyed textures in both play mode and the editor viewport proxies. Editor: `LocalizationEditorService` (auto-discovery, write-through persistence, `appState.localization` mirror), Localization panel (Strings/Sprites tabs, missing-translation view, preview-locale switch), `localization-key` inspector widget with autocomplete + Extract, full Command/Operation set under `src/features/localization/`. Export: `collectAssetPaths` ships locale tables + their sprite textures; generated `scene-manifest.ts` bakes `runtimeLocalization` and the bootstrap boots in `defaultLocale`. Scripts: `this.scene.localization`. Adds `trPlural` (Intl.PluralRules suffix keys) and awaits the seed table before the first play frame (no key flash). Reference migration: SkyDefender (mission names, briefings m1–3 + epilogues, goals, HUD/map/shop UI as keys; `locales/en.json` + `ru.json`).
- **1.25 (2026-07-23):** Added the Model Lab **Scene lane** — generates whole `.pix3scene` **levels** from a text brief (a lane switch in the Model Lab panel; reuses the model lane's pass/review machinery). Pipeline (`src/services/model-gen/scene/`): `SceneInventoryService` scans the project for usable models/prefabs/textures → `LevelSpec` codegen (zones + lighting/camera intent + flagged `paletteGaps`, validated) → locked passes (layout → placement → dressing → lighting → polish; edit runs use dressing → lighting → polish) emitting whole-file declarative `.pix3scene` YAML. The validation gate is `SceneManager.parseScene` PLUS `scene-validate` (an allow-list of runtime node `type`s and a `res://`-ref existence check, since parseScene tolerates unknown types and missing refs). Valid YAML is previewed as a live runtime scene (`NodeBase extends THREE.Object3D`, so parsed roots render directly — no SceneRunner) from a top-down orthographic + 3/4 perspective view (`ScenePreviewRenderer`), composited (`buildImageStrip`) and vision-reviewed against the brief with the same autonomous/manual-gate self-correction as the model lane. Depth features: **editing an existing scene** (`baseScenePath` seeds the pass loop), a deterministic **scatter expander** (`type: Scatter` authoring-sugar node → seeded mulberry32 node clusters, expanded before the gate so it never persists), and **palette-gap → model-lane handoff** (`LevelSpec.paletteGaps` surfaced in the panel with a one-click prompt into the model lane). Output saves via `writeTextFile` and opens as a normal scene tab (`EditorTabService.focusOrOpenScene`). Headless: agent tool `generate_scene_3d` and `__PIX3_DEBUG__.scene3d` (debug bridge v7). Node-ops patch editing (incremental large-scene edits) is deliberately deferred; passes regenerate whole-file YAML. Plan: `.plans/done/model-lab-3d-generator.md`.
- **1.24 (2026-07-23):** Added Model Lab — an in-editor 3D asset generator that reconstructs hard-surface models **procedurally by code** from a reference image (img2threejs-style; not neural image-to-mesh). Pipeline (`src/services/model-gen/`): vision assess → `SculptSpec` (+ deterministic validator) → locked build passes (blockout → structure → form → material → lighting → optimization; `fast` mode collapses to blockout + form-material) where each pass's `createModel(THREE): THREE.Group` factory is compiled via `ScriptCompilerService` (esbuild → blob import; Mesh*Standard*/*Physical* only, no `ShaderMaterial`), rendered offscreen (`ModelPreviewRenderer`, screenshots a clone so the panel keeps the original), composited against the reference (`ComparisonSheet`), and vision-scored with `continue`/`refine-code`/`refine-spec`/`stop` self-correction (autonomous, or a `pauseForReview` manual gate: Accept/Retry/Stop). Output is a self-contained `.glb` via `Model3DExportService` (+ optional `.sculpt.json`/`.factory.ts` siblings for re-editing), added to a scene as a `MeshInstance`. Two-tab **Model Lab** panel (`src/ui/model-lab/`): Generate (reference drop/paste/pick, prompt, complexity, live preview hot-swap, pass monitor + comparison sheets, IndexedDB job history via `Model3DGenHistoryService` with Open/Regenerate-from-spec) and Settings (codegen + vision model pickers, reasoning effort, score threshold, iterations, save folder). Headless surfaces: agent tool `generate_model_3d` (`AgentToolRegistry`) and `window.__PIX3_DEBUG__.model3d` (debug bridge v6). Objects only — character/organic reconstruction is deferred. Plan: `.plans/done/model-lab-3d-generator.md`.
- **1.19 (2026-07-12):** Remote Preview device telemetry in the editor. The QR/join-link modal was replaced by an in-Game-tab session card (`pix3-remote-preview-card`, rendered by `pix3-game-tab` while a preview session is active): QR, join link, relay status and a live device strip; `project.start-remote-preview` opens the Game tab and brings the Profiler and Logs panels forward; closing the Game tab stops the session. Players now report a one-shot `device-info` message (UA, GPU via `WEBGL_debug_renderer_info`, screen/viewport, deviceMemory, cores; re-sent on host reconnect, stored per client on the relay and exposed in session status `players[]`) and extended 1s metrics (`maxFrameMs`, `longFrameCount` >33ms hitches, `jsHeapUsedMb`); player log forwarding is rate-limited (25/500ms window with a drop counter). New `RemotePreviewTelemetryService` keys metrics/logs/status by relay clientId, derives human device labels from UA, and mirrors remote logs into `LoggingService` with a `source` tag; the Logs panel gains a source chip + source filter, and the Profiler panel gains a metrics-source switcher (Editor vs each remote device, auto-selects a live device when local play is idle) rendering 1Hz history charts, a Device section (GPU/screen/memory/cores/status) and spike rows instead of the local-only audio/frame-impact sections.
- **1.27 (2026-07-25):** Documented **Group2D sizing** (§6.15, replacing the removed `Layout2D` section and its stale `child.updateLayout(...)` cascade) and completed the feature: **Fit to Contents** (`FitGroup2DToContentsCommand`/`Operation` — inspector button, **Edit → Fit Group to Contents**, `Mod+Alt+F`; the command now falls back to the primary selection so the menu/keybinding work, and its preconditions disable it for a non-Group2D or childless selection) and **Figma-style proportional child resize** (gizmo + `ResizeGroup2DCommand`). New: `GroupSelectedNodesOperation` creates a Group2D **pre-sized/pre-positioned to the selection's bounds** in the new group's parent frame (`computeUnionLocalRect` + `sizeGroupToRect`; `attach()` then preserves the children's world transforms) instead of a fixed 100×100 box; **Ctrl/Cmd while dragging a resize handle** resizes the box only (`Transform2DUpdateOptions.resizeBoxOnly` — children are reapplied from the drag-start base states with factors of 1, so the modifier is lossless in both directions mid-drag and box-only children drop out of the commit). Specs added for both operations, the fit command, the group-creation sizing and the box-only modifier. Deliberately not implemented (see `.plans/done/group2d-autosize-resize-design.md` §7): a reactive auto-size flag and promoting the planner into the runtime as `Group2D.scaleContents`.
- **1.26 (2026-07-25):** Added the `SpineSkeleton2D` node — Spine skeletal animation in the 2D layer (see §7.2.1 for the YAML shape and `docs/node-types-reference.md` → `### SpineSkeleton2D` for the full property/API table). Runtime: `core/spine/` holds the module contract (`spine-module.ts`, a hand-declared structural subset so `@esotericsoftware/spine-threejs` stays an OPTIONAL dependency injected by the host via `setSpineModuleLoader`), the shared asset loader/cache (`SpineAsset.ts`, `AssetLoader.loadSpineAsset` — pages load as standalone textures, bypassing the pre-launch atlas, and `parseSpineAtlasPageNames` exposes page names to tooling), and `SpineSkeletonView.ts` (one renderable skeleton configured for the 2D pass: `depthTest/Write: false` materials, `zOffset: 0`, tint/alpha through spine's skeleton color, play/queue/stop/skin/mix helpers). The node exposes `play`/`queue`/`stop`/`pause`/`resume`/`setSkin`/`setMix`/`setTimeScale` plus `animation-started`/`animation-finished`/`animation-looped`/`spine-event` signals, `freeOnFinish` for one-shot VFX, and a per-instance property schema that turns `animation`/`skin` into dropdowns of the loaded skeleton's real names (an instance property now REPLACES the same-named static one in `getNodePropertySchema` instead of appending a duplicate row). Editor playback is opt-in — the Inspector's Editor Preview row toggles `previewInEditor` and its Reset rewinds to the first frame as transient, non-undoable pose state (`resetToFirstFrame`). Editor: the same `SpineSkeletonView` backs a new viewport proxy (`spineSkeleton2DVisuals`, placeholder frame until the asset resolves, setup-pose AABB for selection/framing, per-frame layer re-stamping because spine adds batch meshes lazily), `previewInEditor` animates through the preview ticker, and `CreateSpineSkeleton2DCommand`/`Operation` register in the node palette and the agent create-node registry. New generic inspector editor kind `file-resource` (+ `ui.extensions`) for picking project files by extension. Export/tooling: the build model carries `usesSpine` (a scene/prefab scan for `type: SpineSkeleton2D`) and emits `src/generated/spine-runtime.ts` behind the new `virtual:runtime-spine` module — a STATIC import of the Spine runtime for projects that use it (a dynamic one would become a chunk the single-file HTML export cannot fetch), empty otherwise; the playable bundler vendors `spine-threejs`'s prebuilt ESM alongside three/yaml/rapier, and the generated npm project gets the dependency plus a resolve alias. `ProjectBuildService` embeds atlas page images, `TextureAtlasService` excludes them from packing, and `.atlas`/`.skel` join the asset taxonomies.
- **1.28 (2026-07-26):** Added the curated **Asset Store** — the `Pix3 Store` library source is no longer a decorative static pack but a server-backed catalog that admins fill from the editor (`.plans/asset-store-admin.md`). **Server** (`packages/pix3-collab-server/src/core/library/store-router.ts`, mounted at `/api/library/store`): the same bundle storage as the private library router with public reads (`attachOptionalAuth` — anonymous visitors get `published` items only, an admin additionally sees `draft`/`unlisted`) and `requireAdmin` writes; endpoints for listing/filtering (`q`, `category`, `type`, `status`, `sort=updated|downloads|featured`), single-item reads, bundle-file downloads (`resolveSafePath`), a download ping (one per materialized bundle, never per file), multipart upload/replace, metadata `PATCH`, hard delete, two-level category CRUD and an audit trail. Items live at `visibility='public'` with server-owned columns (`status`, `category_path`, `featured`, `downloads`, `published_at`) plus `library_categories` and `library_audit_log`; the migration rebuilds the old `CHECK(visibility IN ('private','team'))` and adds columns idempotently. `publisherId` is stamped from the session, never trusted from the upload. **Publish gate** (`store-validation.ts`, duplicated editor-side on purpose): name, `categoryPath`, description, whitelisted license (`OFL-1.1`, `CC0-1.0`, `MIT`, `CC-BY-4.0`), preview and ≥1 tag; a failing publish is rejected with the checklist, which the Inspector and upload dialog render field-by-field. **Manifest** gained optional store fields (`status`, `categoryPath`, `version`, `changelog`, `gallery`, `publisherId`/`publisherName`, `downloads`, `featured`) — pre-store manifests stay valid. **Editor**: new `StoreLibraryProvider` (scope `store`) merges the server index over the bundled `public/library/` pack by id (server wins), so an unreachable server silently degrades to the pack instead of an error; writes go through `AssetLibraryService` delegates. `canEditSource(source, { isAdmin })` replaced the config-only `editable` flag, so admin chrome appears and disappears with sign-in. The panel renders the server taxonomy in the rail with subcategory chips, status chips (`draft`/`unlisted`/`featured`), a category editor (`store-category-editor.ts`; deleting a category re-homes its items server-side), and the Inspector gains a curation block (status pipeline, featured toggle, editable name/description/tags/license/category, gallery, read-only version+changelog, delete). `PublishToStoreCommand` publishes the selected node straight into the store as a draft. **OS ingest**: `StoreUploadService` turns a drag from the desktop (or the `New Store item…` file/folder pickers — the automation-friendly path, since an OS drag cannot be synthesized) into staged bundles — a top-level folder is one bundle, a lone file is a one-file bundle, a `.zip` is a folder, an authored `item.json` is honoured *including its id* so a re-drop updates rather than duplicates — and uploads them over `XMLHttpRequest` for real progress and cancellation, reporting per-bundle outcomes; the same plan feeds OS drops into the personal library (no dialog — it has no taxonomy or gate). **Seeding**: an admin action pushes the bundled starter pack into the catalog under a `Starter Pack` category (`store-seed.ts`), normalizing bare license ids to their SPDX form, preserving any curation an earlier seed produced and downgrading anything that fails the gate to a draft — safe to re-run because pack ids are stable. The collab admin panel gained a **Журнал стора** tab over `GET /audit` (actor joined by username, paged). Read access is public and cookie-free, so an agent can `curl` the catalog without a running editor. Deferred to Phase E: item versioning with "update available" markers, collection packs, an OPFS bundle cache and CDN delivery.
- **1.31 (2026-08-13):** **Playable-export size** — measured, then cut (plan `.plans/done/playable-export-size.md`, report `.plans/done/playable-export-size-report.md`). A pinball export weighed 1.34 MiB, of which 1.22 MiB was code: 550 KiB three.js (its floor is 491 KiB for anything touching `WebGLRenderer`, so tree-shaking cannot help there), 212 KiB of node types, 96 KiB of `yaml`, 65 KiB of behaviours, 59 KiB of multiplayer, 43 KiB of GLTFLoader. Four changes. **(1) Compression:** `PlayableHtmlBuildOptions.compress` (checkbox in the export dialog, on by default, absent for the zip export) gzips the bundle with `CompressionStream` and ships it as base64 plus a `DecompressionStream` bootstrap that injects the code as a classic `<script>`'s `textContent` — not a blob/`data:`/`eval` path, because playables run in sandboxed and opaque-origin containers where those are refused; `VirtualBundleOptions.format` gained `iife` for it. It halves the *file* and is therefore wrong wherever the channel already gzips (hosting, our publish flow, a network measuring the zip), which is why it is a per-export choice. **(2) Player bootstrap:** the runtime entry now boots through `SceneRunner.loadAndStartScene` instead of `startScene`, which cloned the entry scene by serializing it to YAML and re-parsing it — a player parsed every scene twice and dragged `SceneSaver` plus `yaml.stringify` in for a clone nothing read. `SceneManager`'s `sceneSaver` is now optional (type-only import; `serializeScene` throws a named error without one), and that removal is what unpins the node classes SceneSaver imports for serialization. **(3) Conditional bundling**, driven by `RuntimeProjectBuildModel.mentionedNames` — every identifier in the shipped scenes/prefabs and project scripts, a deliberate superset: scenes and prefabs are rewritten as JSON and `yaml` is aliased to a `JSON.parse` shim (abandoned wholesale, with a warning, if any file holds something JSON cannot represent — `.inf` becoming `null`, an `!!timestamp` Date — or if a project script imports `yaml` itself); GLTFLoader is aliased to a throwing stub unless a `.glb`/`.gltf` ships or a script names it; unused node types and `core:` behaviours are served as throwing stubs with identical export names (`src/services/export/strippable-runtime-modules.ts`, whose table is guarded against runtime drift by a spec that recomputes the value-import graph from disk); multiplayer moved behind the generated `virtual:runtime-network` module (spine's pattern), so single-player exports ship none of `src/net/**`. **(4) `postprocessing` bug fixed:** the export left `import('postprocessing')` as an unresolvable bare specifier (the compiler externalises any non-aliased bare specifier and the single-file HTML has no import map), so `PostProcess` nodes silently never turned on, and the generated npm project did not even list the dependency. It now registers through the new `setPostprocessingModuleLoader` seam from a generated `virtual:runtime-postprocessing` module, vendored only when a scene places the node. Result for that pinball: 1226 → 885 KiB of code, and ~0.42 MiB of HTML with compression (−69%). The size report gained the compressed/saved/stripped lines. Deferred (plan §4): replacing `SceneRunner`'s per-frame `instanceof` dispatch, which still pins ~90 KiB of node types (Particles3D, ScrollContainer2D, VirtualCamera3D, the 3D meshes), plus asset compression (PNG → WebP) at export.
- **1.32 (2026-08-14):** **Multi-touch input contract** — the runtime tracked exactly one pointer (`onPointerDown` returned early while another was down), so "hold the stick, tap fire", twin-stick and "drag the stick, tap jump" were broken in the *game*, not just in a test harness. `InputService` now keeps a map of every pointer that is down, in press order, and ownership is decided in three places only: the service holds the map and arbitrates nothing; a `UIControl2D` owns at most one pointer (`ownedPointerId`) and the others do not exist for it while it does; a semantic (agent/script) interaction is ownership of the reserved pseudo-pointer `-1`. New addressed surface: `getActivePointers()` / `getPointer(id)` / `pointerDownCount` / `isPointerOverUI(id)`, a `pointerId` on every `pointerEvents` entry, and `scene.getPointer2DWorldPosition(pointerId)` (null when that pointer is not down; a tap that went down and up inside one frame is already out of the map, so fall back to the no-argument call). **Four changes consumers must read.** (1) `InputPointerFrameEvent.type` gained `'cancel'` — a press *taken away* (finger dragged off the screen edge, `pointercancel`, an input lock, the window blurring) is no longer reported as `'up'`, which fixes a real shipped defect: a finger slid off the edge of the screen over a button still **clicked** it, and so did `lock()` mid-press. Exhaustive `switch`es over the event type must handle the new literal, and "cancel is not a completed tap" is now the rule everywhere. (2) `isPointerDown` means "**any** pointer is down" (the map is not empty), not "the primary pointer is down"; with one finger the two sentences agree, with two they do not. It is a summary, not a handle — anything following one contact reads the addressed API. (3) `activePointerId` is `@deprecated` (still maintained: the oldest pointer still down, promoting the next one when it lifts), and `pointerPosition` stays primary-derived by design, because one `Vector2` can only describe one finger. `Action_Primary` remains one shared button, raised on the 0→1 transition and dropped by the last release. `lock()` / `detach()` / window blur cancel **every** held pointer; pointer capture is per id. (4) **`Checkbox2D` and `InventorySlot2D` activate on release-inside-bounds, not on press** — they polled `isPointerDown` themselves with their own hit test, which meant no lifecycle signals, no hover tracking and no ancestor-scroll gate (a scroll drag passing over a checkbox toggled it). They now run the same `updatePointerState` funnel as every other control, so a press that slides off no longer toggles and the state signal (`toggled`) follows `click` rather than replacing it. Gating a gesture on the `isHoveringUI` aggregate is likewise obsolete — it is what made "hold a button with one thumb, drag the stick with the other" impossible; ask `isPointerOverUI(myPointerId)` (the tapper recipe's `TouchRules` and the floating `Joystick2D` were both moved over). **Project layout:** the gameplay-testing harness keeps its artifacts under `design/tests/` — `routines/*.json` (replayable scenarios), `bots/*.ts` (**new**: policies that play the game, run with `game_run {bot: {name}}`; the editor writes `bots/pix3-test-bot.d.ts` next to them for completion), `*.trace.json`, `reports/*.json` and `reachability.json`. None of it is engine API and none of it ships: `design/` is outside the directories the export collects scripts from (`scripts/`, `src/scripts/`), which a spec recomputes from disk (`src/services/export/no-test-harness-in-bundle.spec.ts`) so the separation cannot rot into a convention. **One runtime addition consumers must read** if they implement a script-error sink: `game-debug.ts` now exports `TEST_COMPONENT_TYPE_PREFIX` (`'test:'`) and `isTestHarnessComponentType(componentType)`, and a `ScriptErrorInfo` carrying such a `componentType` is **test-harness code failing, not the game**. A host must keep it out of whatever it counts as runtime errors — the editor logs it as a *warning*, because `installErrorCapture` patches `console.error` only and the gameplay harness counts that ring for `newErrors`, which a run may carry as its crash net. Measured before the split existed: a test policy with a typo ended its own run as "the GAME threw 3 errors" on the frame the policy died, and the crash-net predicate is checked before the policy's own verdict. It also raises no play-mode banner, since a banner announcing that the game failed would be the same claim in the UI.
- **1.33 (2026-08-20):** **Authored colours convert exactly once** — `GeometryMesh` and all five light nodes wrapped every colour in a manual `convertSRGBToLinear()` on write (and, on `GeometryMesh`, `convertLinearToSRGB()` on read), on top of the conversion `THREE.Color.set()` / `getHexString()` already perform because `ColorManagement` is enabled. The transfer function was therefore applied twice: an authored `#a8d8f0` reached the material as (0.127, 0.429, 0.732) instead of (0.392, 0.687, 0.871), so **every** authored 3D colour — mesh albedo, light colour, shader-effect tint — rendered far darker and more saturated than authored. **Existing 3D scenes in every project will now look brighter; this is the fix, not a regression.** Mesh colours need no data migration (their read/write pair was symmetric, so the stored hex is exactly what the author typed), but **light colours do**: their write side converted twice while `getHexString()` un-converted once, so every save wrote a darker hex back into the `.pix3scene` and light colours drifted one transfer step per save/load cycle. The bundled samples and the `recipe-grid-3d` template carried one cycle of that drift and have been re-authored back to their intended values (e.g. an ambient light stored as `#040406` at intensity 0.4 was authored `#22222a`; a hemisphere sky stored `#80afff` was `#bcd8ff`). Consumer projects tuned under the bug (DeepCore) may want the same one-step correction on light colours. The convention — authored colours are sRGB hex; `Color.set()` and `getHexString()` do all conversion themselves — is now pinned by `packages/runtime/src/core/color-convention.spec.ts`, which asserts the three.js behaviour, per-node hex round-trip **plus** the linear components (a hex round-trip alone passes under symmetric double conversion, which is how the bug hid), and scans the runtime sources so a re-added conversion fails the build. The orphaned `nodes/3D/light-property-helpers.ts`, whose only content was a duck-typed encoding of the wrong convention, was deleted. Plan: `.plans/done/srgb-double-conversion-fix.md`.
- **1.34 (2026-08-20):** **A hidden UI control takes no input.** `NodeBase.tick` recurses into invisible children on purpose (components on a hidden node — a spawner, a timer, a state machine — have to keep running) and three.js only skips a hidden subtree when it *renders*, so nothing filtered hidden controls out of input: `UIControl2D` gated on `enabled` alone and a button inside a hidden overlay still hovered, pressed and clicked, and still called `registerHover`, which made `isPointerOverUI` report a finger as being over UI nobody could see. This was a shipped defect in the game recipes rather than a theoretical one: their end screen is a hidden `Group2D` centred over the playfield with an enabled MENU button, so a drag across the middle of the screen ended a run by opening the menu. Both input channels now gate on `NodeBase.isVisibleInTree()` (**new**, public: `visible` on the node and every ancestor) — the physical funnel cancels any hover/press it was holding and stops accepting frames, and `canAcceptSemanticPointer` refuses, so `invokeInteraction('click')` on a control inside a hidden panel returns `false` instead of reporting a success no player could reproduce. Deliberately boolean only, the line Godot's `is_visible_in_tree` draws: a fully transparent control still responds, because fading something out is not the same statement as taking it away, and a control that stopped responding halfway through a fade would be the surprising one. Guarded by `packages/runtime/src/nodes/2D/UI/UIControl2D.visibility.spec.ts`, which asserts the ancestor case specifically — the control's own `visible` stays `true` there, which is exactly what a per-node check misses.
- **1.35 (2026-08-20):** **The in-editor agent can read the engine.** Measured cause of a persistent quality gap between the in-editor agent and an external one on the same brief: the agent's only account of `@pix3/runtime` was prose (skills + tool descriptions), so it guessed member names and paid a compile round-trip per guess, while an external agent reading `packages/runtime/src` got the contract right first time. The sources were **already in the browser** — `monaco-runtime-libs.ts` globs the whole runtime as `?raw` to type-check project scripts against it — they just were not reachable from the tool layer. New `src/core/engine-source.ts` owns that glob (Monaco now consumes it, so the type worker and the agent can never read different copies of the engine) and serves two tools: **`engine_search`** (literal or regex, `pathFilter`, capped matches with optional context lines, `matchCount`/`truncated` so a flood reads as "narrow the query") and **`engine_read`** (package-relative `@pix3/runtime/src/…` paths, with the prefix-less and unambiguous-bare-filename forms resolving too, and `suggestions` instead of a dead end on a miss; `offset`/`limit` with line and byte caps). Read-only by construction and said so in the descriptions — it is the engine inside the editor build, not a project file. **`node_inspect` de-trapped:** it returns AUTHORED values, and while the game is playing the live node may hold others, so it now carries `authoredWhilePlaying` pointing at `game_observe`. Unlike `scene_tree`'s existing `staleWhilePlaying` this fires in the SAME scene, which is the case that actually misleads — a verification pass "confirmed" a result-overlay label it had never observed, because the authored text and the runtime text differ for the whole run. **Eval scorecard gained the cost side** (`EvalReport.metrics`): `toolCalls`, `compileRoundTrips`, `engineReads`, `screenshots`, `stateVerifications`, plus `cacheReadTokens`/`cacheCreationTokens` and `iterationsUsed`/`iterationCap` on the agent summary — counted from the recorded calls and the conversation, so every later change to the agent's tools can be judged as a token bet and not only as "the game works". Guarded by `src/core/engine-source.spec.ts`, whose last case asserts the premise itself: the shipped bundle really does carry the sources, and `ShakeOptions` — the exact lookup that cost a compile round-trip — is findable in them.
- **1.36 (2026-09-06):** **UI Kit Forge becomes part of the editor, and its output becomes a project format.** The forge was a 1388-line vanilla page (`public/tools/uikit-forge.html`) authored *outside* the repository and updated by copying downloaded HTML over the file — no typecheck, no tests on ~750 lines of geometry, and nothing wired its output back into a project: a user exported PNGs and imported them by hand. It is now a host-agnostic **core** in `src/services/uikit/` (theme + colour maths, SVG primitives, 34 glyphs, ~40 `comp*` generators, 6 showcase screens, ru/en captions, registry, `slices`, `presets`, `style-doc`) under **two hosts over one generator**, an invariant pinned by `host-agnostic.spec.ts` (the core imports nothing from `src/services/*`, `src/ui`, `src/state` and touches no DOM — rasterization and file writing are the host's job). Host one is the **standalone page**, now a second Vite entry (`tools/uikit-forge.html` + `src/tools/uikit-forge/`, same URL `/tools/uikit-forge.html`, still framed by the `#uikit` route and still usable with no project): every export lane of the old page survives — per-component SVG/PNG, the `showDirectoryPicker` folder dump, HTML gallery, glyph sheet, atlas PNG + TexturePacker JSON-hash manifest, "Kit + style contract" (`tokens.json` + `STYLE.md`), clipboard themes, localStorage presets, `window.__UIKIT_FORGE_DEBUG__`. Host two is the **"UI Kit" editor tab** (`pix3-uikit-forge-panel`, Tools → UI Kit Forge / `editor.open-uikit-forge`, which routes to the tab when a project is open and to `#uikit` when none is), and it is what makes the kit a *format*: new **§6.23 UI Kit Assets** specifies `design/ui-theme.json` (a normalized `ForgeTheme` — absolute colours, per-role `palette` overrides, `normalizeTheme()` as the single entry point from JSON), `design/ui-kit.json` (every field documented: `kitId` as an 8-hex FNV-1a over the theme's canonical JSON, `scale`, the `component[/role][/state]` part keys, per-part `path`/`w`/`h`/`sliceBorder`/`role`/`component`/`state`, `warnings`), the `sprites/ui/<kitId>/` naming, and `prefabs/ui/<templateId>-<kitId>.pix3scene` for the dialog/settings **templates** — parts plus a layout (`TemplateSpec`) assembled into an ordinary prefab (§6.20), because a composite baked as one picture is unusable (half of it is text that the engine has to draw, and a real `Button2D` on top draws it twice). New command **`properties.apply-uikit-skin`** (`{nodeIds?, colorRole?, manifest?}`) skins `Button2D` / `Checkbox2D` / `Slider2D` / `Bar2D` / `TiledSprite2D` / `Sprite2D` through `UpdateObjectPropertyOperation` composed into one `BulkOperation`; it sits under a `properties.` id deliberately, so the agent's prefix-gated `run_command` reaches it, and its zero-argument form is defined (current selection, role `blue`, manifest read from disk). **Undo is asymmetric on purpose:** property writes undo as one step, the PNG/JSON writes do not — the kit id is a pure function of the theme, so a re-theme writes a *new* folder and leaves the old art in place, which is what makes that Ctrl+Z land on art that still exists (`export.pruneUnusedAssets` collects the stale folder later). Three rules separate the **engine lane** from the preview one and are now stated where a consumer will find them: `pad` is forced to 0 (the kit's 24 px transparent margin lands inside a `Button2D`'s `width`/`height` hit box — ~20 % dead border), `feDropShadow` is never used (its blur differs by GPU and browser, so two collaborators regenerating one theme would produce different bytes), and PNGs carry **no captions** (the engine draws them, which is what keeps one sprite valid across states *and* locales; a baked *glyph* is fine, being language-independent, and is what `icon-button` is for). Nine-slice insets come from the generator's own geometry as `SkinPart.sliceBorder`, measured back off the rasterized pixels and `null` whenever `skew` or `puffy` makes an edge non-uniform. Consumers beyond the editor: the agent tool **`skin_ui`** (`bake` / `apply` / `restyle` — the "rounder, darker, less gloss" edit as a deterministic re-render off `ui-theme.json`, never a new roll) and the **T0 expander**, where `PrototypeBootstrapService` derives a theme from the brief's palette in `design/style.md`, bakes the kit and skins every UI control in the recipe scenes with zero agent turns — the first frame of a generated prototype stops being coloured rectangles. Runtime side (§7.2.2, unchanged in shape): `Button2D` gained `sliceBorder*`, and `Checkbox2D` / `Slider2D` / `Bar2D` gained the texture slots the kit fills. The cost paid knowingly: the external authoring loop is over — the page can no longer be edited outside the repository and copied over. Plan: `.plans/done/uikit-forge-modularization.md`.
