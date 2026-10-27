{{# Template of the kit's AGENTS.md. Generated into projects by `pix3 kit` / `pix3 new`; see }}
{{# packages/cli/src/kit/generate.ts for the directive syntax. }}
<!-- Pix3 agent kit {{version}} — written by `pix3 kit`. You may edit it: `pix3 kit --update` never overwrites a kit file you changed. -->
# AGENTS.md — Pix3 game project

This folder is a **Pix3 game**: a 2D/3D browser game. You edit it by writing files. A human
has the same folder open in the Pix3 editor, moves things with the mouse and presses Play;
the editor saves their edits to the same files. The files are the whole contract.

A project made by `npm create pix3` starts **empty**: one entry scene (`scenes/main.pix3scene`,
a 2D root and background, or a 3D camera and lights) and no scripts. The game is yours to build.

## New-game architecture and UX gate

For a new game, keep the standard `startGame` + `pix3()` player/editor path. Use
`.pix3scene` files and Script components so the human can inspect and iterate on
the actual game in `/__pix3/`. A runtime import wrapped around a custom canvas or
DOM game is not equivalent. The consumer path is for an explicitly required host.
The engine renders through three.js, but this is not a three.js app: generic
three.js or game-engine skills (a `WebGLRenderer`, a hand-rolled render loop) do
not apply here, and the `pix3-*` skills win wherever they disagree.

Before implementation, translate supplied references into player actions, visible
feedback, hierarchy, control sizes and asset requirements. Treat a reference's
visual inventory slots as a requirement for visual selection, not merely a color
palette. Do not substitute numeric controls or prose for recognizable content.

Build and review a reusable UI kit using runtime UI nodes and skin textures:
panels, slots, tabs, buttons, bars, icons, selected/pressed/disabled states.
Use native InputService actions and control signals, including Joystick2D for
touch movement. Do not introduce a parallel DOM UI or browser-input layer.
Before implementing animation, camera, physics or input, read the installed
`.claude/skills/pix3-nodes/SKILL.md` and `.claude/skills/pix3-scripts/SKILL.md`; their
`reference*.md` files are lookups — each opens with a contents list, grep the one heading you
need, never read them whole. Use `.claude/skills/pix3-editor/SKILL.md` for iteration.

Completion requires inspection of the running editor and game at the target
device size, an interaction check through actual input, and comparison to the
reference. Check control sizes in CSS pixels on the smallest target screen — a
touch target at least 44 px, text at least 16 px. The game scales its design viewport
(`viewportBaseSize`) to fit the screen, so CSS px = design px × min(screen width / design
width, screen height / design height): a 1080×1920 design on a 390×844 phone is ×0.36, so a
16 px text needs `labelFontSize` ≥ 45 and a 44 px button ≥ 122 design px. A board of cells (an
8×8 match-3 on a 360 px phone is ~42 px a cell) cannot always reach 44 px: give the board the full
width, take the whole cell (no dead gaps) as the hit area, and say in the report that a cell is
below the guideline and why. On touch devices, also verify
simultaneous actions such as movement and jump when the game uses them. A build,
a debug command or a screenshot alone is not enough.

## Read first

1. `README.md` — file layout of this project.
2. The one scene or script you are about to change. Nothing else. Do not survey the repo.
   To find it, and to find your way inside it, use `pix3 tree` (every scene and prefab with
   node counts, types and components) and `pix3 tree <scene>` (one line per node: id, type,
   position, size, layout, components, prefab instances) — not a read of whole scene files.
   Read the file itself right before you edit it (rule 2).

## Layout

The layout is **whatever this project has** — do not assume folders. Three rules hold everywhere:

- **Scenes**: find them with a glob `**/*.pix3scene` outside `node_modules/` (and `.pix3/`).
  `defaultExportScenePath` in `pix3project.yaml` names the build's entry scene.
- **`res://` is always relative to the project root** (the folder with `pix3project.yaml`), so
  `res://src/assets/textures/x.png` is as normal as `res://sprites/x.png`. Copy the style the
  scene you are editing already uses.
- **Scripts** live under `scripts/**` or `src/scripts/**` (the only two roots the editor and
  `pix3 check` scan). `export class X extends Script` → `type: user:X`.

`pix3project.yaml` is the manifest (do not edit unless asked); `.pix3/` is editor + CLI
bookkeeping (`dev.json` of the running dev server, the version journal, script types) — read
`dev.json`, never edit anything there.

**The editor never creates, renames, moves or deletes a file, never edits `pix3project.yaml` and
never builds — you do.** New scene, rename/move/delete with every reference, a branch turned into
a prefab, a new flipbook, a locale added or removed, project settings, build options:
`.claude/skills/pix3-scene-format/project-files.md`.

Example — the layout `npm create pix3` sets up (`pix3 new`); other projects differ:

| Path | What |
| --- | --- |
| `scenes/*.pix3scene` | Scenes |
| `scenes/ui/*.pix3scene` | Full-screen overlays (result card, modal), one file each, a `CanvasLayer2D` root, instanced hidden as the last child |
| `scenes/prefabs/*.pix3scene` | Prefabs: a scene file with exactly ONE root node (a top-level `prefabs/` works too) |
| `scripts/*.ts` | Script components |
| `sprites/`, `audio/`, `fonts/`, `models/` … | Assets, referenced as `res://sprites/x.png` |
| `design/` | Design notes, GDD, references |
| `src/main.ts`, `index.html`, `vite.config.ts` | The Vite entry: `startGame('#app')` boots the entry scene; `pix3()` serves the editor at `/__pix3/` |

## The five rules

1. **Playable change first, questions after.** Make the change the user asked for, in the
   smallest form that plays, before asking anything. Choose small things yourself (a shade, a
   speed, a count) and say so in one line. At most ONE question per turn, and only about a
   fork that changes structure ("win by score or by time?"). Never open with a question.
2. **Sync, then re-read a scene before you edit it.** The human may have moved things in the
   editor a minute ago; a successful `pix3_sync` puts their unsaved edits on disk. Edit the lines
   you mean to change (search/replace), never regenerate a whole scene from memory. After
   writing, `pix3_sync` again with `expect` = the sha256 of every file you wrote
   (`.claude/skills/pix3-editor/SKILL.md`).
3. **Own the requested UX and visual quality.** Implement layout, colours and fine-tuning
   against the references, then verify them at the target device size. Keep the result
   editable in the editor; that is an iteration tool, not a reason to leave polish undone.
4. **Run `pix3 check` after every batch of edits** and fix every error before you say "done".
   It checks YAML, node types, properties, `res://` paths, prefabs, components, and
   type-checks your scripts. Then run the game: with the editor open, `pix3_sync` with `expect`
   and `pix3_play` / `pix3_game_run` / `pix3_errors` / a screenshot (`pix3-editor`); without it,
   `pix3 smoke <the scene you changed>` — the game, not the menu, which never presses PLAY
   headless (`pix3-verify`). A sync that is not `ok` is not green, and a green smoke means
   nothing threw, not that it plays — so tell the human what to press and what they should see.
5. **Art: placeholder → SVG → a generated image, never emoji.** Placeholder = `ColorRect2D`, or
   a near-white PNG in `sprites/` tinted with a `core:tint` effect. Better art = an SVG you
   write into `sprites/` (`pix3-nodes` → "An SVG you write as a sprite") — or an image the
   human generates. A label/text that is only emoji is refused — emoji are not art. For a set
   of related art (enemies, tiles, icons), get one piece right at game scale first and make
   the rest from it — same palette, view, outline and detail. Note the source and licence of
   every image you import or generate beside it. List every placeholder you leave.

## YAML essentials (`.pix3scene`) — details in `pix3-scene-format`

```yaml
version: 1.0.0
metadata: { description: 'what this scene is' }
root:
  - id: game-root                  # unique in the scene; never rename an existing id
    type: Group2D                  # exact node type name; a typo loads as an inert node
    name: Game Root
    properties:
      width: 1080
      height: 1920
      transform: { position: [0, 0], scale: [1, 1], rotation: 0 }   # 2D, rotation in degrees
    components:
      - id: game-rules
        type: user:GameRules       # user:<ExportedClassName> or core:<Builtin>
        enabled: true
        config: { targetScore: 18 } # keys = the script's schema names
    children:
      - id: result-overlay         # prefab/overlay instance: NO type, NO components
        name: Result Overlay
        instance: res://scenes/ui/result.pix3scene
        properties: { visible: false }
```

- The sample assumes a 1080×1920 portrait 2D root; yours may not have one — read
  `viewportBaseSize` and `projectType` in `pix3project.yaml`, and place new HUD relative to the
  HUD that exists (`pix3-scene-format` → "2D transform").
- 2D space: design pixels, origin at the screen centre, **X right, Y up**. `position` is the
  node's centre. Tree order is paint order: later/deeper draws on top.
- **Quote every colour**: `color: "#141a2e"`. Unquoted, `#` starts a YAML comment.
- Textures: `texture: { type: 'texture', url: 'res://sprites/ph-target.png' }`.
- `visible: false` on an overlay instance hides it **in the editor only**; play mode reads
  `initiallyVisible` on the overlay file's root. Set both. The overlay's root is a `CanvasLayer2D`, so the game's
  juice effects stay under it (`pix3-scene-format` → "Full-screen UI").
- The loader is forgiving — unknown types, unknown keys and wrong value types load silently
  as nothing. That is why rule 4 exists.

## Script essentials — details in `pix3-scripts`

```ts
import { Script, type PropertySchema } from '@pix3/runtime';

export class Combo extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = { windowSec: 1 };            // defaults; scene `config` merges over them
  }
  static getPropertySchema(): PropertySchema {  // REQUIRED, or the class is not registered
    return { nodeType: 'Combo', properties: [/* one entry per config key */], groups: {} };
  }
  onStart(): void {}                           // scene is loaded
  onUpdate(dt: number): void {}                // dt in seconds
}
```

- One mechanic = one new script (most are 70–200 lines; keep the engine-free rules of a bigger
  one — a match-3 board, a level generator — in a plain module beside it).
- Talk between scripts the way the project already does. In a new project use signals on nodes:
  `node.emit('touch-scored', 1)` / `node.connect('touch-scored', this, fn)`; once named, never
  rename a signal or a node id other scripts use. An existing game may use its own event bus or
  store instead (next section).
- Transforms are mutated, never assigned: `node.position.set(x, y, 0)`, `node.rotation.z = rad`.
- Types come from `@pix3/runtime`: `pix3 check` type-checks against the bundled declarations in
  `.pix3/types/` (or against your own `node_modules` when the project has its own `tsconfig.json`).

## Hosting an existing game

A game that was not made from `npm create pix3` has its own architecture; plug into it, do not
add a second one — its event bus or store, its own shake/sound/tween helpers, and cleanup by
hand of everything that is not a node signal (`pix3-scripts` → "Hosting an existing game").

- **Two instruction files.** The project's own `AGENTS.md` wins on **process** (planning first,
  where config and tests go, commit rules); this kit wins on **Pix3 facts** (the YAML format,
  the runtime API, `pix3 check`).
- The project's own `package.json` means `npm install` before `pix3 check` can type-check.

## The CLI and the editor bridge

A project made by `npm create pix3` has them as npm scripts: `npm run dev` (Vite: the game at
`/`, the editor at `/__pix3/`, on the port Vite got — 5173 only if it was free; read
`.pix3/dev.json`), `npm run editor` (`pix3 editor`), `npm run build` (`dist/`),
`npm run preview` (serve the build), `npm run check` (`pix3 check`), `npm run smoke`
(`pix3 smoke`; pass the scene after `--`). Elsewhere call `npx pix3 …` or read `package.json`.

- `pix3 check [--json]` — after every batch (rule 4); `--json` prints `files` (`{ file, sha256 }`)
  for `pix3_sync`'s `expect`. It flushes the open editor's unsaved edits first (`--no-sync`
  skips that). `pix3 validate [paths…]` — scenes only, no type-check.
- `pix3 smoke [scene] [--frames N] [--json]` — run a scene headless (no browser); exit 1 on a
  script throw, `console.error` or unhandled rejection. Name the game scene.
- `pix3 tree [scene] [--types A,B] [--depth N] [--props] [--json]` — scene outline, one line
  per node; no scene = project overview.
- `pix3 font add <family>` — copy a bundled display font (Nunito, Rubik — both with Cyrillic —
  Baloo 2, Fredoka, Lilita One, Luckiest Guy; `pix3 font` lists them) into `fonts/` and register
  it in `pix3project.yaml`. Text without one renders in each machine's own system face.
- `pix3 editor` — find (or start) the dev server and open the editor in a Chrome reachable only
  through its token proxy; `pix3 agent-setup [claude|codex] [--repair]` — write the project's
  MCP config for `chrome-devtools-mcp`, once (never commit it).
- `pix3 gap "<what was missing>" --kind capability|tool|node|doc|other [--detail "…"] [--context "<file or task>"]`
  — when you had to **work around** something Pix3 does not have (an engine capability, a bridge
  tool, a node type, a doc that was missing or wrong), record it once, after the workaround: one
  line in `.pix3/gaps.jsonl` (local, read by the Pix3 team). Sparingly — not for your own
  mistakes, a question to the human, or a feature the game itself should implement.
- **The editor bridge.** With the editor tab open, the `pix3-browser` MCP server (Chrome
  DevTools) reaches it: `list_pages` → `select_page` → `list_3p_developer_tools` → the
  `pix3_*` tools — sync the editor with the disk, play, step the game with predicates, read the
  scene and the errors, prepare a screenshot. There is no scene-editing tool — you still edit
  files. No `pix3-browser` server → `npx pix3 agent-setup`, then a new thread — or, when you
  cannot start one (a subagent, CI), the same tools from the shell: `npx pix3 bridge <tool>`. The loop, the
  not-ok answers and the inline fallback: `.claude/skills/pix3-editor/SKILL.md`.

## Skills (read the one you need, when you need it)

- `.claude/skills/pix3-scene-format/SKILL.md` — full YAML format, prefabs, overlays; `.pix3anim` flipbooks and `pix3 character-compile` in `pix3anim.md` beside it; file and project operations the editor does not do in `project-files.md` beside it
- `.claude/skills/pix3-nodes/SKILL.md` — 2D node properties (Group2D, ColorRect2D, Sprite2D, Label2D, Button2D, Bar2D, CanvasLayer2D, PostProcess); every 2D node in `reference.md` beside it, 3D in `reference-3d.md`
- `.claude/skills/pix3-scripts/SKILL.md` — Script API: lifecycle, schema, scene/input/juice/tween/audio/physics, `core:` components, traps
- `.claude/skills/pix3-editor/SKILL.md` — the editor bridge: find the tab, `pix3_sync` with `expect`, play ownership, `pix3_game_run`, screenshots, inline fallback
- `.claude/skills/pix3-verify/SKILL.md` — `pix3 check` / `validate` / `smoke`, the diagnostic codes, how to report what was verified

## Finish every turn with

What changed (files), what `pix3 check` said, whether you ran the game (and what `pix3_game_run`
answered) or what the human should press and see, placeholders left, and 2–3 concrete next steps.
