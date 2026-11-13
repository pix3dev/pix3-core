---
name: pix3-scene-format
description: The .pix3scene YAML format — file header, node shape (id/type/name/properties/children/components), component shape, 2D transform and layout blocks, res:// references, textures, prefab instances and overrides, scenes/ui overlays and the visible/initiallyVisible split; `.pix3anim` flipbooks (and `pix3 character-compile`) in `pix3anim.md` beside it; creating, renaming, moving, deleting files, extracting a branch into a prefab, locales, `pix3project.yaml` and build options in `project-files.md` beside it. Use BEFORE creating or editing any .pix3scene file (scene, prefab or overlay) in this project.
---

<!-- Pix3 agent kit {{version}} -->

# `.pix3scene` format

Scenes, prefabs and overlays are the same file type: YAML with a `.pix3scene` extension.
"Prefab" only means "a scene file that other scenes instance". There is no `.pix3prefab`.
The engine's own statement of the format (principles, skinned UI controls, Spine nodes) is in
`reference.md` beside this file; where the two differ, this page describes what the loader and
`pix3 validate` actually do.

## Before you write

Sync, re-read the file, change only the lines you mean to change, then `pix3 check` (`AGENTS.md`
rules 2 and 4). If your tools support it, write to a temporary file and rename it over the
target — not required (the editor waits for the file to stop changing), but cleaner.

## File

```yaml
version: 1.0.0                 # the only format version; copy it
metadata:                      # optional, free-form
  author: Pix3
  description: Tapper gameplay — falling objects
root:                          # list of root nodes; at least one
  - id: game-root
    type: Group2D
    ...
```

`#` lines are comments and may appear anywhere. Top-level keys are exactly `version`,
`description`, `metadata`, `root`.

### Generating a scene from a script

Many nodes at once (a board, a level from data) are easier to emit from a script than to type.
`yaml`'s default `stringify` writes every array one item per line — `position:` then three
`- n` lines — which triples the file and earns `W_EXPANDED_ARRAY`. Write it the way the editor
does (`yaml` is installed with `@pix3/runtime`):

```js
import { writeFileSync } from 'node:fs';
import { Document, isScalar, visit } from 'yaml';

const doc = new Document(scene); // parseDocument(text) to reformat a file and keep its comments
visit(doc, {
  Seq(_, n) {
    if (n.items.length > 0 && n.items.every(i => isScalar(i))) n.flow = true;
  },
  Map(_, n) {
    const xyz =
      n.items.length >= 2 &&
      n.items.length <= 3 &&
      n.items.every(
        p => ['x', 'y', 'z'].includes(String(p.key?.value)) && typeof p.value?.value === 'number'
      );
    if (xyz) n.flow = true;
  },
});
writeFileSync(
  'scenes/level.pix3scene',
  doc.toString({ indent: 2, flowCollectionPadding: false, lineWidth: 0 })
);
```

## Node

```yaml
- id: spawner-targets # REQUIRED. Unique across the scene incl. instanced prefabs.
  type: Group2D # REQUIRED for a plain node. Exact class name (see pix3-nodes).
  name: Spawner Targets # display name; free to change
  groups: [spawners] # optional runtime groups
  properties: # node properties — names from pix3-nodes
    width: 900
    height: 60
    transform:
      position: [0, 690]
      scale: [1, 1]
      rotation: 0
  components: # optional; script components
    - id: target-spawner
      type: user:Spawner
      enabled: true
      config:
        prefab: res://scenes/prefabs/target.pix3scene
        intervalSec: 0.85
  children: [] # optional; child nodes, same shape, recursive
```

Rules:

- **`id`**: short, readable, kebab-case, unique (`combo-label`, `spawner-bonus`). Two nodes
  with the same id fail the load. Never rename an id other scripts use — scripts
  find nodes by id; rename `name` instead.
- **`type`**: must be a real node type. An unknown or misspelled type does **not** fail the
  load — the node becomes an inert placeholder that draws and does nothing.
- **`properties`**: unknown keys are kept silently and do nothing; a value of the wrong type
  (a string where a number belongs) is silently replaced by the default. Check names and
  types against `pix3-nodes`.
- **`children`**: tree order is 2D paint order — a later sibling, or a deeper node, draws on
  top. `zIndex` overrides it.

### 2D transform

```yaml
transform:
  position: [x, y] # design pixels; the node's CENTRE, relative to its parent
  scale: [1, 1]
  rotation: 0 # DEGREES in YAML; positive = counter-clockwise (Y is up)
```

