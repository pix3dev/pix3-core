# TODO

Open items with no active plan. A finished plan's follow-ups land here; an item that grows a plan
moves to its own file.

- **C1 dogfood** (gate P1, `.plans/pix3-core.md` §G.2): the remaining scenarios in Codex,
  plus the "Not yet" list in `CLAUDE.md` → Status.
- **Safe-area insets in the runtime**: the starter's page is `viewport-fit=cover`, but the layout
  does not read `env(safe-area-inset-*)` / the visual viewport, so a phone's notch and home bar
  cover anchored UI. Today only a kit workaround (`pix3-nodes` → "Known gaps").
  From `.plans/done/agent-kit-gamedev-pack.md`.
- **Codex skill discovery**: `pix3 kit` installs skills only under `.claude/skills/`; Codex reads
  `.agents/skills/`. Change `packages/cli/src/kit/generate.ts` + `kit --migrate`.
- **Upstream**: a `pix3project.yaml` fingerprint ahead of the three.js row in
  gamedev-skills/awesome-gamedev-agent-skills' router (owner's call — external PR).
- **itch.io note**: `build: 'zip'` → `butler push`, five lines in the kit, if anyone ships there.

From `.plans/done/play-in-page.md` (S6, 2026-11-18):

- **Live property tweak (D11)**: an inspector edit reaching the running game page. One
  `property(...)` call is not parity — undo/redo, components, `LiveComponentService`, textures —
  and it must be bound to a `loadId`. Today: save and Play again.
- **`pix3-e2e` on the page flow**: `bridge-e2e` needs a project with the player and play rows
  for the page (`not_your_page`, `page`, no `playOwner`/`aspect`/`stale playing`); `debug-e2e`
  checks the removed run modes (Game Tab, Game Window, Browser Tab, Profiler).
- **Read the human's page from a shell**: a read-only bridge tool for the human page's
  `registerGameDebug` snapshot and live tree (`page: "designer"`); today only `evaluate_script`
  with chrome-devtools-mcp.
- **Brief `pix3_game_run` answers**: a mode with the verdict, `changed` and the notes only (a
  full answer is ~60 KB for a shell agent).
- **`popup_blocked` timing**: the 10 s first-hello wait is a guess; tune it on a windowed Chrome
  with a real popup blocker (and the 90 s load wait on a real GPU).
- **Negative control on the page** (owner's call, S3): accept `reset(seed)` only, or give the
  page a `restartScene` (`runner.loadAndStartScene(state.scene)`; autoloads not rebuilt) —
  `GameTestHost.restartScene` is the hook.
- **Agent edits reload the human's window** (owner's call, S0): a script or policy sync makes
  Vite full-reload every game page, wiping what the human "showed the agent"; accept, or stop
  the full reload for changes the page does not import (policies).
- **Hand the human's window to the agent** ("continue from here"), out of scope of D7.
- **Runtime exports only the in-editor play used**: `getRuntimeSceneRoot` /
  `registerRuntimeSceneRoot` (the page's tree still reads it), `registerRuntimeLivePropertySink`,
  `SceneRunner.setEditorPeekMask`, `setPhysicsDebugEnabled` / `setDirectionAxesEnabled` (no
  host turns them on now) — keep, rewire to the page's overlay, or drop with a version note.
- **Screenshot right after a long run**: `pix3 bridge screenshot` timed out twice (30 s
  `Page.captureScreenshot`) on the agent page just after a 237-frame `pix3_game_run` in
  SwiftShader, then worked; not seen on a real GPU.
