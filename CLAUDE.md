# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What pix3-core is

Pix3 2.x: a plain Vite + TS game project plus `@pix3/vite-plugin`, which serves the Pix3 editor on the game's own dev server at `/__pix3/` (file API, sync barrier, build). The engine is `@pix3/runtime`; the CLI is `@pix3/cli`; new projects come from `npm create pix3`. Coding agents (Codex, Claude Code) drive the open editor tab through Chrome DevTools MCP — there is no Pix3 MCP server.

The design and phase plan is `.plans/pix3-core.md` in the `pix3` repo (sibling checkout `../pix3`); P0 spike code and reports are in `../pix3-core-spikes`. `pix3` itself becomes `pix3-full`, frozen on 1.6.x.

**Status (2026-10-08): seeded, P1 in progress.** `runtime`, `cli`, `docs` and the templates carry their `pix3` history and pass lint, type-check and tests. `packages/editor-core` is a source snapshot of the `pix3` editor awaiting the port (it does not compile and is outside lint/type-check/tests). `packages/vite-plugin` is empty until the dev-plugin work lands.

## Doc router — read the SECTION, not the whole file

Every doc below is bigger than the answer to any single task. **Locate the anchor with `Grep`, then `Read` with `offset`/`limit`.** Anchors are the _descriptive_ heading text (grep that, not a section number). `AGENTS.md` is the binding code-rule set: read it before writing code. Sections of the spec that describe the 1.x editor (workspace, co-authoring, collab, Flow, live agent channel) are history until the port rewrites them.