2D space: origin at the centre of the screen/parent, **X right, Y up**. A portrait game uses e.g. a
1080 x 1920 design (top edge y = 960, bottom y = -960); other projects read
`viewportBaseSize` / `projectType` in `pix3project.yaml` — a `3d` project may have loose
top-level 2D nodes (a HUD) and no 2D root at all, so position new HUD relative to the HUD
nodes that are already there. Scripts see the rotation in
radians (`node.rotation.z`). `{ x: 0, y: 690 }` is also accepted for a vector, and so is a flat
`position:` beside `transform` (read-compat), but write the `transform:` block the editor saves.

3D nodes (`Node3D`, meshes, cameras, lights) use
`transform: { position: [x, y, z], rotationEuler: [dx, dy, dz], scale: [1, 1, 1] }`,
rotation in degrees.

### Anchor layout (2D)

```yaml
layout:
  enabled: true
  horizontalAlign: left # left | center | right | stretch
  verticalAlign: top # top | center | bottom | stretch
  left: 40 # margins, px from the parent's edge to the node's same edge:
  top: 30 # `left` keeps `left`, `right` keeps `right`, `stretch` keeps both
```

An anchored axis is placed by its margin, and keeps it when the parent resizes (a different
screen aspect, a container resized in the editor). On that axis the `transform.position`
component is ignored — write `0` — and under `stretch` the node's `width` / `height` is derived
from the two margins, so leave it out (a `Checkbox2D`'s `size` / `Joystick2D`'s `radius` too: its
side is the stretched span). A centred axis has no margin: `position` places it, as
for any node. A file with the anchors but **no margins** still loads: the margins are read off
the rect, and the editor rewrites the node in the margin form the first time it saves the file.
`pix3 tree <scene>` prints the margins and the rect they give at the design size —
`pos=(-400,900) size=200x60 layout=left/top(left=40,top=30)` — so to move such a node, change
its margin, not its `position`.
HUD widgets anchor to screen edges; full-screen backgrounds and roots use `stretch` on both
axes (a root's reference is `viewportBaseSize`, so a root keeps its full rect, no margins).

**Tall phones and the notch.** The game scales the design to fit the screen (the smaller of the two
ratios), so on a phone taller than the design the screen has spare height. A HUD anchored to the
screen's top then drifts away from a board in the middle. The 2D starter's scene already has the
fix: put the HUD and the game in **`design-area`** — an unanchored `Group2D` of the design size —
and anchor the HUD to `design-area`'s edges, not the screen's; only the background (and anything
that must reach the real screen edge) stays on `game-root`. `design-area` has
`layout: { enabled: false, safeArea: true }`: it is centred in the screen's **safe area** (minus the
notch and the home indicator). `safeArea: true` works on a child of a full-screen root (a node
anchored to the top with it measures `top` from below the notch); deeper it does nothing. A project
without `design-area`: add one as the last child of the 2D root and move the HUD and the game into
it. Check it with `npx pix3 play --size 390x844 --safe-area 47,0,34,0 --screenshot shot.png`: the
notch and the home indicator are the magenta bands on the picture, and nothing may sit in them.

**A HUD over a 3D world on a phone.** The 3D camera scales the world by itself; the HUD is scaled
by the design fit, and a landscape design on a portrait phone fits by its long side (1920 → 375 px:
×0.2). In the game script's `onStart`:
`this.scene.setDesignFit({ orientation: 'adaptive', minScale: 0.45 })`. `adaptive` lays the HUD out
against the design turned the screen's way (1080×1920 on a portrait screen); `minScale` is the least
CSS px a design pixel is drawn at — below it the layer shows **less of the design** instead of
shrinking (a 375 px phone at 0.45 is 833 design px across). So: anchor every HUD block to an edge or
the centre (`layout:`), keep each block narrower than the narrowest layer you target (833 px here),
never position HUD by absolute design coordinates (`±960`): ask
`this.scene.getLogicalCameraSize()` for the layer's current size. Check with
`npx pix3 play dev --size 375x667 --screenshot shot.png` and `--size 667x375`. Not for a 2D game
whose world is laid out in design pixels: it would crop the board.

**A new HUD node must not overlap the HUD that is already there.** Before you place it, read
the `position`, `width`/`height` and anchoring of its siblings and pick a free spot (a combo
label placed "top-right" once landed under the game's Shop button). With the editor open,
confirm it with `pix3_screenshot` + `take_screenshot` while the game runs (`pix3-editor`);
without it, ask the human to look.

Flow (stack children in a row/column) is a separate block:
`flow: { enabled: true, direction: vertical, gap: 16, paddingX: 0, paddingY: 0, align: start, autoSize: false }`.

The flat names `layoutEnabled`, `horizontalAlign`, `flowEnabled`, `flowGap` … are the
inspector's names for the same values: on a plain node they belong in these blocks (flat they
are ignored — `pix3 validate` says so); on an **instance** node they are the only form (below).

