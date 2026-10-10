---
name: pix3-editor
description: How to drive the open Pix3 editor tab through Chrome DevTools MCP (the `pix3-browser` server) — find the tab, list the page's `pix3_*` tools, the sync → read → edit → sync loop, what a not-ok `pix3_sync` means (`expect_mismatch`, `stale` with a play owner, `gesture_in_progress`), play ownership, `pix3_game_run`, screenshots, the inline `evaluate_script` fallback when `list_3p_developer_tools` is missing, and sync before a build. Use whenever you run, test or inspect the game in the editor, after every batch of file edits, and before `npm run build`.
---

<!-- Pix3 agent kit {{version}} -->
# Drive the editor

The human has this project open in the Pix3 editor: a tab at `<dev server>/__pix3/` in a Chrome
that `pix3 editor` started with remote debugging on port 9333. You reach that tab through the
`pix3-browser` MCP server (chrome-devtools-mcp). The tab registers its own tools on the page;
you edit files, the editor follows the disk, and `pix3_sync` is the barrier between the two.

## 1. Find the tab (once per thread, and again after any reload)

1. `.pix3/dev.json` in the project → `editorUrl` (e.g. `http://localhost:5173/__pix3/`).
   No file, or the server does not answer → `npm run editor` (= `npx pix3 editor`: starts the
   dev server and Chrome). No `pix3-browser` server in
   your MCP list → `npx pix3 agent-setup` once, then start a new thread.
2. `list_pages` → the page whose URL starts with `editorUrl` → `select_page` with its id.
3. `list_3p_developer_tools` → the `pix3` group with the seven `pix3_*` tools below. **Call it
   again after every `select_page` and after any page reload** — the registration lives in the
   page, and `execute_3p_developer_tool` answers `Tool … not found` until it is listed again in
   the same MCP process.

Call a tool with `execute_3p_developer_tool {toolName: "pix3_sync", params: "{\"timeoutMs\": 15000}"}`
— `params` is a **JSON string** (escape the quotes). The answer is JSON text; every refusal is
`{ok:false, reason, detail}` and says what to do.

## 2. The tools

| Tool | Params | Does |
| --- | --- | --- |
| `pix3_status` | — | versions, `activeScene`, `scriptsStatus`, `writer` (`self` = this tab saves), `dirty` scenes, `pending` unsaved keys per scene, `gestureInProgress`, `pendingExternal`, `play` `{playing, playOwner, startedAt}`, `errorCount` |
| `pix3_sync` | `expect?` `{path: sha256}`, `timeoutMs?` | flush the editor's unsaved edits to disk, rescan, wait until the editor runs the files on disk; `{ok, rev, changed, expectMismatch}` |
| `pix3_scene` | `path?`, `maxDepth?`, `nodeId?`, `find?` | the scene tree as the editor holds it; with `nodeId` one node with `components`, `saved` (the node as the file gets it) and `screen` (origin on the page in CSS px — `click_at {x, y}` taps it); with `find` the nodes whose name/type contains it. Read-only |
| `pix3_play` | `action` `start\|stop\|restart\|pause\|status`, `scenePath?`, `force?` | play mode; `start` records you as the owner |
| `pix3_game_run` | `until`, `fail?`, `watch?`, `maxFrames?`, `maxWallMs?`, `settleMs?` | step the running game until a predicate holds or fails; read `verdict` first |
| `pix3_screenshot` | `target` `game\|viewport` | brings that surface to the front; the picture itself is chrome-devtools-mcp's `take_screenshot` (the tool never returns image data) |
| `pix3_errors` | `since?` (epoch ms), `clear?` | captured console / runtime errors, newest last |

Scenes and scripts are changed as **files** (`pix3-scene-format`, `pix3-scripts`). There is no
tool that sets a property, creates a node or writes a file, and no input tool: tap or drag the
running game with chrome-devtools-mcp's own `click_at {x, y}` / `press_key` at the `screen`
coordinates `pix3_scene {nodeId}` gives (the game runs in the editor's Game tab —
`pix3_screenshot {target:"game"}` brings it to the front first).

## 3. The loop after you decide to change something

1. **`pix3_sync` first, then read.** A successful sync means the disk holds what the designer
   sees: their unsaved drags and inspector edits are written. Read the scene or script you are
   about to change after that sync, never from memory.
2. **Edit the lines you mean to change.** Search/replace in the `.pix3scene`; never regenerate a
   whole scene from memory and never rewrite a file you did not just read — the designer may have
   moved things a minute ago. Note the sha256 of every file you wrote (`pix3 check --json` prints
   them under `files`; or compute it yourself).
3. **`pix3_sync` with `expect`** = `{ "<path>": "<sha256>", … }` of the files you wrote. `ok:true`
   = the editor runs exactly those bytes; its open scenes are reloaded, your script edits are
   executed (`changed` lists what the rescan found).
4. **Then verify**: `npm run check` (`pix3 check`), and in the editor `pix3_play {action:"restart"}`
   or `start` → `pix3_game_run` with predicates → `pix3_errors` → `pix3_screenshot` +
   `take_screenshot`.

## 4. A not-ok sync is not a barrier

Read `reason`; nothing happened on the editor side until a sync answers `ok:true`.

