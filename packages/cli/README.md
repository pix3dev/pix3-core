# @pix3/cli

Command line for Pix3:

```text
pix3 new [<2d|3d> [dir]] [--name <n>]         create an empty 2D or 3D project (npm create pix3)
pix3 editor [--project <dir>] [--stop] [--stop-chrome] [--chrome-only] [--no-chrome] [--port <n>] [--cdp-port <n>] [--headless]
                                              find/start the dev server, open the editor in Chrome (CDP behind the token proxy)
pix3 agent-setup [claude|codex] [--repair] [--cdp-port <n>] [--project <dir>]
                                              write the project's chrome-devtools-mcp config
pix3 validate [paths…] [--json]               strict scene check
pix3 check [--json] [--no-hydrate] [--offline] [--no-sync] [--project <dir>]
                                              validate + tsc over the scripts + versions
pix3 smoke [scene] [--changed|--all] [--frames N] [--timeout S] [--json] [--project <dir>]
                                              run the game headless in Node, report what threw
pix3 tree [scene] [--depth N] [--types A,B] [--props] [--json] [--project <dir>]
                                              scene outline, one line per node; no scene = overview
pix3 kit [--update] [--migrate] [--project <dir>]
                                              install / update the agent kit; --migrate: a 1.x kit → 2.x
pix3 character-compile <spec> [--dry-run] [--force] [--json] [--project <dir>]
                                              a 2D character (.pix3anim + prefab) from frame PNGs
pix3 sfx <preset|"text"> [--out <f.wav>] [--seed <n>] [--json]
                                              synthesize a sound effect to WAV, offline
```

`pix3 new` is what `npm create pix3` runs: the `base` layer of `packages/create-pix3/templates/`
(package.json, vite.config.ts with `pix3()`, index.html, src/main.ts, tsconfig.json, gitignore)
plus the `2d` or `3d` layer (one empty entry scene), `{{PROJECT_NAME}}` / `{{PACKAGE_NAME}}` /
`{{PIX3_VERSION}}` substituted, `pix3project.yaml` generated, then the agent kit. Nothing in it plays a
game. Record: `.plans/templates.md`.

`new`, `kit`, `editor` and `agent-setup` load neither TypeScript nor the kit generator: the kit
and the runtime types are prebuilt into the package (`kit/`, `dist/runtime-types.json`, at
`prepack`).
`tree` reads YAML only; `smoke` and `tree --props` load the runtime from a bundle prebuilt at
`prepack` (`dist/smoke/prebuilt/`, like validate's), so none of this slows `new` / `editor`.

Coding agents drive the open editor tab through Chrome DevTools MCP (`chrome-devtools-mcp`): the
tab registers its `pix3_*` tools on the page (`packages/editor-core/src/host/bridge-tools.ts`),
`pix3 editor` puts that tab in a Chrome whose DevTools protocol is reachable only through its
token proxy, `pix3 agent-setup` points the agent's MCP config at the proxy with the token. There is no Pix3 MCP server (plan §D.2); the agent-facing procedure is
the kit's `pix3-editor` skill.

## `pix3 check` — everything an agent should run after a batch of edits

`pix3 check` = `pix3 validate` (both levels) + a TypeScript type-check of the project's scripts +
a version check. Exit 0 = no errors (warnings
allowed), 1 = at least one error, 2 = could not run. Files are the truth only once the editor has
written them: when `.pix3/dev.json` names a live dev server, `check` first asks it to flush the
editor's unsaved scenes (`POST /__pix3/api/flush`, up to 15 s; `--no-sync` skips it, a dead
server is ignored). Diagnostics are one list, validate's plus:

| Code | Severity | When |
| --- | --- | --- |
| `E_TYPE` | error | a tsc diagnostic (`message` starts with `TS<code>:`; `file`, `line`) |
| `E_TYPECHECK_UNAVAILABLE` | error | TypeScript could not be found or installed (`fix` = the command to run) |
| `E_EDITOR_UNSYNCED` | error | `.pix3/dev.json` points at a live dev server whose editor did not flush its unsaved scenes within 15 s (`--no-sync` reads the disk as it is) |
| `E_RUNTIME_VERSION` | error | the version gate: the project resolves a `node_modules/@pix3/runtime` that is not the runtime this CLI validates (and smoke-runs) with — run the project's own CLI (`npx pix3 …`) or install the matching runtime |
| `W_PIX3_VERSION_MISMATCH` | warning | an installed `@pix3/cli`, `@pix3/vite-plugin` or `@pix3/editor-core` is not this CLI's version (lockstep packages) |
| `W_RUNTIME_NOT_INSTALLED` | warning | own `tsconfig.json`, and no `node_modules/@pix3/runtime` |
| `W_KIT_OUTDATED` | warning | `metadata.agentKit.version` is not this CLI's version (`pix3 kit --update`) |
| `W_EDITOR_HMR_API` | warning | `import.meta.hot` in a module the editor runs |
| `W_EDITOR_CSS_IMPORT` | warning | a stylesheet import (not `?inline`/`?raw`/`?url`) in a module the editor runs |
| `W_EDITOR_DYNAMIC_IMPORT` | warning | an `import()` whose argument is not one plain string, in a module the editor runs |

"A module the editor runs" = the editor's script chain (plugin contract B): `scripts/**`,
`src/scripts/**`, `design/tests/bots/**` (`.ts`, minus specs/tests/`.d.ts`) and every local module
they import, transitively; `message` names the root that reaches it. Each of the three makes Vite
put `/@vite/client` on the editor page, and then the game's `full-reload` reloads the editor too.
The scan is lexical (`src/check/editor-chain.ts`), bare packages are not followed.

`--json`:

```text
{
  "ok": true, "projectRoot": "…", "errorCount": 0, "warningCount": 2,
  "level2": { "state": "ran", "filesHydrated": 5, "filesSkipped": 0, "filesSkippedForScripts?": 0 },
  "files": [{ "file": "scenes/main.pix3scene", "sha256": "<hex of the raw bytes>" }],
  "diagnostics": [{ "severity", "code", "file", "line?", "nodeId?", "path?", "message", "fix?" }],
  "notes": [],
  "typecheck": { "ok": true, "errors": 0, "tsconfig": ".pix3/tsconfig.check.json", "mode": "pix3-types",
                 "files": 5, "typescript": { "version": "5.8.3", "source": "cache" } },
  "kit": { "version": "1.6.0", "cliVersion": "1.6.0", "upToDate": true },
  "timingsMs": { "validate": 190, "typecheck": 1180, "total": 1380 }
}
```