### Values

- **Colour**: a quoted hex string, `color: "#141a2e"`. Always quote — an unquoted `#` starts
  a YAML comment and the value becomes empty.
- **Asset path**: `res://` + path from the project root (the folder with `pix3project.yaml`),
  whatever the layout: `res://sprites/ph-target.png` in a new project, `res://src/assets/textures/x.png`
  in a project that keeps assets under `src/`. Follow the folders the project already has; a
  new project from `pix3 new` uses one folder per type at the root (`sprites/`, `audio/`,
  `fonts/`, `models/`, `spine/`, `scripts/`, `scenes/`).
- **Texture slot**: `texture: { type: 'texture', url: 'res://sprites/x.png' }` (same shape for
  `textureNormal`, `textureFill`, …). The saver always writes this form; a bare
  `texturePath: 'res://…'` string is only read for compatibility.
- **Strings** with `:` `#` `{` or leading spaces: quote them (`label: "SCORE 0"`).
- **Vectors and arrays** of numbers or strings go on one line: `position: [0, 1, 0]`,
  `groups: [enemy, boss]` — never a key followed by one `- n` line per item (`W_EXPANDED_ARRAY`).
  A list of nodes or of arrays stays one item per line.
- **Flipbook**: an `AnimatedSprite2D` points at a `.pix3anim` (`animationResourcePath`) — a JSON
  file of named clips; its fields and defaults are in `pix3anim.md` beside this file. A character
  with variants and states is compiled, not hand-written: `pix3 character-compile`.

### Shader effects (`Sprite2D`, `AnimatedSprite2D`, `Button2D` only)

```yaml
effects:
  - type: core:tint
    params: { color: '#7ee787', amount: 1 }
```

`core:tint` multiplies a near-white placeholder PNG to the colour — this is how
placeholders get their palette. Also `core:adjust`, `core:grayscale`, `core:flash`,
`core:uv-scroll`, `core:dissolve`. Other 2D nodes do not read `effects` (a `ColorRect2D` takes
its colour from `color`). On a `GeometryMesh` the stack lives at `material.effects`.

## Component

```yaml
- id: combo # readable id; keep it unique in the scene
  type: user:Combo # user:<ExportedClassName> (scripts/*.ts) or core:<Name>
  enabled: true
  config: # keys = names in the component's getPropertySchema()
    windowSec: 1.2
```

- `config` is **merged over** the defaults the script's constructor sets, so write only the
  keys you want to differ.
- A `user:X` whose class does not exist (or has no `static getPropertySchema()`) is kept as
  "pending" with a console warning and never runs.
- Built-ins (`core:*`) and every config key they take, with defaults, are listed in
  `.claude/skills/pix3-scripts/reference.md` ("`core:` components").

## Prefab instance

```yaml
- id: result-overlay
  name: Result Overlay
  instance: res://scenes/ui/result.pix3scene
  properties:
    visible: false
    transform: { position: [0, 0] }
```

