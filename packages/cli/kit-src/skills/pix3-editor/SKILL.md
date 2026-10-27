---
name: pix3-editor
description: How to drive the open Pix3 editor tab through Chrome DevTools MCP (the `pix3-browser` server) — find the tab, list the page's `pix3_*` tools, the sync → read → edit → sync loop, what a not-ok `pix3_sync` means (`expect_mismatch`, `stale` with a play owner, `gesture_in_progress`), play ownership, `pix3_game_run`, screenshots, the inline `evaluate_script` fallback when `list_3p_developer_tools` is missing, and sync before a build. Use whenever you run, test or inspect the game in the editor, after every batch of file edits, and before `npm run build`.
---

<!-- Pix3 agent kit {{version}} -->
# Drive the editor

The human has this project open in the Pix3 editor: a tab at `<dev server>/__pix3/` in a Chrome
that `pix3 editor` started. That Chrome has no open debugging port: its DevTools protocol is
served by `pix3 editor`'s token proxy (`ws://127.0.0.1:9333/pix3`), and you reach the tab through
the `pix3-browser` MCP server (chrome-devtools-mcp), which `pix3 agent-setup` configured with the
proxy and its token. The tab registers its own tools on the page; you edit files, the editor
follows the disk, and `pix3_sync` is the barrier between the two.

## 1. Find the tab (once per thread, and again after any reload)

1. `.pix3/dev.json` in the project → `publicEditorUrl` when it is there (the address the
   browser reached the server at, e.g. through a port forward), else `editorUrl` (e.g.
   `http://localhost:5173/__pix3/` — but the port is whatever Vite got: 5174, 5175… when 5173 was
   taken, so always read it from `dev.json` or from what `npm run dev` / `npm run editor` printed,
   never assume 5173).
   No file, or the server does not answer → `npm run editor` (= `npx pix3 editor`: starts the
   dev server and Chrome). No `pix3-browser` server in
   your MCP list → `npx pix3 agent-setup` once, then start a new thread. The server cannot
   connect (`401`, connection refused) or `npm run editor` tells you to run
   `pix3 agent-setup --repair` → `npm run editor`, then `npx pix3 agent-setup --repair`, then a
   new thread (a running MCP server keeps the endpoint and token it started with). Never read,
   print or copy the token (`~/.pix3/cdp-token`, `~/.pix3/remote-cdp-token`,
   `~/.pix3/cdp-mcp.json`, `~/.pix3/remote-cdp.json`). An MCP config that still carries
   `--wsHeaders` is an old launch: `npx pix3 agent-setup --repair`.
   **Over SSH** (`npm run editor` answers «SSH session: Chrome is not launched here»): Chrome
   runs on the human's machine. Give the human the lines it printed for their machine — they run
   them, including the one ssh line that copies the token here — then `npx pix3 agent-setup
   --remote` and a new thread. `npm run editor` says `CDP forward: live` once it works.
   **No human to run those lines** (an unattended agent on a remote box): `npx pix3 editor
   --headless` starts a headless Chrome on this host instead — a system Chrome, else Playwright's
   Chromium from `~/.cache/ms-playwright` (`npx playwright install chromium` if there is none),
   with `--no-sandbox` where the box has no user namespaces — then `npx pix3 agent-setup` (not
   `--remote`) and a new thread. Screenshots and `click_at` work the same; there is no window.
2. `list_pages` → the page whose URL starts with that address → `select_page` with its id.
   **No such page** (the human closed it, or Chrome was started without it) → `npm run editor`
   again: it checks the tab through the proxy and opens it when missing; or open it yourself with
   chrome-devtools-mcp's `new_page` on that URL. Then `list_pages` again. Open one tab only: a
   second editor tab on the same project competes for the writer.
3. `list_3p_developer_tools {pageId}` → the `pix3` group with the seven `pix3_*` tools below. **Call it
   again after every `select_page` and after any page reload** — the registration lives in the
   page, and `execute_3p_developer_tool` answers `Tool … not found` until it is listed again in
   the same MCP process.

Call a tool with `execute_3p_developer_tool {pageId: <id>, toolName: "pix3_sync", params: "{\"timeoutMs\": 15000}"}`
— `params` is a **JSON string** (escape the quotes). The answer is JSON text; every refusal is
`{ok:false, reason, detail}` and says what to do. **`pageId`** (the editor tab's id from
`list_pages`) is required by the pinned chrome-devtools-mcp on `list_3p_developer_tools`,
`execute_3p_developer_tool`, `take_screenshot` and `evaluate_script` alike — "Input validation
error: pageId: expected number" means it was left out.

## 2. The tools