`files` holds every scene validated and every script type-checked, hashed over the **raw bytes** —
the hashes `pix3_sync`'s `expect` takes. `typecheck.errors` counts the
`E_TYPE` / `E_TYPECHECK_UNAVAILABLE` entries of `diagnostics`.

**A compile error hides level 2.** When the scripts do not compile (`E_SCRIPT_COMPILE`), level 2
skips every scene with `user:` components — their `E_UNKNOWN_CONFIG_KEY` / `E_PROPERTY_TYPE` /
component checks are *missing*, not passed. The report says so: `level2.filesSkippedForScripts`,
a `SKIPPED: N scene(s) …` note, and the human summary line reads `level 2 hydrated 0 file(s), N
SKIPPED (scripts do not compile — user: components unchecked)`. Fix the compile error and run again.

**Which tsconfig.** A project with its **own** root `tsconfig.json` (a Vite project — every
`npm create pix3` starter — or one the editor's *build from templates* turned into one) is checked with it, as is, against its own
`node_modules` (`mode: "project"`); nothing is written into it. Otherwise (`mode: "pix3-types"`)
`check` uses `.pix3/tsconfig.check.json` against the bundled types in `.pix3/types/`, and first
(re)writes both when they are missing or from another CLI build.

**Where TypeScript comes from** — it is not a dependency of `@pix3/cli`: (1) the project's own
`node_modules/typescript` (or an ancestor's); (2) the CLI's sibling install
(`import.meta.resolve('typescript')`, e.g. the monorepo); (3) `~/.pix3/typescript/5.8.3/`,
installed there once with `npm install --prefix ~/.pix3/typescript/5.8.3 typescript@5.8.3 …`
(printed before it runs). `--offline` never installs: it fails with `E_TYPECHECK_UNAVAILABLE` and
the command. `PIX3_TYPESCRIPT=<package dir>` overrides the search. Loaded with a dynamic `import()`.

Measured (the 1.x recipe-tapper-2d, 5 scripts, packed CLI installed outside the repo, fresh `HOME`):
first `check` 2.1 s including the TypeScript install, then 1.45 s (validate ~0.2 s, tsc ~1.2 s).

### SVG sprites

Every texture in Pix3 (editor viewport, play mode, the single-file export) loads as bytes → `Blob`
→ object URL → three's `TextureLoader` → `<img>`, so an `.svg` renders exactly when a browser
`<img>` decodes it, at the size the `<img>` reports. Level 1 checks every `.svg` a scene
references (once per file per scene, at its first reference):

| Code | Severity | When |
| --- | --- | --- |
| `E_SVG_INVALID` | error | no `<svg>` root, or the root lacks `xmlns="http://www.w3.org/2000/svg"` (the browser refuses to decode it) |
| `E_SVG_NO_SIZE` | error | no absolute `width`/`height` and no `viewBox` (renders into a cropped 300x150 box), or one dimension without a `viewBox` |
| `W_SVG_VIEWBOX_ONLY` | warning | a `viewBox` but no absolute `width`/`height` (`%` and `style=` sizes count as none): Chrome gives it 300x150, art letterboxed |
| `W_SVG_EXTERNAL_REF` | warning | an `href`, CSS `url()` or `@import` to anything but `#fragment` / `data:` — never loads in SVG-as-image mode |

Measured in Chromium 129 through the runtime's own `ResourceManager` + `AssetLoader` + `Sprite2D`:
a sized SVG auto-sizes the sprite to its `width`×`height`; a viewBox-only one to 300×150; one
without `xmlns`, or any SVG whose Blob type is not `image/svg+xml`, fails to load (browsers do
not sniff SVG).

### `.pix3anim` frames and locale tables

Level 1 also follows what a scene reaches through another file. Every `.pix3anim` (all of them on
a whole-project run, else those the validated scenes name) must be a JSON object, and every image
it names — each frame's `texturePath`, the spritesheet's top-level one — must exist; an `.svg`
frame gets the sprite rules above (`E_SVG_*`), reported on the `.pix3anim` with the frame's path.
The locales are the ones the plugin ships: the `localization:` block of `pix3project.yaml`, else
every `locales/*.json` (`en` the default when there is one). Severity is what the player would
see: the default or fallback locale's table not loading means every `labelKey` shows its key
(error); another locale's means its texts fall back (warning).

| Code | Severity | When |
| --- | --- | --- |
| `E_ANIM_JSON` | error | a `.pix3anim` is not JSON, not an object, or its `clips` are not a list |
| `E_MISSING_FRAME` | error | a frame image or the spritesheet a `.pix3anim` names does not exist (case hint as for `E_MISSING_RESOURCE`) |
| `E_LOCALE_MISSING` / `W_LOCALE_MISSING` | error / warning | a declared locale has no `locales/<id>.json` (default or fallback / another); on `pix3project.yaml` at its line |
| `E_LOCALE_JSON` / `W_LOCALE_JSON` | error / warning | the table is not JSON, not an object, or `strings` / `sprites` is not a map |
| `E_LOCALE_VALUE` / `W_LOCALE_VALUE` | error / warning | a `strings` / `sprites` value is not a string (the runtime drops it; nested keys are the usual cause) |
| `E_LOCALE_KEY` | error | a `labelKey` (on a node or an instance) with no text in the default locale nor the fallback (`""` counts as none) — the node shows the key |

The tables are checked on whole-project runs (as `W_UNUSED_ASSET`); `labelKey`s on every run.
Not checked: keys a script passes to `tr()`, `textureKey` / `stateTextureKeys` against `sprites`,
and the files a table's `sprites` name.

## `pix3 sfx` — sound effects without the editor

```text
pix3 sfx coin                                   # -> audio/coin.wav in the project root
pix3 sfx "short high coin pickup" --out audio/pickup.wav --seed 7
pix3 sfx explosion --json                       # { path, res, durationMs, preset, seed, modifiers, bytes, peak, params }
```

Presets: `coin`, `jump`, `hit`, `explosion`, `powerup`, `click`. Free text picks the preset whose
keyword appears first (`boom`, `pickup`, `button`, `hurt`, …) and applies modifier words
(`high`/`low` pitch ×1.4/×0.7, `short`/`long` time ×0.65/×1.6, `soft`). `--seed <n>` renders a
deterministic variation (pitch ±15 %, times ±20 %, duty/vibrato/cutoff nudged); without it the
preset as tuned. Output is 44.1 kHz 16-bit mono PCM WAV — `AssetLoader.loadAudio` decodes it with
`decodeAudioData` like any `.ogg`/`.mp3`, and the export embeds it as `audio/wav`. `res` in the
JSON is the `res://` path when the file lands inside a project. Exit 2 on a bad argument or a
description that names no preset.

The synth (`src/sfx/synth.ts`, no dependencies) is one jsfxr-style voice: square / saw / sine /
triangle / noise, exponential pitch slide, pitch jump, vibrato, ADSR, resonant low-pass, DC
blocker, peak normalisation. It does not use the editor's `@txt2sfx/*` packages: their only
renderer drives an `OfflineAudioContext` the caller supplies, i.e. a native Web Audio module
(`node-web-audio-api`) in Node. Each preset renders in well under 10 ms; the whole command runs in
~0.12 s; files are 2–67 KiB (click 24 ms … explosion 772 ms).

## `pix3 character-compile` — a 2D character from frame PNGs

```text
pix3 character-compile art/goblin.yaml            # writes into the project around the cwd
pix3 character-compile art/goblin.yaml --dry-run  # the plan, nothing written
pix3 character-compile art/goblin.yaml --json     # { ok, name, slug, animationPath, prefabPath, clips, files, warnings }
```

The 1.x Store compiler (`character2d`, `pix3: src/services/library/character-compiler.ts`) as a
command. A spec (YAML or JSON; frame paths relative to the spec file) groups PNG frames into
`variant × state` clips:

```yaml
name: Goblin                     # display name, prefab file name
slug: goblin                     # sprite folder (default: from name)
anchor: { x: 0.5, y: 0.9 }       # frame anchor, y from the top: the feet land on the node position
defaultVariant: sword            # the pair the prefab starts on (default: the first clip's)
defaultState: idle
clips:
  - { variant: sword, state: idle, fps: 10, frames: [sword/idle_1.png, sword/idle_2.png] }
  - { variant: sword, state: attack, fps: 15, sequence: sword/attack }  # sword/attack_<n>.png, numeric order
  - { state: die, sequence: die/die }                                   # no variant: clip "die"
```

Output, in the managed-sprite-folder layout the editor's Sprite Editor shows as one card:
`sprites/<slug>/<slug>.pix3anim` (clips `<variant>.<state>`, every frame with `texturePath`,
`anchor`, `sourceSize`), the frames copied beside it as `<variant>_<state>_<nnnn>.png`, and
`scenes/prefabs/<Name>.pix3scene` — an `AnimatedSprite2D` root (`sizeMode: native`) carrying
`core:CharacterVisual2D` (`variant`, `state`, `separator`); game code calls
`playState('attack', { restart: true })` / `setVariant('bow')`. `spriteDirectory` /
`prefabDirectory` / `separator` override the defaults. Defaults are proposals and print as
warnings (fps 12; `loop: false` for `attack`, `die`, `death`, `hit`, `hurt`); a sequence with gaps
warns, one with a duplicate number fails. Writes are all or nothing: a target that exists with
other bytes is refused (exit 1, nothing written) unless `--force`; identical bytes are `current`.
Frames must be PNG (the size comes from the header; the Node-runnable CLI does not load the
engine's image reader). Exit 0 = written or current, 1 = refused, 2 = usage / no project.

`src/character/character.spec.ts` holds the output to the runtime (`normalizeAnimationResource` of
the written `.pix3anim` is the identity; the compiler's types are assignable to
`AnimationResource`), to the editor's frame naming (`buildAnimationFrameResourcePath`), and to
`pix3 validate` on a starter that instances the prefab; `character.headless.spec.ts` boots the
prefab through the real loader and drives idle → attack → restart → die → variant switch. The
format itself: the kit's `.claude/skills/pix3-scene-format/pix3anim.md`.

## `pix3 smoke` — run the game headless

`pix3 smoke [scene]` runs the game in Node — no browser, no editor, no `pix3 serve` — for
`--frames N` fixed steps of 1/60 s (default 120) and reports everything that went wrong. It is the
behavioural check after `pix3 check` when no editor is connected; with the live channel,
`game_run` is the stronger one (it renders).

What runs: the project's scripts compiled with esbuild (as `validate` level 2 does, but bare
imports are bundled for real from the project's `node_modules` — Rapier, three addons — and only
what resolves nowhere becomes an empty module, reported as `W_SMOKE_STUBBED_IMPORT`), the scene
loaded from disk by the real `SceneLoader`, a real `SceneRunner` in manual time. Frame 0 is loading
and starting the scene (`onAttach`/`onStart`, then 128 event-loop turns so spawn chains land);
frame N is the N-th step. The run happens in a worker thread, so a script stuck in a loop is
stopped by `--timeout` (default 20 s).

Stubbed: rendering (a null renderer; post-processing never loads), audio (no Web Audio in Node),
input (no events), network (`scene.network` is null). Textures resolve empty, glTF models and
Spine skeletons referenced by nodes are not built; images a script loads through three's
`TextureLoader` "load" as blank 1×1 pictures (so preloaders finish). A small browser shim provides
`window` / `document` / canvas / `localStorage` / `matchMedia` / `requestAnimationFrame`; any other
browser property a script reads is recorded, and an error right after such a read is
`E_SMOKE_DOM` with the read attached (`domAccess`).

Scene: the argument (`res://`, project-relative or a path) runs that one scene. With no argument
several run, one after another from one bundle, a line each (`src/smoke/select-scenes.ts`):

1. In a git work tree with uncommitted changes (staged, unstaged or untracked): the **top-level**
   scenes those changes reach — the scene itself, a prefab / `scenes/ui/` overlay it instances, a
   script exporting a class it attaches as `user:X`, a `res://` file it names. `--changed` forces
   this (exit 2 without git or without changes). Changes under `node_modules/`, `.yalc/` (a linked
   package copy), `.git/`, `.pix3/`, `dist/`, `.vite/`, `.cache/` are not project changes and are
   ignored, and a `*.spec.ts` / `*.test.ts` next to the scripts is not game code — a consumer
   project's `.yalc/@pix3/runtime/**` and its unit tests used to read as hundreds of changed
   scripts that reach no scene and widen every run to everything.
2. Otherwise — no git, nothing changed, a changed scene/script that reaches no top-level scene (a
   helper module, an unused prefab), or a changed `pix3project.yaml` — **every** top-level scene
   (not instanced by another, not under `prefabs/` / `ui/`), `scenes/main.pix3scene` first (the
   editor's startup scene, where the game lives), then `defaultExportScenePath`, then by path.
   `--all` forces this.

It never picks `defaultExportScenePath` alone any more: in every recipe that is the menu, input is
empty, PLAY is never pressed, and a game whose `onStart` throws used to smoke green.

| Code | |
| --- | --- |
| `E_SMOKE_SCRIPT` | A script hook threw (`onAttach`/`onStart`/`onUpdate`…); the engine disabled that component |
| `E_SMOKE_DOM` | …and it was a browser API the shim does not provide (`domAccess` names it) |
| `E_SMOKE_TICK` / `E_SMOKE_COMMAND` | The engine tick / a game command handler threw |
| `E_SMOKE_CONSOLE_ERROR` | `console.error` (not the engine re-reporting one of the above) |
| `E_SMOKE_UNHANDLED` | An unhandled promise rejection, or a timer callback that threw |
| `E_SMOKE_LOAD` | The scene failed to load (missing prefab, invalid scene) |
| `E_SMOKE_SCRIPT_COMPILE` / `E_SMOKE_SCRIPT_IMPORT` | Scripts do not compile / throw at module top level |
| `W_SMOKE_MISSING_RESOURCE` | A `res://` file does not exist (the node loads without it) |
| `W_SMOKE_PENDING_COMPONENT` | A component type is not registered — it never runs |
| `W_SMOKE_CONSOLE_WARN`, `W_SMOKE_LOADER`, `W_SMOKE_STUBBED_IMPORT`, `W_SMOKE_STOPPED` | `console.warn`, loader warnings, an import replaced by `{}`, the game stopped itself |

Exit 0 = no errors (warnings allowed), 1 = errors, 2 = could not run (with several scenes, the
worst run decides): `E_SMOKE_NO_PROJECT`,
`E_SMOKE_NO_SCENE`, `E_SMOKE_BUNDLE`, `E_SMOKE_UNSUPPORTED` (no esbuild), `E_SMOKE_TIMEOUT`,
`E_SMOKE_CRASH`, `E_EDITOR_UNSYNCED` (a live editor named by `.pix3/dev.json` did not flush its
unsaved scenes first; `--no-sync` reads the disk as it is), `E_RUNTIME_VERSION` (the version gate:
the project installs another `@pix3/runtime` than the one bundled into this CLI, so a run would
test an engine the game does not ship). The human report prints the `game` snapshot whole — on one line when it is short, pretty-printed
and indented otherwise, cut only past 4 000 characters (`--json` always carries it whole).
`--json` prints `{ ok, scene, frames, framesRequested, firstFrameOk, errors:
[{ code, frame, script?, nodeId?, nodeName?, phase?, message, stack?, domAccess? }], warnings,
nodes: { start, end }, timingsMs: { compile, load, firstFrame, step: { total, mean, p95, max },
total }, scripts, domMissing, notes, game, logs }` — `game` is the `registerGameDebug` provider's
`snapshot()` at the end (when the game registers one), `logs` the first `console.log` lines,
frame-stamped. Stacks are source-mapped to the project's files. With no scene argument `--json`
prints `{ ok, selection: "changed" | "all", reason, changed?, runs: [<that report, per scene>] }`.

A green smoke run means nothing threw for N frames without input. It does not mean the game
plays: nothing was tapped, nothing was drawn.

## `pix3 tree` — find your way around a scene

`pix3 tree <scene>` prints one line per node, indented by depth, from the YAML alone (no loader,
no project code — instant):

```text
scenes/main.pix3scene — 12 nodes
Group2D#game-root "Game Root" size=1080x1920 layout=stretch/stretch  components=[user:GameRules, user:TouchRules]
  CanvasLayer2D#hud "HUD" size=1080x1920 layout=stretch/stretch  components=[user:ScoreHud]
    Label2D#score-label "Score Label" text="SCORE 0" pos=(-340,850) layout=left/top
    Group2D#result-overlay "Result Overlay" ↳ instance res://scenes/ui/result.pix3scene (1 property) hidden
```

`--depth N` stops N levels below the roots (cut subtrees end in `… +K below`); `--types A,B` keeps
nodes of those types (or carrying those components; `instance` = prefab instances) with their
ancestors as `·` context lines; `--props` adds, under each node, the properties that differ from
the node type's defaults (read from a bare instance of the runtime class, through the disk-format
table — the one step that loads the runtime bundle); `--json` gives the same as nested
`{ id, type, name, depth, position?, size?, layout?, hidden?, text?, groups?, components,
instance?: { path, rootType?, rootName?, overrides, properties }, props?, children }`. On an instance
`overrides` counts every `overrides.byLocalId.*.properties` key (edits to nodes inside the prefab)
and `properties` the instance node's own `properties` keys (applied to the prefab root); the line
prints `(2 overrides, 1 property)`, or `(no overrides)` when both are 0.

`pix3 tree` with no scene is the project overview: manifest facts, the `user:` scripts, and every
scene/prefab/overlay with its node count, node types, components and instances (entry scene
marked `*`). Exit 0, 1 when a scene does not parse, 2 for bad arguments or a missing file.

## `pix3 kit` — the agent kit

`pix3 kit` installs the agent kit into an existing project (one the editor created, or after a CLI
upgrade); `pix3 new` runs the same step. What lands in the project:

| Path | What |
| --- | --- |
| `AGENTS.md` | Root rules (read by Codex, Cursor, …). If the project already has its own, it is kept and the kit goes to `AGENTS.pix3.md` (the command prints the line to add). |
| `CLAUDE.md` | `@AGENTS.md` (plus `@AGENTS.pix3.md` in that case). A `CLAUDE.md` of the project's own is never touched — the command prints the line to add. |
| `.claude/skills/pix3-{scene-format,nodes,scripts,verify,editor}/SKILL.md` + `reference.md` | Skills loaded on demand; the `reference.md` files are generated from `docs/` and the runtime's registry; `pix3-scene-format/pix3anim.md` is the `.pix3anim` format |
| `design/tests/bots/pix3-test-bot.d.ts` | Global types for bot policies (`Pix3TestBot`, `BotPolicy`, …): a policy is `export default { name, tick(bot) { … } } satisfies BotPolicy`, and the starter's `tsconfig.json` includes `design/tests`, so `pix3 check` type-checks it. The editor writes no project files; this is where the 1.x editor-written declaration went |
| `.gitignore` | `.pix3/` appended when not covered; existing content kept |
| `tsconfig.json`, `.pix3/tsconfig.check.json`, `.pix3/types/` | Only without a `tsconfig.json` of the project's own (see below) |
| `pix3project.yaml` | `metadata.agentKit: { version, files }` (everything else as written) |
| `.pix3/kit-manifest.json` | sha256 of every file the kit wrote |

Without `--update`, existing files are never replaced (missing ones are written; an unchanged file
from an older kit is reported `outdated`). `--update` replaces every kit file whose bytes still
match the hash in `.pix3/kit-manifest.json` and **skips** (and reports) every file edited since.
`.pix3/` is gitignored, so on a fresh clone the manifest is gone and every differing kit file counts
as edited.

**Generated, not copied.** `scripts/build-kit.mjs` (run at `prepack`; a repo checkout regenerates
`kit/` automatically whenever an input changed) expands the templates in `kit-src/`: hand-written
prose plus `{{include:<repo path>#<heading>}}` / `{{include:<repo path>@<paragraph>}}` directives
over `docs/pix3-specification.md`, `docs/node-types-reference.md`, `docs/nodes-and-systems.md`,
`packages/cli/kit-includes/engine-api-map.md` and this README, and `{{generated:…}}` blocks
computed from code (the `core:` component table from the runtime's registry). Syntax:
`src/kit/generate.ts`. `src/kit.spec.ts` builds the kit and fails on drift: an unresolved
directive, a `pix3` command or flag not in the usage text, an `npm run` script the starter does
not have, a `pix3_*` tool, parameter or sync reason the bridge (`bridge-tools.ts`) does not have, a
retired 1.x in-editor tool, a verdict phrase `GameTestService` does not produce, a diagnostic code
no command emits, a node type the loader does not know, a property in the nodes skill's tables
that the disk-format descriptor (`packages/runtime/src/core/scene-disk-format.ts`) does not
accept, a `core:` component that does not exist, and a `.pix3anim` reference (`pix3anim.md`)
whose interfaces, fields, optionality, types or "Omitted →" defaults differ from
`packages/runtime/src/core/AnimationResource.ts` and `normalizeAnimationResource`, and bot-policy
types missing a member of `Pix3TestBot` / `BotPolicy` / `BotNodeView`
(`packages/editor-core/src/services/game-test/game-bots.ts`).

### `pix3 kit --migrate` — a 1.x project's kit to 2.x

Plan §A.4 step 2. It migrates **the kit only** (`src/kit/migrate.ts`), and reports every change:

| What | How |
| --- | --- |
| `.mcp.json` | the 1.x `pix3 mcp --workspace` server (`npx -y @pix3/cli@1.x mcp …`, or the dev `node …/packages/cli/src/index.ts mcp`) is removed; other servers stay; a file left empty is deleted |
| Retired kit files | files in `.pix3/kit-manifest.json` that the 2.x kit no longer ships: deleted when unchanged, kept and reported when edited |
| `pix3project.yaml` | `metadata.pix3Hybrid` (the 1.x cloud link) removed, its value printed; `metadata.agentKit` rewritten |
| The kit | installed with `--update` semantics: unchanged 1.x kit files replaced, edited ones kept; an edited one that still mentions `pix3 mcp` / `pix3 serve` / `pix3 read` / the live channel / the in-editor tools is flagged `STILL 1.x` and the 2.x text written to `.pix3/kit-migrate/<path>` for a manual merge |

Never touched: anything outside the project (`~/.codex/config.toml` — the report says to delete a
1.x `[mcp_servers.pix3]` table), a project `.codex/config.toml` (reported when it runs `pix3 mcp`),
the project's own `AGENTS.md` / `CLAUDE.md` (an edited copy of the 1.x kit's `AGENTS.md` is
reported), scenes, scripts, assets, `package.json`, `vite.config.*`. The 2.x agent config is
`pix3 agent-setup`'s (the report says to run it). Moving a 1.x project onto Vite (`pix3()` in
`vite.config`, plan §A.4 step 3) is optional and by hand; the report notes a project without
`@pix3/vite-plugin`. A second run finds nothing to migrate. Spec: `src/kit/migrate.spec.ts`
(a 1.x-shaped starter, edits kept, idempotence, a copy of `../DeepCore` when present).

### Script types (`.pix3/types/`)

`scripts/build-runtime-types.mjs` (at `prepack`; rebuilt on demand in a checkout when the runtime
sources change) runs `tsc -p packages/runtime/tsconfig.types.json` (declarations of what
`src/index.ts` reaches — no specs, samples or `testing/`) into `runtime-types/@pix3/runtime/`, and
copies `@types/three` (without its `node_modules`) to `runtime-types/@types/three/` — the runtime's
public types extend three.js. The tarball carries that tree packed into one file,
`dist/runtime-types.json` (see "Package layout" below); the installed CLI expands it on first use. `lit` (re-exported `property`/`state` decorators), `postprocessing`
and the Spine runtime are not shipped: they are only reached from inside declaration files, which
`skipLibCheck` leaves alone (they type as `any`). In a project without its own `tsconfig.json`:

```text
.pix3/types/@pix3/runtime/**      the runtime's .d.ts (+ package.json with the version)
.pix3/types/@types/three/**       three.js types
.pix3/types/version.json          which CLI build wrote them
.pix3/tsconfig.check.json         paths → ./types/…, strict, noEmit, skipLibCheck, lib ES2022 + DOM,
                                  include ../scripts/**/*.ts and ../src/scripts/**/*.ts
tsconfig.json                     { "extends": "./.pix3/tsconfig.check.json" } — so an IDE sees them
```

## `pix3 gap` — what the agent had to work around

Plan §G.3 «Чего не хватает?», §G.4. `pix3 gap "<what was missing>" --kind
capability|tool|node|doc|other [--detail <text>] [--context <file or task>] [--agent <name>]`
appends one line to the project's `.pix3/gaps.jsonl`:

```json
{"ts":"2026-10-10T12:00:00.000Z","agent":"claude-code","kind":"node","summary":"no 9-slice panel node","detail":"built from 9 Sprite2D","context":"scenes/ui/shop.pix3scene"}
```

`agent` comes from `--agent`, else the environment (`CLAUDECODE=1` → `claude-code`, a `CODEX_*`
variable → `codex`), else it is left out; the summary is one line of ≤200 characters. One
`O_APPEND` write per record, so two agents never interleave. `pix3 gap --list [--json]` prints
them. The kit's `AGENTS.md` tells the agent to record a gap only after it worked around
something Pix3 lacks — not its own mistakes or the game's features. A CLI command rather than a
bridge tool: it needs no editor, and on a Remote SSH host it runs where the project is. `.pix3/`
is gitignored in the starters: the file stays with the checkout.

## `pix3 editor` — the editor in Chrome, for the agent

Plan §D.3 / §D.4 / §D.5. Idempotent; run it from the project (or `--project <dir>`):

1. **Dev server.** `.pix3/dev.json` (written by `@pix3/vite-plugin` while Vite listens: `url`,
   `editorUrl`, `port`, `pid`) is probed with `GET <url>__pix3/api/hello`. A live server is
   reused; a stale record is ignored and `node_modules/vite/bin/vite.js` is started **detached**
   (`process.execPath`, `cwd` = the project, output in `.pix3/dev.log`), and the command waits
   up to 15 s for the new `dev.json`. `--port <n>` passes `--port --strictPort` to Vite.
   `--stop` sends SIGTERM to the recorded pid (and drops a record whose process is gone).
2. **Chrome, owned.** `PIX3_CHROME` names the binary (a wrapper script works if it `exec`s
   Chrome: the pipe is fds 3 and 4), else the platform's usual place (`google-chrome` /
   `chromium` on the PATH, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
   `%ProgramFiles%\Google\Chrome\Application\chrome.exe`). `pix3 editor` starts a **detached
   Chrome owner** (`pix3 __chrome-owner`, log in `~/.pix3/chrome-owner.log`) and returns once its
   proxy answers; the owner launches Chrome with `--app=<editorUrl>
   --user-data-dir=~/.pix3/chrome --remote-debugging-pipe` — **no debugging port** — no first run,
   no default-browser check, background throttling off (`--disable-background-timer-throttling
   --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`). The owner lives
   exactly as long as Chrome: Chrome gone → the owner closes every client, removes
   `~/.pix3/chrome.json` and exits; the owner gone (killed) → the pipe closes and Chrome exits
   with it. `--stop-chrome` asks the owner to close Chrome. A second project opens another app
   window in the running Chrome (a short launch of the same profile, no debugging flag; with
   `--headless`, a new tab through the proxy). `--headless` opens the URL as a plain tab with
   `--headless=new` (headless Chrome ignores `--app`). `--no-chrome` stops after the server;
   under `SSH_CONNECTION` Chrome is not launched — see [Remote SSH](#remote-ssh--vs-code-on-a-remote-host-chrome-on-your-machine).
3. **The token proxy (9333).** The owner serves `ws://127.0.0.1:9333/pix3` (the browser target;
   `…/pix3/page/<targetId>` for one page) and `GET /json/version`, `/json/list` (`/json`) on
   loopback. Every request needs `Authorization: Bearer <token>`, the token of
   `~/.pix3/cdp-token` (32 random bytes, base64url, mode 0600, created once by whichever command
   needs it first; delete the file to rotate, then `agent-setup --repair` and a new Chrome);
   a request with an `Origin` (any web page) or a non-loopback `Host` is refused (403), a
   missing or wrong token is 401 — a WebSocket is refused before the upgrade. Several clients
   share the pipe (chrome-devtools-mcp, a harness, `pix3 editor` itself): each gets its own root
   session (`Target.attachToBrowserTarget`, or `attachToTarget {flatten}` for a page), message
   ids are remapped per client, events go only to the client owning their session, another
   client's session is "not found", a client that leaves is detached with its child sessions.
4. **The port.** The check sends `X-Pix3-Challenge` and **no token**: a proxy answering with the
   proof that it knows our token (`X-Pix3-Proof`, the HMAC of [Remote SSH](#remote-ssh--vs-code-on-a-remote-host-chrome-on-your-machine))
   = ours → reused (only then is it asked, with the token, for its tabs; when the editor tab is
   open there, nothing is launched). A proxy without that proof (another user's, another
   `PIX3_HOME`, a squatter), a foreign DevTools endpoint or any other listener — none of which
   ever sees the token — → the next of 9334–9339, with a line per skipped port, the chosen one
   recorded in `~/.pix3/chrome.json`, and the reminder to run `pix3 agent-setup --repair` (a
   running Codex / Claude Code session keeps the old endpoint: new thread). A plain DevTools port
   with a `/__pix3/` page (or on the recorded port) is the P1 launch (open port, no token): it
   holds the profile, so `pix3 editor` stops and says to close that Chrome. When the port is the
   usual one but the project's `.mcp.json` / `.codex/config.toml` entry is not the current launch
   (an older one — `--wsHeaders` with the token on its command line, `--browserUrl`), or the
   `~/.pix3/cdp-mcp.json` it names holds another port or token, it says to run
   `pix3 agent-setup --repair`. `--cdp-port <n>` moves the preferred port
   (test harnesses). `PIX3_HOME` relocates `~/.pix3`.

Keepalive is the editor's: every bridge call keeps its loops running for 60 s, agent play until
it stops (`AgentKeepaliveService`); the Chrome flags above keep Chrome from throttling the tab.

## `pix3 agent-setup` — chrome-devtools-mcp for Codex and Claude Code

Plan §D.6. Writes project-level config, idempotently:

- Claude Code — `.mcp.json`, `mcpServers["pix3-browser"]`, other servers kept;
- Codex — `.codex/config.toml`, the `[mcp_servers.pix3-browser]` table (`startup_timeout_sec =
  20`, `tool_timeout_sec = 300`: `pix3_game_run` outlives the 60 s default), replaced as a whole,
  every other byte of the file kept.

The entry is `npx -y chrome-devtools-mcp@1.10.1 --categoryExperimentalThirdParty=true
--experimentalVision=true --config=<~/.pix3/cdp-mcp.json>` (`cmd /c npx …` on Windows;
`experimentalVision` enables `click_at {x, y}`, the agent's input at the coordinates
`pix3_scene` returns as `screen`). `~/.pix3/cdp-mcp.json` (mode 0600, written by this command,
rewritten whenever the port or the token moves) holds `wsEndpoint` = `ws://127.0.0.1:<port>/pix3`
and `wsHeaders` = `{"Authorization":"Bearer <token>"}`: 1.10.1's `--config` reads a JSON object
with the flags' own options and coercions (`build/src/config/mcp-options.js`; `wsEndpoint` /
`wsHeaders` in `build/src/config/browser-options.js`, `wsHeaders` parsed as a JSON object); with
`wsEndpoint` puppeteer connects to that WebSocket only, sending the headers on the upgrade, and
makes no `/json/*` request. So **the token is in no project file and on no command line** (every
user of a box can read every process's command line). The version is **pinned**:
the third-party tool category is experimental and may move in a minor release, so it changes
only after the S4 transport run is repeated (`CHROME_DEVTOOLS_MCP_VERSION` in
`src/agent-setup/config.ts`); the inline fallback (`window.__PIX3_DEBUG__.call`) works on any
version. The port is `--cdp-port`, else what `~/.pix3/chrome.json` recorded, else 9333; the token
is `~/.pix3/cdp-token` (created here if `pix3 editor` has not run yet). `--remote` is the same
shape for an agent on a Remote SSH host, with `~/.pix3/remote-cdp.json` (see Remote SSH below).

The project files name a path in this machine's home, so the starters' `.gitignore` keeps
listing `.mcp.json` and `.codex/config.toml`. An entry that already matches is `up to date`; one
that differs (another version or config file, the P1 `--browserUrl` launch or the earlier
`--wsEndpoint` + `--wsHeaders` launch that carried the token, each named as such) is reported as
drift and exit 1 — `--repair` rewrites it after copying the file to `<file>.bak` (the `.bak` of a
`--wsHeaders` entry still holds the token: delete it); that is the migration of a P1 or an early
P2 project.
Nothing is done to a sandbox: Codex must be allowed to reach `127.0.0.1` once when it asks.
The alternative for every project at once is printed (`claude mcp add --scope user …`, or the
table in `~/.codex/config.toml`).

**The proxy (plan §D.5).** Chrome opens no debugging port; the only way in is the proxy with the
token, so another local user, a web page or a process that cannot read `~/.pix3/cdp-token`
cannot drive the editor's Chrome (checked: `../pix3-core-spikes/editor-e2e/gate-p2.mjs`). Same-user
processes can read the token file — the boundary is the user account, as for any file in the
home directory. Chrome on macOS / Windows is untested (`.plans/agent-bridge.md` debt).

## Remote SSH — VS Code on a remote host, Chrome on your machine

Plan §E.3. You work in VS Code connected to a Linux box over **Remote SSH**: the project, Vite and
the coding agent (Claude Code, Codex) run there; the browser runs on your machine. The editor
reaches your browser through VS Code's port forward; the agent reaches that browser through an SSH
`RemoteForward` of the CDP token proxy, back onto the remote host's loopback.

1. **On the remote host** (VS Code's terminal, in the project): `npm run editor`. Under
   `SSH_CONNECTION` it starts (or reuses) the dev server, launches no Chrome, and prints what to
   do on your machine — with the ports it found free there:

   ```text
   On your machine, once — ~/.ssh/config, under the Host you connect to, then reconnect:
       RemoteForward 127.0.0.1:9333 127.0.0.1:9333
       ExitOnForwardFailure yes
   On your machine, each session — VS Code forwards port 5173 (its Ports tab shows the local address):
       npx @pix3/cli@<version> editor --chrome-only --url http://localhost:5173/__pix3/
   ```

   VS Code forwards the dev server's port by itself (it sees the URL in the terminal; the Ports
   tab lists it). When the local port is not the same (5173 was taken on your machine), use the
   local address in `--url`.
2. **On your machine, once:** add the two lines to `~/.ssh/config` under that `Host`, close the
   remote window and connect again. The first port is the one on the remote host (`pix3 editor`
   skips one another user of that host already holds); the second is your proxy (9333 unless
   `pix3 editor` said it had to use another). `ExitOnForwardFailure yes` is not optional: without
   it a connection whose forward failed — because someone else on the remote host took the port —
   comes up anyway, and the agent would hand its token to whoever holds the port.
3. **On your machine, each session:** the `npx @pix3/cli … editor --chrome-only --url …` line.
   No project needed there: it checks that the URL answers as a Pix3 editor, starts Chrome behind
   the token proxy (as `pix3 editor` always does) and opens the editor. It then prints one line
   that copies its token to the remote host (`--ssh <host>` fills the host in):

   ```text
   ssh <host> 'umask 077 && mkdir -p ~/.pix3 && cat > ~/.pix3/remote-cdp-token' < ~/.pix3/cdp-token
   ```

   Run it once (again only after the token changes). The token goes from your token file through
   the SSH channel into a 0600 file on the remote host: it is never printed, typed, pasted or put
   on a command line.
4. **On the remote host, once:** `npx pix3 agent-setup --remote`, then a new agent thread. It
   finds the forward among 9333–9339 by asking each port for **proof** that it knows the token
   (`X-Pix3-Challenge` → `X-Pix3-Proof`, an HMAC the proxy computes; the token itself is never
   sent to a port that has not proven it), writes `~/.pix3/remote-cdp.json` (0600: the endpoint
   `ws://127.0.0.1:<port>/pix3` and the token, read by chrome-devtools-mcp's `--config`), and the
   project's `.mcp.json` / `.codex/config.toml` entry `npx -y chrome-devtools-mcp@1.10.1 …
   --config=<that file>`, which holds no secret. `--cdp-port <n>` names the port instead.
   `npm run editor` on the remote host says whether the forward is live (`CDP forward: live on
   127.0.0.1:9333`).

The agent finds its tab by `.pix3/dev.json`: `publicEditorUrl` is the address your browser
reached the dev server at — learnt from the editor tab's `Origin` when it differs from the
server's own (a port forward that is not 1:1), or set with `PIX3_PUBLIC_URL=http://localhost:5174`
in the environment of the dev server; absent, `editorUrl` is the address.

Why it is safe on a shared host: the remote host's loopback is reachable by every user of it, and
so is the forwarded port — that is what the token is for (no token → 401). On the remote host the
token lives only in two 0600 files of your home; not in the project, not in any process's command
line (readable by every user of a host), not in any output. What the token does not protect: a
process of your own account on the remote host can read it (the same boundary as on your
machine), and the dev server itself (`/__pix3/api/*` reads and writes the project) answers any
local user of the remote host, as every Vite dev server does. To rotate: delete
`~/.pix3/cdp-token` on your machine, `pix3 editor --stop-chrome`, run the `--chrome-only` line and
the copy line again, then `npx pix3 agent-setup --remote` and a new thread. Untested: a Windows
or macOS machine on the human side (the `type … | ssh` line is cmd's and PowerShell's).

## The editor bridge — what the tab exposes

`packages/editor-core/src/host/bridge-tools.ts` is the tool table (names, descriptions, JSON
Schemas), `debug-bridge.ts` the one implementation behind two transports: the page answers
chrome-devtools-mcp's `devtoolstooldiscovery` with the `pix3` group
(`list_3p_developer_tools` / `execute_3p_developer_tool {toolName, params: "<JSON>"}`), and
`window.__PIX3_DEBUG__.call(name, params)` is the same call from `evaluate_script`
(`waitForStableDom: false`). Tools: `pix3_status`, `pix3_sync` (`{expect?, timeoutMs?}` →
flush, rescan, barrier), `pix3_scene` (`{path?, maxDepth?, nodeId?, find?}`), `pix3_play`
(`{action: start|stop|restart|pause|status, scenePath?, force?}` — the designer's session is
refused with `not_owner`, `force` included), `pix3_game_run` (`GameTestService.run`),
`pix3_screenshot` (`{target: game|viewport}` prepares the view; the picture is
`take_screenshot`), `pix3_errors` (`{since?, clear?}`). Params are validated on both paths;
every refusal is `{ok:false, reason, detail}`. `pix3 check`, `pix3 smoke` and `vite build`
flush the editor through `POST /__pix3/api/flush` (the CLI side is `src/editor-sync.ts`),
without the bridge. The kit's `pix3-editor` skill is held to the table by `src/kit.spec.ts`.

## Package layout and publishing

The published package has **no runtime `dependencies`**, so a cold `npx -y @pix3/cli@X.Y.Z …`
fetches one tarball and installs nothing else (measured in
`.plans/measurements/external-agent-phase0-cold-start.md`). `prepack` builds:

```text
dist/index.js               the bin: src/index.ts + yaml, one minified ESM file
                            (scripts/build-bin.mjs); lazy commands stay lazy
dist/validate/prebuilt/     validate + @pix3/runtime + three (scripts/build-validate.mjs)
dist/smoke/prebuilt/        smoke worker + tree defaults + @pix3/runtime + three (scripts/build-smoke.mjs)
dist/runtime-types.json     runtime-types/ packed into one file (scripts/build-runtime-types.mjs):
                            ~1 100 small .d.ts cost npm over a second to unpack on every npx run
kit/                        the agent kit (scripts/build-kit.mjs)
templates/                  copy of packages/create-pix3/templates (scripts/copy-templates.mjs; removed at postpack)
```

Left out of the bin on purpose: Node built-ins; `esbuild` (an `optionalDependency` — level 2 of
`validate`, `smoke` and `check` resolve it from the bin with `import.meta.resolve`, and degrade
with a note when it is absent) and `typescript` (fetched on demand by `check`); and the
checkout-only modules (`validate/bundle.ts`,
`smoke/bundle.ts`, the kit generator), which become a throwing stub. Every file the CLI reads from
its own package is addressed from the package root (`src/package-root.ts`), never relative to the
current module — in the bundle every module's `import.meta.url` is the bin's. The sources (`node
src/index.ts`, the specs) never use a prebuilt bundle, even when an old `dist/` exists.
`src/bin-bundle.spec.ts` builds the bin into a temp package layout and checks `--version` against
`package.json` (and that against the lockstep root version), the pinned `chrome-devtools-mcp`
launch `agent-setup` writes, and that nothing but built-ins and the optional externals is
imported at run time.

Publishing is `.github/workflows/publish-packages.yml` (npm Trusted Publishing / OIDC, no token):
a `runtime-vX.Y.Z` tag publishes `@pix3/runtime` and `@pix3/cli` together, `cli-vX.Y.Z` the CLI
alone, or run the workflow manually. The job runs `npm ci` at the repo root (the build needs the
runtime sources, the root TypeScript and esbuild), checks the lockstep version against the root
and the tag, type-checks, runs the CLI specs and `npm publish`es. Try the tarball locally with
`npm pack -w packages/cli` at the repo root, then `npx -y --package ./pix3-cli-X.Y.Z.tgz pix3 …`.