- `instance:` **replaces** `type:`. The instanced file must contain **exactly one** root node.
- The instance node's `name` **replaces the prefab root's name** in the loaded scene (its `id`
  stays the instance's own id). `findByName('Result Overlay')` finds the instance above, not
  the name written in `result.pix3scene`; omit `name` to keep the prefab's.
- Instance `properties` are applied to the prefab's root through its **schema names**:
  `visible`, `opacity`, `width`, `layoutEnabled`, `horizontalAlign`, the margins `layoutLeft` /
  `layoutRight` / `layoutTop` / `layoutBottom`, … plus a `transform` block (`position`,
  `rotation`, `scale`). The `layout:` / `flow:` blocks of a plain node are not read here — write
  `layoutEnabled: true` + `horizontalAlign: right` + `layoutRight: 20` instead. A **texture**
  overrides too — one cell prefab, a different gem per instance:
  `properties: { texture: { type: texture, url: 'res://sprites/gem-red.svg' } }` (on the
  instance for the prefab's root, under `overrides.byLocalId` for an inner `Sprite2D`).
- Do **not** add `components` or `children` to an instance node — they are ignored (the
  content comes from the prefab). To change what is inside, edit the prefab file itself, or
  override one inner node's properties:

  ```yaml
  overrides:
    byLocalId:
      retry-button: # an id below the prefab root; nested: parent-id/child-id
        properties: { label: 'AGAIN' } # schema names, as on the instance itself
  ```

- Nodes inside an instance keep their authored ids when those are unique, so scripts can find
  them by id (`retry-button` inside `scenes/ui/result.pix3scene` is found as `retry-button`).
- A prefab carries fixed defaults only (e.g. its `core:Hitbox2D` group). Tunables live on
  plain nodes in the host scene.
- **A prefab with states** (a building abandoned / working, a chest closed / open): one child
  group per state under the root, named for the state (`abandoned`, `active`), all but the
  default one `visible: false` in the file. A script shows one: `root.findByName('active')` —
  by **name**, because inner ids are renamed in every instance but the first — and sets
  `.visible`. A host scene that needs a fixed state overrides it:
  `overrides: { byLocalId: { hut-abandoned: { properties: { visible: false } }, hut-active: { properties: { visible: true } } } }`;
  a node deeper than the root's children is keyed by its path of ids, `hut-active/hut-active-farm`.
- **A model sheet** for a set of prefabs: a scene outside `scenes/prefabs/` (so it is playable,
  never the entry scene) with the game's camera and lights and one instance per prefab and state,
  placed in a grid with the overrides above. Open it as `/?clean&scene=scenes/<sheet>.pix3scene`
  and judge the whole set at game scale in one screenshot.
- Where prefabs live: `scenes/prefabs/` or a top-level `prefabs/` — the export
  treats both (and `scenes/ui/`) as prefabs, never as a boot scene.
- Spawned at runtime with `await this.scene.instantiate('res://scenes/prefabs/x.pix3scene', { parent })`.
- Turning a branch of a scene into a prefab (the editor has no "Save as Prefab"):
  `project-files.md` → "Extract a branch into a prefab".

## Full-screen UI lives in `scenes/ui/`

A result card, pause menu or modal is its own file in `scenes/ui/`, instanced into the host
scene with `properties: { visible: false }`. Two different flags, both needed:

- `visible: false` on the **instance** — hides it in the **editor**, so `main.pix3scene`
  opens on the game, not on a GAME OVER card. Never remove it.
- `initiallyVisible: false|true` on the **overlay file's root node** — what **play mode**
  applies at start. A script reveals the overlay by setting `node.visible = true`.

**The overlay file's root is a `CanvasLayer2D` stretched over the screen**, and its instance is
the **last child** of the host's 2D root (`game-root`, which covers the screen). A `CanvasLayer2D` subtree is drawn in its own
pass after the game, so every `scene.juice` effect of the game (a cascade's "AMAZING!", a burst)
stays **under** the card, a `shake('camera2d')` does not shake it and post-processing does not blur
it — no `zIndex` and no delayed reveal needed. An effect anchored to a node **inside** the card
(`scene.juice.burst('again-button')`) is drawn in the card's layer, on top of it. In the editor a
`CanvasLayer2D` draws in tree order, so keep the instance last to see the same stacking there.

```yaml
# scenes/ui/result.pix3scene
root:
  - id: result-layer
    type: CanvasLayer2D
    name: Result
    properties:
      width: 1080 # viewportBaseSize; the layout stretches it over the real screen
      height: 1920
      initiallyVisible: false
      layout:
        {
          enabled: true,
          horizontalAlign: stretch,
          verticalAlign: stretch,
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        }
    children:
      - id: dimmer # stretched too: the whole screen, a tall phone's top and bottom included
        type: ColorRect2D
        name: Dimmer
        properties:
          color: '#000000'
          opacity: 0.6
          layout:
            {
              enabled: true,
              horizontalAlign: stretch,
              verticalAlign: stretch,
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            }
      - id: card # the card, its title and PLAY AGAIN: centred in the safe area
        type: Group2D
        name: Card
        properties:
          width: 900
          height: 1100
          layout: { enabled: false, safeArea: true }
        children: […]
```

A root of the design size (no `layout`) dims only the design: on a phone taller than the design the
top and bottom of the screen stay bright (core-tests/game16).

**A celebration over the card** (the win confetti, a "+500" on the result): anchor the effect to a
node of the card, never to a point of the game's world — an effect in world coordinates is a game
effect and is drawn **under** the card (core-tests/game18's victory burst was invisible). A node
of the card, or a point in one, puts it in the card's layer, above the dimmer, the card and its
text:

```ts
// in the script that reveals the card
result.visible = true;
this.scene.juice.burst({ x: 0, y: 420, in: 'card' }, { count: 48, colors: ['#ffcf33', '#ff4d6d'] });
this.scene.juice.burst('result-title', { count: 24 }); // or on a node of the card
this.scene.juice.floatText('+500', { at: 'result-score', color: '#ffcf33' });
```

`{ x, y, in: 'card' }` is a point in the card's own space (its centre is 0, 0, Y up). A `flash` or a
`shake('camera2d')` is a game effect: fire it before the card shows.

Never put a full-screen dimmer/panel inline in `main.pix3scene`.

## Known gaps

- `metadata.description` is free text; nothing reads it but humans.
- Instance overrides of **components** inside a prefab are not supported from the host scene.
