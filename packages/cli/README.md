# @pix3/cli

Command line for Pix3:

```text
pix3 new [<2d|3d> [dir]] [--name <n>]         create an empty 2D or 3D project (npm create pix3)
pix3 editor [--project <dir>] [--stop] [--chrome-only] [--no-chrome] [--port <n>] [--cdp-port <n>] [--headless]
                                              find/start the dev server, open the editor in Chrome for the agent
pix3 agent-setup [claude|codex] [--repair] [--cdp-port <n>] [--project <dir>]
                                              write the project's chrome-devtools-mcp config
pix3 validate [paths…] [--json]               strict scene check
pix3 check [--json] [--no-hydrate] [--offline] [--no-sync] [--project <dir>]
                                              validate + tsc over the scripts + versions
pix3 smoke [scene] [--changed|--all] [--frames N] [--timeout S] [--json] [--project <dir>]
                                              run the game headless in Node, report what threw
pix3 tree [scene] [--depth N] [--types A,B] [--props] [--json] [--project <dir>]
                                              scene outline, one line per node; no scene = overview
pix3 kit [--update] [--project <dir>]         install / update the agent kit in a project
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
`pix3 editor` puts that tab in a Chrome with remote debugging, `pix3 agent-setup` points the
agent's MCP config at it. There is no Pix3 MCP server (plan §D.2); the agent-facing procedure is
the kit's `pix3-editor` skill.

## `pix3 check` — everything an agent should run after a batch of edits

`pix3 check` = `pix3 validate` (both levels) + a TypeScript type-check of the project's scripts +
the newest `.pix3/merge-log.jsonl` entries + a version check. Exit 0 = no errors (warnings
allowed), 1 = at least one error, 2 = could not run. Files are the truth only once the editor has
written them: when `.pix3/dev.json` names a live dev server, `check` first asks it to flush the
editor's unsaved scenes (`POST /__pix3/api/flush`, up to 15 s; `--no-sync` skips it, a dead
server is ignored). Diagnostics are one list, validate's plus:

| Code | Severity | When |
| --- | --- | --- |
| `E_TYPE` | error | a tsc diagnostic (`message` starts with `TS<code>:`; `file`, `line`) |
| `E_TYPECHECK_UNAVAILABLE` | error | TypeScript could not be found or installed (`fix` = the command to run) |
| `E_EDITOR_UNSYNCED` | error | `.pix3/dev.json` points at a live dev server whose editor did not flush its unsaved scenes within 15 s (`--no-sync` reads the disk as it is) |
| `W_RUNTIME_VERSION_MISMATCH` | warning | own `tsconfig.json`, and `node_modules/@pix3/runtime` is not this CLI's version |
| `W_RUNTIME_NOT_INSTALLED` | warning | own `tsconfig.json`, and no `node_modules/@pix3/runtime` |
| `W_KIT_OUTDATED` | warning | `metadata.agentKit.version` is not this CLI's version (`pix3 kit --update`) |

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
  "mergeLog": [{ "at", "file", "event", "…": "the newest 10 lines of .pix3/merge-log.jsonl" }],
  "kit": { "version": "1.6.0", "cliVersion": "1.6.0", "upToDate": true },
  "timingsMs": { "validate": 190, "typecheck": 1180, "total": 1380 }
}
```

`files` holds every scene validated and every script type-checked, hashed over the **raw bytes** —
the hashes `expect` (barrier tools) and `pix3 ack --sha256` take. `typecheck.errors` counts the
`E_TYPE` / `E_TYPECHECK_UNAVAILABLE` entries of `diagnostics`.

**A compile error hides level 2.** When the scripts do not compile (`E_SCRIPT_COMPILE`), level 2
skips every scene with `user:` components — their `E_UNKNOWN_CONFIG_KEY` / `E_PROPERTY_TYPE` /
component checks are *missing*, not passed. The report says so: `level2.filesSkippedForScripts`,
a `SKIPPED: N scene(s) …` note, and the human summary line reads `level 2 hydrated 0 file(s), N
SKIPPED (scripts do not compile — user: components unchecked)`. Fix the compile error and run again.

**Merge-log notes.** An `ack-unknown` entry (a `pix3 read` / `pix3 ack` of bytes the editor never
recorded) prints as a `note:` only while its hash is the file's *current* version; one about a
version the disk no longer holds is history and is not printed (it stays in `mergeLog` of `--json`).

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
unsaved scenes first; `--no-sync` reads the disk as it is). The human report prints the `game` snapshot whole — on one line when it is short, pretty-printed
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
| `.claude/skills/pix3-{scene-format,nodes,scripts,verify,editor}/SKILL.md` + `reference.md` | Skills loaded on demand; the `reference.md` files are generated from `docs/` and the runtime's registry |
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
computed from code (the `core:` component table from the runtime's registry, the MCP tool list,
the barrier error codes). Syntax: `src/kit/generate.ts`. `src/kit.spec.ts` builds the kit and fails
on drift: an unresolved directive, a `pix3` command or flag not in the usage text, a tool name
outside the 14, a diagnostic code no command emits, a node type the loader does not know, a
property in the nodes skill's tables that the disk-format descriptor
(`packages/runtime/src/core/scene-disk-format.ts`) does not accept, a `core:` component that
does not exist.

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