| Task | File → section (grep the heading text) |
| --- | --- |
| Does the engine already do X? / engine-vs-game decision                 | `docs/nodes-and-systems.md` → "engine-vs-game decision", then the Nodes/Systems catalog                                           |
| All properties of one node type                                         | `docs/node-types-reference.md` → `### <NodeName>` (summary table at "Node Properties Quick Reference")                            |
| Write a game script / runtime API from a `Script`                       | `docs/nodes-and-systems.md` → "Scripts-facing runtime API" + the new-node checklist                                               |
| UI click-through / modal opens and closes on one press / background hover | `docs/nodes-and-systems.md` → "Input"; `docs/node-types-reference.md` → "ColorRect2D" (`blocksPointerInput`); `docs/pix3-specification.md` → "7.2.2 Skinned 2D UI controls" |
| Add/fix an inspector property (schema authoring)                        | `docs/property-schema-reference.md` (recipes at top; source: `packages/runtime/src/fw/property-schema.ts`)                   |
| New engine node, full checklist                                         | `nodes-and-systems.md` engine-vs-game + spec "Scene File Format" + `property-schema-reference.md`                                 |
| `.pix3scene` YAML format / validation                                   | `docs/pix3-specification.md` → "Scene File Format"                                                                                |
| Strict scene check / which `properties:` keys the loader reads (`pix3 validate`) | `docs/pix3-specification.md` → "Strict profile"; table `packages/runtime/src/core/scene-disk-format.ts`; CLI `packages/cli/src/validate/` |
| Script lifecycle / registry / serialization                             | `docs/pix3-specification.md` → "Script Component System"                                                                          |
| Prefabs / keyframe animation / localization / signals / groups          | `docs/pix3-specification.md` → "Node Prefabs System" / "Keyframe Animation" / "Localization" / "Signals Engine" / "Groups Engine" |
| Hide a group of objects without touching the scene file (Peek)          | `docs/pix3-specification.md` → "Editor Peek (View Mask)"; code in `packages/editor-core/src/services/viewport/PeekService.ts`                          |
| 2D draw order, overlay flag, texture-goes-black bug                     | this file → "2D overlay rendering"                                                                                                |
| Colour renders too dark in 3D / authoring a `color` property            | this file → "Authored colours convert exactly once"                                                                               |
| Why the exported .html weighs what it does / export size                | this file → "Playable export size"                                                                                                |
| Exported HUD off screen / authored viewport differs from the editor    | this file → "Exported viewport and HUD"                                                                                           |
| Viewport not repainting / render-on-demand                              | this file → "Editor viewport renders on demand"                                                                                   |
| A viewport inset/overlay draws in the wrong place / `setViewport` units | this file → "Viewport insets are sized in device pixels"                                                                          |
| 2D character with weapon/outfit variants and states, flipbook clip switching from a script, Store `character2d` compiler | `docs/nodes-and-systems.md` → "Character with variants/states"; `AnimatedSprite2D.play` in `docs/node-types-reference.md` |
| Tween a value, fade / cross-fade a node, ball trail                      | `docs/nodes-and-systems.md` → "Tweens (scene.tween)"; the `trail` line under "Juice & time-scale"                     |
| 2D physics (bodies, colliders, sensors) / collision polygons            | `docs/nodes-and-systems.md` → "Physics — which tier to use", then "2D physics" / "2D collision"                                   |
| Where a menu / end screen / modal belongs in a project or template      | `docs/pix3-specification.md` → "Project Templates, Target Platform and Agent Overlay" → the `scenes/ui/` paragraph                |
| Command / Operation / undo wiring                                       | `AGENTS.md` → "Commands and Operations"; code in `packages/editor-core/src/features/<area>/`                                                           |
| Add a menu command / which menu does it belong in / a toggle with a check | `AGENTS.md` → "Menu System" bullets, then `pix3-ui-conventions` skill §6; rationale in `../pix3/.plans/done/ui-consistency-pass.md` §2 |
| Inspector control primitives (buttons, switches, radio groups, sub-blocks) | `pix3-ui-conventions` skill §7; source `packages/editor-core/src/ui/object-inspector/inspector-controls.ts.css`                                       |
| Inspector density / compact typography / shadow-DOM field sizing       | `docs/pix3-specification.md` → "6.8 Inspector Integration"; `packages/editor-core/src/ui/object-inspector/inspector-controls.ts.css`                    |
| Inspector section order / a group lands in the wrong place              | `../pix3/.plans/done/ui-consistency-pass.md` §3.1; source `packages/editor-core/src/ui/object-inspector/inspector-property-renderers.ts` (`SECTION_ALIAS`)         |
| Editor UI (Lit, panels, icons, theming)                                 | `AGENTS.md` → "Component System" + `pix3-ui-conventions` skill                                                                    |
| ECS / `InstancedMesh3D` bulk API                                        | `nodes-and-systems.md` → "ECS"; `node-types-reference.md` → `### InstancedMesh3D`                                                 |
| Build a game feature (entry point)                                      | `pix3-game-dev` skill                                                                                                             |
| Run a game headless in Node without a browser (`pix3 smoke`), `pix3 tree`, `pix3 sfx`, SVG sprite rules (`E_SVG_*`) | `packages/cli/README.md` → "`pix3 smoke`" / "`pix3 tree`" / "`pix3 sfx`" / "SVG sprites"; code `packages/cli/src/{smoke,tree,sfx}/`, `src/validate/svg.ts` |
| `pix3 check` / `pix3 kit` / agent-kit generation and its drift spec / `.pix3/types` | `packages/cli/README.md` → "`pix3 check`" / "`pix3 kit`"; templates `packages/cli/kit-src/`, section sources `packages/cli/kit-includes/`, generator `packages/cli/src/kit/generate.ts`, drift spec `packages/cli/src/kit.spec.ts` |
| Project templates / recipes for `npm create pix3` | `packages/create-pix3/templates/`, catalog `packages/create-pix3/src/recipes.ts`, contract spec `packages/create-pix3/templates/recipes.spec.ts` |
| What the plugin, sync barrier, write model and agent transport must do | `../pix3/.plans/pix3-core.md` (§B plugin, §C files, §D agent, §F editor port, §G phases) |

**Version of record** is the `## N. Change Log` / title of `docs/pix3-specification.md` — never hardcode a spec version number in other docs.

## Commands

```bash
npm test               # vitest: runtime, cli and template specs (happy-dom; CLI specs opt into node)
npm run lint           # eslint over packages/runtime/src and packages/cli/src
npm run type-check     # tsc per package: runtime, cli (+ its Node build config), create-pix3
npm run version:sync   # stamp the root version into every package (lockstep, plan §A.3)
```

Single test: `npx vitest run packages/runtime/src/core/SceneLoader.spec.ts` or `npx vitest run -t "creates a box"`.

Node 24 for development (`.nvmrc`); `@pix3/runtime` itself targets `>=20.19`. Build the CLI the way `prepack` does: `cd packages/cli && npm run copy-templates && npm run build && npm run build-runtime-types && npm run build-kit` (CI runs the same).

## Repository topology

