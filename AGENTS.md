# pix3-core - AI Agent Guidelines

Authoritative code rules for pix3-core (runtime, CLI, editor-core, Vite plugin, create-pix3). These guidelines ensure consistent code generation and adherence to project architecture patterns.

## Project Overview

- **Pix3** is an editor for HTML5 scenes blending 2D and 3D layers, served by a Vite plugin on the game's own dev server.
- **Stack**: TypeScript + Vite, Lit web components, Valtio state, Three.js, Golden Layout.
- **Architecture**: Operations-first with `OperationService` as mutation gateway.
- **Source of Truth**: `docs/pix3-specification.md` (version is the number in its own title — don't cite one here).
- **Capabilities catalog**: `docs/nodes-and-systems.md` — the inventory of every node, `core:*` behavior, system, and scripts-facing runtime API (and how to use each). **Check it before writing custom game logic**; it also carries the engine-vs-game decision. For agents building on the engine, the `pix3-game-dev` skill is the entry point.

## Essential Architecture Patterns

### Component System (Lit)

- **Base Class**: Extend `ComponentBase` from `@/fw` (not raw `LitElement`).
- **DOM Mode**: Default to **Light DOM** for global style integration.
- **Shadow DOM**: Use only when explicitly needed: `static useShadowDom = true`.
- **Styling**:
  - Separate CSS files: `[component].ts.css`.
  - Light DOM: `import './component.ts.css';`
  - Shadow DOM: `import styles from './component.ts.css?raw';` + `static styles = css`${unsafeCSS(styles)}`;`
- **Accent Color**: Use CSS variables `--pix3-accent-color` (#ffcf33) and `--pix3-accent-rgb`.
- **Icons**: Use **vector icons via `IconService`** (`@inject(IconService)` → `getIcon(name, IconSize.*)`), never emoji or Unicode symbol glyphs (📎🔑✕✓📄↻●⏸). Register a custom SVG in `IconService` if the icon isn't in Feather. Emoji belong only in user-authored content, never in UI chrome.
- **Emoji are never artwork**, in editor chrome or in a generated game. A `label`/`text` that is **nothing but emoji** is a sprite substitute: platform-dependent glyph, no recolour, no atlas, no animation, hollow box where the font lacks it. `packages/editor-core/src/services/scene/emoji-as-art.ts` refuses it on agent writes; the detection itself is `packages/runtime/src/core/emoji-as-art.ts`, shared with `pix3 validate` (`E_EMOJI_AS_ART`). Use `ColorRect2D` for a placeholder and `generate_asset` + `Sprite2D` for real art. An emoji inside a sentence is ordinary text and is allowed.

### Dependency Injection

- **Decorators**: Use `@injectable()` for services and `@inject(ServiceClass)` for injection.
- **Container**: Register services in `ServiceContainer` (singleton by default).
- **Lifecycle**: Services must implement `dispose()` if they hold resources or subscriptions.
- **Lazy injection**: `@injectLazy(() => import('…').then(m => m.ServiceClass))` makes the property a `LazyService<T>` async accessor — the module is `import()`-ed once (cached), and the service is resolved through the container on every `await this.foo()` call, so re-registration is observed and singleton/transient lifetimes behave exactly like `@inject`. Keeps heavy modules out of the eager bundle. Use **sparingly** for heavy, rarely-used services whose consumers only touch them inside async flows (e.g. Monaco IntelliSense, playable export); `@inject` remains the default.

### State Management (Valtio)

- **Global State**: `appState` proxy in `packages/editor-core/src/state/AppState.ts`. **Never mutate directly**.
- **Gateway scope**: The Command→Operation gateway governs **document state** — the scene graph, node properties, and project files, i.e. anything undoable/saveable. **Session/UI/infrastructure state** in `appState` (router, project open/close lifecycle, script-load status, error surfacing, tab management, refresh signals) is owned by its dedicated service and may be written by that service directly, outside the gateway.
- **Nodes & State**: Nodes live in `SceneGraph` (managed by `SceneManager`), **not in reactive state**.
- **Sync**: State tracks node IDs for selection and hierarchy. UI subscribes via `subscribe(appState.section, callback)`.
- **Cleanup**: Always dispose subscriptions in `disconnectedCallback` or `dispose`.

### Scripting & Component System

- **Unified Components**: All scripts are `Script` instances in `node.components` (Unity-style).
- **Base Class**: Extend `Script` from `@pix3/runtime` (provides `onAttach`, `onStart`, `onUpdate`, `onDetach`).
- **Registration**: Register new script types in `ScriptRegistry`.
- **Mutations**: Use `AddComponentCommand` / `RemoveComponentCommand` for management.

### Commands and Operations

- **Operations**: Encapsulate mutation logic. Implement `perform()` returning `undo`/`redo` closures.
- **Commands**: Thin wrappers around operations. Validate state in `preconditions()`.
- **Dispatcher**: All actions **MUST** flow through `CommandDispatcher.execute(CommandClass, args)`.
- **Menu System**: Commands opt-in via metadata: `menuPath`, `menuOrder`, `addToMenu`, `keybinding`. Register in `CommandRegistry`. Four rules the registry's spec enforces or the menu depends on:
  - Sections are `edit`, `create`, `node`, `view`, `run`, `window` — anything that opens a panel or editor belongs to `window`. There is no `file` or `project` section: the editor edits an already-open project, and files, folders, scripts and `pix3project.yaml` are changed by the coding agent or the IDE, never through editor UI (Save, Mod+S, is in `edit`).
  - `menuOrder` is **mandatory and unique per `menuPath`**, and banded: hundreds = semantic group, tens = slot. Separators are drawn where the hundreds digit changes, so numbering *is* the grouping. `CommandRegistry.menu.spec.ts` fails and names offenders.
  - A two-state command declares `checked: snapshot => boolean` and is titled with the noun (`Grid`, never `Toggle Grid`); `CommandRegistry.isChecked(id)` feeds both the menu check and the toolbar's pressed state, so they cannot disagree.
  - `menuPath: 'node/align'` makes a flyout submenu; the row is not a command, so its label and slot live in `SUBMENU_ROWS`. A title ends in `…` only when the command asks something before acting.
- **Inspector controls**: one primitive set in `packages/editor-core/src/ui/object-inspector/inspector-controls.ts.css` (`.inspector-btn` + `--icon/--primary/--danger/--toggle`, `.inspector-switch`, `.inspector-segment`, `.inspector-subsection`), every rule scoped under the host tag. Enabled state is a switch, a single choice is a radio group, icon-only controls carry `title` + `aria-label`. See the `pix3-ui-conventions` skill.

### Property Schema System

- **Metadata**: Node/Script classes implement `static getPropertySchema()`.
- **Dynamic UI**: Inspector consumes schemas to render property editors (Vector2, Color, Enum, etc.).
- **Updates**: All property changes use `UpdateObjectPropertyOperation`.

## File Structure Conventions

### Packages

- `packages/runtime/src/`: Core engine logic (Nodes, SceneManager, Script base). Published as TS sources; editor-agnostic.
- `packages/cli/src/`: `@pix3/cli` (Node, `.ts` import extensions, bundled by esbuild).
- `packages/vite-plugin/`: `@pix3/vite-plugin`.
- `packages/create-pix3/`: scaffolder and project templates.

### Editor (`packages/editor-core/src/`)

- `packages/editor-core/src/core/`: Editor-specific logic (HistoryManager, LayoutManager, Keybindings).
- `packages/editor-core/src/fw/`: Framework utilities (DI, ComponentBase, Property Schema).

### Features (Commands & Operations)

- `packages/editor-core/src/features/scene/`: Node creation, deletion, reparenting, prefabs.
- `packages/editor-core/src/features/scripts/`: Script management, play mode control.
- `packages/editor-core/src/features/properties/`: Object property updates.
- `packages/editor-core/src/features/selection/`: Selection logic.

### UI & Services

- `packages/editor-core/src/ui/`: Lit components organized by panel (viewport, inspector, assets, etc.).
- `packages/editor-core/src/services/`: Injectable services, grouped into domain subdirectories. A new service goes into the fitting domain folder; there are no loose files at the `packages/editor-core/src/services/` root.
- `packages/editor-core/src/state/`: Valtio state definitions.

**Imports**: `packages/editor-core/src/services` has no barrel — always deep-import a service directly from its domain folder (`@/services/<domain>/FooService`). `packages/editor-core/src/state/index.ts` is a real module (it owns the `appState` singleton), so import state from `@/state`. `packages/runtime/src/index.ts` is a published package boundary and stays.

## Critical Rules for AI Agents

1. **Mutation Gate**: Never mutate `appState` or `Node` properties directly. Use `CommandDispatcher`.
2. **Aliases**: In editor-core use `@/` (for `packages/editor-core/src`); everywhere use `@pix3/runtime` for the engine, never a relative path into `packages/runtime`.
3. **Types**: Never use `any`. Use explicit types or `unknown` with type guards.
4. **Selection**: When creating nodes, update both `selection.nodeIds` and `selection.primaryNodeId`.
5. **Portals**: Use `DropdownPortal` for floating UI (dropdowns, tooltips) to avoid clipping.
   5a. **Icons**: All UI icons render through `IconService.getIcon(...)` (vector SVG). Never hardcode emoji/glyphs as icons.
6. **Async Safety**: Use `CommandDispatcher` to handle command execution flow and errors.
7. **Proactiveness**: If a command requires a service, check its availability and register if necessary.
8. **Documentation**: Keep the canonical doc set current; do **not** add new `.md` files. The set is `README.md`, `AGENTS.md`, `CLAUDE.md`, and under `docs/`: `pix3-specification.md`, `nodes-and-systems.md`, `node-types-reference.md`, `property-schema-reference.md`, `architecture.md`. New material = a section in one of these + a row in CLAUDE.md's doc router (not a new file).
9. **Plans**: Planning documents are the one exception to rule 8. The pix3-core plan lives in `../pix3/.plans/pix3-core.md`; new plans go to `.plans/` (finished ones `git mv`'d to `.plans/done/`). Never create a plan/TODO file at the repository root.
10. **A green test suite is not verification.** Tests catch what someone thought to assert; they do not catch paint order, a dead affordance, or a gate nobody wrote. Anything user-facing gets checked in the running editor (`/__pix3/` through chrome-devtools MCP), judged by state — `window.__PIX3_DEBUG__`, node/document properties, DOM measurements — with a screenshot only for genuinely visual questions.
11. **Verify against an independent measurement, not the tool's own output.** A restamped anchor satisfying the equation the restamp was derived from proves nothing; decode the source file and compute the answer another way. Real examples from this repo: the trim tool's anchor was confirmed by computing the PNG's alpha bounding box separately, the chroma key by predicting the affected pixel count from the source pixels, a bulk flip by comparing the output against a mirrored read of its input, and the video importer against a clip authored so a failed seek would show up as repeated pixels.
12. **Suspect the harness before declaring a bug.** Measurement mistakes outnumber real regressions here: a wrong property name, `display: contents` reporting 0×0, a reading taken after playback ended, or dispatching only `change` at a control that reads its value in `@input`. Re-check how you measured, then report.
13. **An implementation contract is derived, not authoritative.** A `.plans/` contract section can be incomplete or can have drifted from the product spec it was written against. Before implementing, read the source-of-truth section it derives from (a decision table, a drag matrix) and say so when the two disagree — implementing the contract literally and silently is how a row of a matrix ends up as a dead affordance.

## Development Commands

- `npm test`: Vitest.
- `npm run lint`: ESLint.
- `npm run type-check`: tsc per package.