## `pix3 editor` — the editor in Chrome, for the agent

Plan §D.3 / §D.4. Idempotent; run it from the project (or `--project <dir>`):

1. **Dev server.** `.pix3/dev.json` (written by `@pix3/vite-plugin` while Vite listens: `url`,
   `editorUrl`, `port`, `pid`) is probed with `GET <url>__pix3/api/hello`. A live server is
   reused; a stale record is ignored and `node_modules/vite/bin/vite.js` is started **detached**
   (`process.execPath`, `cwd` = the project, output in `.pix3/dev.log`), and the command waits
   up to 15 s for the new `dev.json`. `--port <n>` passes `--port --strictPort` to Vite.
   `--stop` sends SIGTERM to the recorded pid (and drops a record whose process is gone).
2. **Chrome.** `PIX3_CHROME` names the binary (a wrapper script works), else the platform's
   usual place (`google-chrome` / `chromium` on the PATH, `/Applications/Google Chrome.app` via
   `open -na`, `%ProgramFiles%\Google\Chrome\Application\chrome.exe`). Launched with
   `--app=<editorUrl> --user-data-dir=~/.pix3/chrome --remote-debugging-port=<port>`, no first
   run, no default-browser check, and background throttling off
   (`--disable-background-timer-throttling --disable-renderer-backgrounding
   --disable-backgrounding-occluded-windows`); a second launch with the same profile opens
   another app window in the running Chrome (a second project shares Chrome and port).
   `--headless` opens the URL as a plain tab with `--headless=new` (headless Chrome ignores
   `--app`). `--no-chrome` stops after the server; under `SSH_CONNECTION` Chrome is not launched
   (plan §E.3 — the browser is on the machine with the screen; `--chrome-only` there, after the
   port forward).
3. **The port (9333).** `GET /json/version` says whether something listens; `/json/list` with a
   `/__pix3/` page (or the port `~/.pix3/chrome.json` recorded) says it is ours → reused. A
   foreign DevTools endpoint or any other listener → the next of 9334–9339, with a line per
   skipped port, the chosen one recorded in `~/.pix3/chrome.json`, and the reminder to run
   `pix3 agent-setup --repair` (a running Codex / Claude Code session keeps the old
   `--browserUrl`: new thread). `--cdp-port <n>` moves the preferred port (test harnesses).
   `PIX3_HOME` relocates `~/.pix3`.

Keepalive is the editor's: every bridge call keeps its loops running for 60 s, agent play until
it stops (`AgentKeepaliveService`); the Chrome flags above keep Chrome from throttling the tab.

## `pix3 agent-setup` — chrome-devtools-mcp for Codex and Claude Code

Plan §D.6. Writes project-level config, idempotently:

- Claude Code — `.mcp.json`, `mcpServers["pix3-browser"]`, other servers kept;
- Codex — `.codex/config.toml`, the `[mcp_servers.pix3-browser]` table (`startup_timeout_sec =
  20`, `tool_timeout_sec = 300`: `pix3_game_run` outlives the 60 s default), replaced as a whole,
  every other byte of the file kept.

The entry is `npx -y chrome-devtools-mcp@1.10.1 --categoryExperimentalThirdParty=true
--experimentalVision=true --browserUrl=http://127.0.0.1:<port>` (`cmd /c npx …` on Windows;
`experimentalVision` enables `click_at {x, y}`, the agent's input at the coordinates
`pix3_scene` returns as `screen`). The version is **pinned**:
the third-party tool category is experimental and may move in a minor release, so it changes
only after the S4 transport run is repeated (`CHROME_DEVTOOLS_MCP_VERSION` in
`src/agent-setup/config.ts`); the inline fallback (`window.__PIX3_DEBUG__.call`) works on any
version. The port is `--cdp-port`, else what `~/.pix3/chrome.json` recorded, else 9333.

An entry that already matches is `up to date`; one that differs (another version, another port)
is reported as drift and exit 1 — `--repair` rewrites it after copying the file to `<file>.bak`.
Nothing is done to a sandbox: Codex must be allowed to reach `127.0.0.1` once when it asks.
The alternative for every project at once is printed (`claude mcp add --scope user …`, or the
table in `~/.codex/config.toml`).

**No proxy yet (plan §D.5).** Port 9333 listens on loopback only; a web page cannot connect
(Host check, no `--remote-allow-origins`), any local process of the same user can. The
token-bearing proxy (`pix3 editor` owning Chrome over `--remote-debugging-pipe`, MCP with
`--wsEndpoint` + `--wsHeaders`) is P2 and mandatory before a stranger test on a corporate laptop
and before Remote SSH; until then dogfood is local only.

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