npm workspaces, versions lockstep from the root `package.json` (`2.0.0-alpha.N`; never hand-edit a package's `version`, bump the root and run `version:sync`).

- **`packages/runtime/`** (`@pix3/runtime`) — the engine: nodes, `Script`, ECS, `SceneService`/`SceneRunner`, audio, resources. Ships TypeScript sources; keep it editor-agnostic. `src/main.ts`, `register-project-scripts.ts` and `generated/` are player templates outside its tsconfig — they move into the plugin. `fixtures/` holds the sample projects its specs load (not published).
- **`packages/cli/`** (`@pix3/cli`) — `validate`, `check`, `smoke`, `tree`, `sfx`, `kit`, … Bundled with esbuild into `dist/`; `validate`/`smoke` bundle the runtime from this checkout. `serve/` is the source the plugin's `/__pix3/api/*` routes are ported from; `serve/`, `workspace-agent/` and `mcp*.ts` leave the CLI afterwards (plan §A.1).
- **`packages/create-pix3/`** — `npm create pix3`; `templates/` are the project templates (with their history), also copied into the CLI tarball by `copy-templates`.
- **`packages/editor-core/`** (`@pix3/editor-core`) — the Lit editor, mounted through `EditorHost`. See its README for the snapshot source and port rules.
- **`packages/vite-plugin/`** (`@pix3/vite-plugin`) — dev middleware, editor at `/__pix3/`, sync, virtual modules, build.
- **`../DeepCore/`** — a game on `@pix3/runtime` 1.6.x; the real-world test of the runtime API (migration in plan §A.4).

**`three` must be deduped.** `packages/runtime` declares `three` as both peer and dev dependency; a nested second copy breaks `instanceof` across the seam (`material instanceof THREE.MeshLambertMaterial` false for a material the runtime built). `vitest.config.ts` sets `resolve.dedupe: ['three']`; if a `three` `instanceof` reads as impossible, check `ls packages/*/node_modules/three` first.

## Architecture essentials

The mental model that spans many files:

1. **Operations-first mutation gateway.** Every state change flows: UI → `CommandDispatcher.execute(CommandClass, args)` → Command (thin wrapper, checks `preconditions()`) → Operation (`perform()` returns undo/redo closures) → `OperationService` (pushes to `HistoryManager`). **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `packages/editor-core/src/features/<area>/` (scene, scripts, properties, selection, alignment, project, editor, history, viewport).

2. **State vs. scene graph are deliberately separate.**
   - `appState` (Valtio proxy, `packages/editor-core/src/state/AppState.ts`) holds **only** UI state, scene metadata (paths/names), selection (node **IDs**), and undo/redo bookkeeping. UI subscribes via `subscribe(appState.section, cb)` and disposes in `disconnectedCallback`.
   - Actual nodes are Three.js `Object3D` subclasses living in the `SceneGraph` owned by `SceneManager`. They are **NOT reactive** — operations mutate them imperatively. Selection bridges the two by ID.

3. **Dependency injection** (`packages/editor-core/src/fw/di.ts`): `@injectable()` services registered in `ServiceContainer` (singletons by default), injected via `@inject(ServiceClass)`. Requires `reflect-metadata` (imported first in `main.ts`) and `experimentalDecorators`. Services holding subscriptions/resources implement `dispose()`. The services in `packages/editor-core/src/services/` are grouped into domain subdirectories (`core`, `scene`, `project`, `assets`, `scripting`, `play`, `export`, `editor`, `animation`, `localization`, `image-gen`, `viewport`, `agent`, `atlas`) — deep-import from the domain folder (`@/services/<domain>/FooService`); no loose files sit at the `packages/editor-core/src/services/` root.

4. **Property schema system** (Godot-inspired): node and `Script` classes implement `static getPropertySchema()` returning typed `PropertyDefinition`s with `getValue`/`setValue` closures. The Inspector renders editors dynamically from these; all edits go through `UpdateObjectPropertyOperation`. See `docs/property-schema-reference.md` (source: `packages/runtime/src/fw/`).

5. **Unified script components** (Unity-style): runtime logic attaches to nodes as `Script` instances in `node.components` (`onAttach`/`onStart`/`onUpdate`/`onDetach`). Register types in `ScriptRegistry` with namespace IDs — `core:` for built-ins, `user:` for project scripts. `ScriptExecutionService` drives the play-mode game loop.

6. **Command-driven menus**: menu items are generated from command metadata (`menuPath`, `shortcut`, `addToMenu`, `menuOrder`) via `CommandRegistry`, not hardcoded.

## Non-obvious engine and editor facts

### 2D overlay rendering (non-obvious)

The 2D layer is a separate render pass with an orthographic camera, drawn over the 3D pass after a `clearDepth()`. Two things about it are easy to break:

- **Draw order is hierarchy-driven, not depth-driven.** All 2D materials use `depthTest: false`, so `renderOrder` is the _only_ thing that decides stacking. `assign2DRenderOrder(roots)` (`packages/runtime/src/core/render-order-2d.ts`) walks the 2D node tree and assigns `renderOrder` by DFS — a node later/deeper in the tree draws on top. `Node2D.zIndex` (+ `zAsRelative`, Godot semantics) overrides that: units are bucketed by effective z and DFS order only breaks ties — the sort is skipped entirely while every node is at the default z. Anything that reproduces paint order must apply the same bucketing (the editor does it in `Viewport2DProxyRegistry.assignRenderOrder` and `ViewportPicking.build2DPaintOrderIndex`). The runtime runs it every frame before the 2D pass (`SceneRunner.reflowRoot2DNodes`). The **editor viewport does NOT render the runtime nodes** — it draws separate proxy visuals — so it runs its own counterpart, `ViewportRenderService.assign2DVisualRenderOrder` (called from `requestRender`), which DFS-walks the scene tree and rebases the proxy meshes' `renderOrder`; editor adornments (anchor markers, Group2D outlines, selection/hover frames) float above content via `THREE.Group.renderOrder`, which three.js treats as `groupOrder` (sorts before per-mesh `renderOrder`). So **node order in the scene tree = paint order** (Godot-like) in both. Within a node, its own meshes are ordered by their _authored_ `renderOrder` (e.g. Button2D skin 999 < label 1001) — never add-order, because `UIControl2D` adds its label in `super()` before subclasses add their skin. Meshes that must float above a node's _children_ (e.g. a ScrollContainer scrollbar) set `userData[OVERLAY_2D_FLAG] = true`.
- **2D textures must disable mipmaps.** Always run loaded/canvas textures for 2D nodes through `configure2DTexture()` (`packages/runtime/src/core/configure-2d-texture.ts`): sRGB + `generateMipmaps = false` + `LinearFilter`. On some ANGLE/D3D11 backends (Adreno / Windows on ARM) mipmapped NPOT 2D textures upload as transparent black and get cached that way, so sprites/labels render semi-transparent with opacity varying by zoom. The editor applies the same fix in `ViewportRenderService.configureSpriteTexture`. (3D textures keep mipmaps.)

### Authored colours convert exactly once (non-obvious)

**Never call `convertSRGBToLinear()` / `convertLinearToSRGB()` on an authored colour.** `THREE.ColorManagement.enabled` is three's default since r152 and nothing here disables it, so `new Color('#hex')` / `color.set('#hex')` **already** converts the authored sRGB hex into the linear working space, and `getHexString()` / `getHex()` **already** converts back. A manual conversion on top applies the transfer function twice: `#a8d8f0` reached the material as (0.127, 0.429, 0.732) instead of (0.392, 0.687, 0.871), which is why authored pastels used to render acid-bright. `GeometryMesh` and every light node did this until it was fixed; the lights were worse than the mesh because their write side converted twice while `getHexString()` un-converted once, so **each save/load cycle wrote a darker hex back into the `.pix3scene`** — the committed sample scenes carried one cycle of that drift and were re-authored back to their intended values. `packages/runtime/src/core/color-convention.spec.ts` pins the convention three ways: the three.js behaviour itself, per-node hex round-trip **plus a linear-component assertion** (a hex round-trip alone passes under symmetric double conversion — that is exactly how the bug hid), and a source scan that fails on any new occurrence of either convert call in the runtime.

### Spine is an optional, host-injected dependency (non-obvious)

`SpineSkeleton2D` renders through `@esotericsoftware/spine-threejs` (`~4.3`), which the runtime **never imports**: `packages/runtime/src/core/spine/spine-module.ts` hand-declares the structural subset it uses, and the host registers a loader (`setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'))` — `packages/editor-core/src/core/lazy-spine.ts`, called from the editor's `main.ts`; the plugin's player does the same). Reasons: consumer projects compile our TS sources, so a type import would make Spine mandatory for every game; the Spine Runtimes License is a poor fit for an always-installed dependency; and the literal dynamic import must live in the host for its bundler to emit a lazy chunk. Two more load-bearing details: atlas **pages must never go through the pre-launch atlas** (their UVs come from the `.atlas` file — the loader reads page blobs directly and `TextureAtlasService` excludes them), and spine adds its batch meshes **lazily**, so the editor proxy re-stamps `LAYER_2D` on the view's children after every update (three.js layers are per-object, not inherited; the runtime's per-frame `assign2DLayers` covers play mode).