| `reason` | Meaning | Do |
| --- | --- | --- |
| `gesture_in_progress` | the designer is mid-drag; nothing is written during a gesture | call again (the flush waits up to `timeoutMs` for pointerup) |
| `stale_modules` | a changed script has not been re-executed by the tab yet (`paths`) | call again |
| `expect_mismatch` | `expectMismatch` lists files whose sha256 on disk is not the one you passed: the designer or another writer changed them after your write | re-read those files, redo your edit on top of what is there, sync with the new hashes |
| `stale`, `playing: "agent"` | play is running and external changes are deferred until it stops; **an agent** started it (any agent thread) | `pix3_play {action:"restart"}` (stop → apply the deferred changes → start), or `stop`, then sync again |
| `stale`, `playing: "designer"` | the designer pressed Play; their session is theirs | do **not** stop it — wait and poll, or ask the human; `stop` and `restart` answer `not_owner` even with `force:true` |
| `external_change`, `write_failed` | the flush itself could not write (`conflicts` / `failed`) | read the listed scenes, then sync again |

`expectMismatch` is also present on an `ok:true` answer when you passed `expect` for files that
match — an empty array. Never paste a `rev` or hash into a report.

## 5. Play ownership

`pix3_play start` records `playOwner: "agent"` in the page, not in your connection: a new thread,
a new MCP process, another agent — all may `stop` / `restart` it. A session started from the
editor's toolbar is `playOwner: "designer"`: `stop`, `restart` and `pause` refuse it with
`reason: "not_owner"`, `force` included. `pix3_play {action:"status"}` (or `pix3_status.play`)
tells you which it is before you act.

`pix3_game_run` needs a running session (`not_playing` otherwise). It steps the game far faster
than real time: a game whose `onStart` awaits something real (assets, a WASM module, a fetch)
needs `settleMs` (e.g. `2000`) first, and a readiness predicate before the one you care about.
Predicates (`until` / `fail` are lists, OR over each): `{kind:"nodeProperty", name, path, op, value}`
(a live node by name or id, dot path into its properties — `position.x`, `text`),
`{kind:"gameState", path, op, value}` and `{kind:"gameStateChanged", path, by?}` (the game's
`registerGameDebug` snapshot), `{kind:"nodeAppeared", name}`, `{kind:"nodeGone", name}`,
`{kind:"nodeMoved", name}`, `{kind:"newErrors", min?}`, `{kind:"frames", n}`,
`{kind:"command", name}`, `{kind:"signal", name}`; `op` is `eq`, `ne`, `gt`, `gte`, `lt`,
`lte` or `contains`.

**Judging a run** — a clean compile and a clean `pix3_errors` say nothing about whether the change
works; a run with a stated success condition does:

- **Read `verdict` first**: it is the one line that already decided the run.
- **Assert the change, not the value.** A predicate that is already true at frame 0 ends the run
  with `PRECONDITION ALREADY MET` and proves nothing: assert `gameStateChanged` on `score`, not
  `gameState score gte 0`; restart play to get a clean board.
- **Put a crash net in `fail`**: `{kind:"newErrors"}`. A `fail` beats an `until` on the same frame.
- **Count frames, not wall time** (`maxFrames`, `{kind:"frames", n}`): the same test then means the
  same thing on a slow machine.
- **Make game state readable.** `gameState` / `gameStateChanged` read the snapshot the game
  registers with `registerGameDebug({ name, snapshot })` (from `@pix3/runtime`); without one the
  verdict says there is no provider. Keep it to the fields that decide a run (score, lives, phase,
  wave) and add the field of every mechanic you add — state nothing reports is state nothing can
  verify, and then only screenshots are left. `pix3 smoke` prints the same snapshot.
- **Transient effects** (a hover scale, a flash, a punch, a fade) are back at rest by the time a
  separate `take_screenshot` runs — judge them by state: a `nodeProperty` predicate on `scale.x`
  or `opacity` inside the run, not a picture after it. Screenshots are for layout, colour and
  placement.
- **A black 3D screen** is usually a scene with no light or no camera, and the run's `notes` say
  so (`SCENE NOT RENDERABLE — …`); when they do not, suspect a camera that looks away from the
  content. The editor viewport lights the scene with fallback lights the running game does not
  have, so the viewport is no evidence either way.

## 6. Before a build

`npm run build` flushes the editor itself (and fails with `E_EDITOR_UNSYNCED` when the editor
cannot write in time), so a successful `pix3_sync` right before it is the honest sequence: sync →
`npm run build` → check `dist/`. `pix3 check` and `pix3 smoke` flush the editor the same way
(`--no-sync` reads the disk as it is).

## 7. Inline fallback (no `list_3p_developer_tools`, or it answers an empty list)

The flag `--categoryExperimentalThirdParty=true` may be missing from the MCP config, or the
category may have moved in a chrome-devtools-mcp release. The same tools are on
`window.__PIX3_DEBUG__`; call them through `evaluate_script` with **`waitForStableDom: false`**
(otherwise every call waits up to 3 s for a DOM that never settles) and the page's `pageId`:

```js
async () => await window.__PIX3_DEBUG__.call('pix3_sync', { timeoutMs: 15000 })
```

Short forms exist for the common calls: `status()`, `sync({expect, timeoutMs})`, `scene(depth)`,
`node(id)`, `find(text)`, `screen(id)`, `play.start()` / `play.stop()` / `play.restart()` /
`play.status()`, `errors()`. One tool per `evaluate_script` call: a refusal of one must not take
the others with it. The answers are the same objects the 3p path returns.

## 8. Keepalive

The tab is in the background while you work, and Chrome would throttle it. `pix3 editor` starts
Chrome with throttling off, and every bridge call keeps the editor's own loops running for 60 s
(a play session you started, until it stops). Nothing to do on your side; a tab that was opened
by hand in another Chrome may still pause when hidden.