| Tool | Params | Does |
| --- | --- | --- |
| `pix3_status` | — | versions, `activeScene`, `scriptsStatus`, `writer` (`self` = this tab saves), `dirty` scenes, `pending` unsaved keys per scene, `gestureInProgress`, `pendingExternal`, `play` `{playing, playOwner, startedAt}`, `errorCount` |
| `pix3_sync` | `expect?` `{path: sha256}`, `timeoutMs?` | flush the editor's unsaved edits to disk, rescan, wait until the editor runs the files on disk; `{ok, rev, changed, expectMismatch}` |
| `pix3_scene` | `path?`, `maxDepth?`, `nodeId?`, `find?` | the scene tree as the editor holds it (each node's `properties` = what the file gets, unsaved inspector edits included); with `nodeId` the answer is `{ok, node, saved, screen}` — `node` (with `components`), and **beside it, not inside it**, `saved` (the node as the file gets it) and `screen` (origin on the page in CSS px — `click_at {x, y}` taps it; during play it is the running node on the Game tab's canvas, and `live.components` gives that node's components' play-time state — `node.components` is the editor's, as authored); the inline short form `node(id)` returns the node with `saved` merged in; with `find` the nodes whose name/type contains it, `{ok, path, matches: [{nodeId, type, name}]}` (no properties: read one with `nodeId`). Read-only |
| `pix3_play` | `action` `start\|stop\|restart\|pause\|resume\|status`, `scenePath?`, `force?` | play mode; `start` records you as the owner; `pause` / `resume` set that state (no-op when already in it) |
| `pix3_game_run` | `until?`, `fail?`, `watch?`, `maxFrames?`, `maxWallMs?`, `settleMs?`, `bot?` | step the running game until a predicate holds or fails (an `until` is required, except that a policy ends its own run); read `verdict` first |
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
The same holds for a `changeScene` the game starts **during** a run: the async load is starved
while the run steps frames, so the new scene never shows up within `maxFrames`. Run until the
change is requested, then a second run with `settleMs` and a readiness predicate on the next
scene (`{kind:"nodeAppeared", name}` of one of its nodes) before you assert anything in it.
Predicates (`until` / `fail` are lists, OR over each): `{kind:"nodeProperty", name, path, op, value}`
(a live node by name or id, dot path into its properties — `position.x`, `text`),
`{kind:"gameState", path, op, value}` and `{kind:"gameStateChanged", path, by?}` (the game's
`registerGameDebug` snapshot), `{kind:"nodeAppeared", name}`, `{kind:"nodeGone", name}`,
`{kind:"nodeMoved", name}`, `{kind:"newErrors", min?}`, `{kind:"frames", n}`,
`{kind:"command", name}`, `{kind:"signal", name}`; `op` is `eq`, `ne`, `gt`, `gte`, `lt`,
`lte` or `contains`.

`bot: {name, channel?}` lets a policy play while the predicates judge (`channel`:
`physical-input`, the default — real pointer and key events, the only proof a control works — or
`direct-action`, which calls interactions and sets axes directly): `design/tests/bots/<name>.ts`
exports `{ name, tick(bot) { … } } satisfies BotPolicy`. The types are the kit's
`design/tests/bots/pix3-test-bot.d.ts` (global, no import); a starter's `pix3 check`
type-checks the policy. `tick` runs after the game's tick and what it presses lands on the next
one. Besides `tap(node)` / `press` / `axis` / `moveTo`, `bot.swipe(from, to, frames?)` drags
between two world points (a match-3 swap, a drag-and-drop; `physical-input` only) and
`bot.command(name, args?)` dispatches one of the game's `scene.commands`. A policy written or changed during play needs only `pix3_sync`, not a restart.

The answer — a `fail` or a `timeout` is still `ok: true`; `ok: false` means the run never started:

```json
{
  "ok": true,
  "verdict": "PASS until[0] … (frame 42, 0.70s game) — ….",
  "outcome": { "kind": "until", "channel": "until", "index": 0, "frame": 42, "gameTimeMs": 700, "detail": "…" },
  "metrics": { "frames": 42, "gameTimeMs": 700, "wallMs": 95, "newErrors": 0, "framesPerSecond": 442 },
  "game": { "provider": "…", "snapshot": { "score": 1 }, "changed": { "score": [0, 1] } },
  "notes": [],
  "timeline": []
}
```

`outcome.kind` is `until`, `fail`, `timeout`, `error`, `precondition-already-met`,
`monkey-empty` or, in a bot run, `bot-pass`, `bot-fail`, `bot-error`, `bot-idle`. `game` is there
only when the game registers a snapshot (below): `game.snapshot` at the outcome frame,
`game.changed` = `{path: [atFrame0, atOutcome]}` for every scalar that moved. The run leaves the
game **paused on the outcome frame** (so a screenshot shows what was judged); `pix3_play
{action:"resume"}` lets it run on, or pass `pauseOnOutcome: false`. One run is at most
3600 frames (`maxFrames`, default 600) and 60 s of wall clock (`maxWallMs`, default 20000); a
larger budget is clamped and the result's `notes` say so — a longer session (a whole bot round)
is several runs in a row, the game keeps its state between them.

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
  verify, and then only screenshots are left. `pix3 smoke` prints the same snapshot; in any page
  that runs the game (the dev server, a built `dist/index.html`) a test script of your own reads it
  as `window.__PIX3_GAME_DEBUG__.snapshot()` and calls `.action(name, args)` the same way.
- **Slow motion for a photo of a short effect**: `this.scene.time.slowMotion(0.1)` from a debug
  action (`time.reset()` to end it) — it is the game's own clock, so effects play exactly as fast.
- **Transient effects** (a hover scale, a flash, a punch, a fade) are back at rest by the time a
  separate `take_screenshot` runs — judge them by state: a `nodeProperty` predicate on `scale.x`
  or `opacity` inside the run, not a picture after it. Screenshots are for layout, colour and
  placement. The game page on the dev server carries a small "Pix3 editor" link over the game;
  open it as `/?clean` (with `?scene=` if you need one: `/?clean&scene=…`) for screenshots and
  your own browser tests.
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