### Exported viewport and HUD

`ProjectBuildService` writes the project's `viewportBaseSize` into the generated scene
manifest as `runtimeViewportBaseSize`. The shared runtime bootstrap passes that size to
`SceneRunner`, just like the editor. This applies to ZIP, single-file HTML,
and generated npm builds. Without it, a portrait scene authored at 1080×1920 runs against
the default 1920×1080 layout reference and its edge-anchored HUD lands off screen.
Projects without a manifest retain the default 1920×1080 reference.

### Playable export size (non-obvious)

The single-file HTML export is mostly **code**, not assets (measured: 1.22 MiB of 1.34 MiB for a 2D pinball), and three.js is ~550 KiB of that with a hard floor of 491 KiB for any bundle that touches `WebGLRenderer` — so tree-shaking cannot reach it and only compression can. Consequences worth knowing before you touch `PlayableHtmlBuildService`:

- **Compression is a per-export choice, not a default** (`PlayableHtmlBuildOptions.compress`). It cuts the file by ~two thirds, which is the budget ad networks measure. What it costs on a channel that compresses for you depends on the codec, and the two answers differ enough to matter (measured on the same export): over gzip it is a wash (+0.9% — deflate re-packs base64 almost perfectly, so the old "+33%" claim was wrong), over **brotli** it is +21%, because brotli beats gzip on the plain text and cannot touch an already-compressed payload. Compressed builds are bundled as `iife` and injected as a classic `<script>`'s `textContent` — deliberately not blob/`data:`/`eval`, which sandboxed and opaque-origin ad containers refuse.
- **Minification is not made redundant by compression** and is always on: same export, unminified gzips to 406 KiB, minified to 259 KiB. Renaming locals and dropping dead code is work gzip cannot do for you.
- **What ships is decided by `RuntimeProjectBuildModel.mentionedNames`** — every identifier found in the shipped scenes/prefabs and project scripts. A module is left out only if _nothing_ mentions it, and unused node types / `core:` behaviours are replaced by stubs with identical export names (`strippable-runtime-modules.ts`). The table there is guarded by a spec that recomputes the runtime's value-import graph from disk: **if you add `import { SomeNode } from …` to a module a player always keeps, that spec fails** — which is the point.
- **A player must not construct `SceneSaver`.** It value-imports every node class for serialization, so having it in the bundle pins all of them; `SceneManager` takes it optionally and the runtime entry boots via `SceneRunner.loadAndStartScene` (`startScene` clones the graph by serializing to YAML and re-parsing it, which a player does not need).
- **Optional heavy libraries are wired through a generated `virtual:runtime-*` module** (spine, postprocessing, network) with a **static** import inside it — a dynamic import would become a chunk a single-file HTML can never fetch, and a bare specifier left unaliased is silently externalised into an unresolvable import. That last one was a real shipped bug for `postprocessing`.

Build moves into the plugin (plan §B.6); until then `ProjectBuildService` / `PlayableHtmlBuildService` live in `packages/editor-core/src/services/export/`. Full measurements: `../pix3/.plans/done/playable-export-size.md`.

### Editor viewport renders on demand (non-obvious)

The `ViewportRenderService` rAF loop does **not** paint every frame. A frame renders only when something marked the viewport dirty (`requestRender()`), an editor preview is animating (animation-clip / particle / component preview), or the 500 ms idle heartbeat is due — an idle editor costs near-zero CPU/GPU (important for agent-driven background-tab sessions). Dirty marking comes from: Valtio state subscriptions, canvas pointer/wheel/drag events, Orbit/Transform controls `change` events, and `THREE.DefaultLoadingManager.onLoad` for async textures. If you add code that mutates three.js objects outside those paths (timers, async callbacks, direct service calls), call `viewportRenderService.requestRender()` afterwards — otherwise the change won't appear until the next heartbeat (≤500 ms) and, worse, will look intermittently "laggy". `requestRender()` renders synchronously when the loop is stopped (paused / window unfocused / hidden tab), so background-tab edits still land on canvas. Under agent keepalive the loop does not park at all: in a hidden tab it ticks from `BackgroundTicker`'s worker instead of rAF, and a dirty mark lands on the next tick.

### Viewport insets are sized in device pixels, not CSS pixels (non-obvious)

`ViewportRendererService.resize()` calls `renderer.setSize(cssWidth * devicePixelRatio, ...)` **while** `setPixelRatio(dpr)` is also set, so the renderer's logical space is _device_ pixels (and the drawing buffer ends up dpr x larger again). Everything that draws into a sub-rectangle of the frame therefore has to convert: the camera-preview inset multiplies its CSS-pixel geometry by `renderer.getPixelRatio()`, and `ViewportAxisGizmo` derives the scale as `rendererLogicalWidth / canvas.clientWidth`. Hand `setViewport`/`setScissor` raw CSS pixels and your inset lands short of where you meant it, scaled down by the device pixel ratio — it looks fine on a 1x monitor and wrong on every other one. Pointer hit-tests for those insets stay in CSS pixels (that is what `clientX` speaks), so the two spaces must be converted, never mixed.

## Conventions worth flagging

- **No `any`.** ESLint flags it (`@typescript-eslint/no-explicit-any: warn`); `strict`, `noUnusedLocals/Parameters`, `noUncheckedSideEffectImports` are all on. Prefix intentionally-unused vars/args with `_`.
- **Lit components** extend `ComponentBase` from `@/fw`, default to Light DOM, and split styles into a sibling `[component].ts.css` (imported directly for Light DOM, or `?raw` for Shadow DOM).
- **Theming** via CSS custom properties — accent is `--pix3-accent-color` (#ffcf33) / `--pix3-accent-rgb`; avoid hardcoded colors.
- **Icons are vector, never emoji.** Every icon/affordance (buttons, status glyphs, list markers) renders through `IconService` (`@/services/editor/IconService`) — inject it and call `getIcon(name, IconSize.SMALL|MEDIUM|LARGE)`, which returns an inline `currentColor` SVG (Feather names + custom SVGs registered there). Do **not** paste emoji (📎 🔑 ✕ ✓ 📄) or Unicode symbol glyphs (↻ ● ⏸) into templates as UI icons — they ignore the theme, render inconsistently across platforms, and don't scale. If the icon you need isn't in Feather, register a custom SVG in `IconService.registerCustomIcons()` rather than reaching for a glyph. (Emoji are fine only inside user-authored _content_ — chat text, asset names — never chrome.) See the `pix3-ui-conventions` skill.
- **Emoji are never artwork either — in the editor or in a generated game.** The chrome rule above had a "user-authored content" carve-out, and a generated game fell straight through it: an agent shipped a coin-tapper whose coin was a `Button2D` with `label: 🪙` at 140px on a stock button skin. A label or text that is **nothing but emoji** is a picture standing in for a sprite: it draws differently on Apple / Google / Samsung / Windows, cannot be recoloured, atlased, animated or art-directed, and is a hollow box wherever the codepoint is missing. The harness enforces it rather than asking — `emoji-as-art.ts` refuses such a value on `set_property`, `create_node`, `set_component_property`, and on any `.pix3scene` write. Placeholders are `ColorRect2D`; real art is `generate_asset` + `Sprite2D`. An emoji **inside a sentence** (`Счёт: 10 🪙`) is ordinary text and stays allowed.
- **Docs policy** (from AGENTS.md): maintain `README.md`, `AGENTS.md`, and `docs/pix3-specification.md`; don't spawn new feature-specific `.md` files. Planning docs are the exception and live in `.plans/` (active plans + `TODO.md`; finished plans `git mv`'d to `.plans/done/`) — never at the repo root.

## Engine vs Game feature decision

When asked to implement a game feature:

1. Check `docs/nodes-and-systems.md` — if the capability already exists
   in the editor/runtime, use it instead of custom game code.
2. Ask: "Would Godot/Unity ship this as a built-in node/system?"
   - Yes → engine-level: implement in pix3 runtime + editor
     (schema, Create\*Command, registry, YAML serialization, inspector),
     then release a runtime version and update the game project.
   - No (game-specific rules, content, balancing) → game-level script.
3. For engine-level changes, state the plan and get confirmation first.
4. Engine nodes must not reference game domain concepts (shop, coins, enemies).
5. After adding an engine feature, update `docs/nodes-and-systems.md`.
