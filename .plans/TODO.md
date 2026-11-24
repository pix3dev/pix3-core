# TODO

Open items with no active plan. A finished plan's follow-ups land here; an item that grows a plan
moves to its own file.

- **C1 dogfood** (gate P1, `.plans/pix3-core.md` §G.2): the remaining scenarios in Codex,
  plus the "Not yet" list in `CLAUDE.md` → Status.
- **Codex skill discovery**: `pix3 kit` installs skills only under `.claude/skills/`; Codex reads
  `.agents/skills/`. Change `packages/cli/src/kit/generate.ts` + `kit --migrate`.
- **Upstream**: a `pix3project.yaml` fingerprint ahead of the three.js row in
  gamedev-skills/awesome-gamedev-agent-skills' router (owner's call — external PR).
- **itch.io note**: `build: 'zip'` → `butler push`, five lines in the kit, if anyone ships there.

From `.plans/done/jam-takeaways.md` (2026-11-21):

- **On a real device, in a Capacitor shell (iOS and Android)** — none of it was run on hardware:
  `window.__pix3SetInsets` and `window.__pix3Back` from the shell (the kit's `pix3-mobile`
  `src/shell.ts`), haptics through Capacitor Haptics and Android's `navigator.vibrate`,
  `visibilitychange` / `pagehide` firing in the shell's WebView on home / lock, the save through
  Preferences surviving a kill. The player's shell hooks have no spec (`player/index.ts` imports
  `virtual:pix3/*`); an e2e row would cover them.
- **Dead AudioContext on iOS**: after a lock / unlock or a call iOS can hand back a context whose
  `state` is `running` and whose clock does not advance. `AudioService` resumes on foreground and
  on a touch but does not detect that; detect by `currentTime` not moving across a foreground and
  rebuild the context. Reproduce on a device first.
- **`--check-determinism` in Chrome**: the number of realtime ticks before the bot starts drifts
  (206–215), so a snapshot that carries a tick count is "not same-twice". Start the bot on a fixed
  tick (or the first fixed-step tick) instead of teaching the CLI which path to ignore.
- **Replay gaps**: a resize is recorded but not replayed; the page's locale is not replayed in
  Chrome (Node does); a node whose position its `layout` owns is re-laid out at render, which Node
  does not do, so a script moving such a node diverges in Node; no record / replay on `dist`
  (the recorder is not in a build).
- **Pixel warnings**: the facts cache has no override flag; spritesheet-mode `.pix3anim` frames
  (UV rects) and `AnimatedSprite3D.frames` are not measured.
- **`pix3 slice`**: half-transparent shadows near the key colour partly show through; frames of a
  clip that shrank are not deleted.
- **Quality tier `scene.quality`** (out of the plan): no weak-device telemetry, a first-frames
  probe is noisy (shader warm-up), `maxPixelRatio` is fixed at renderer creation. `runtimeQuality`
  through `RunOverrides` is enough for now.
- **The game's doc discipline** (`verify-docs`, `codemap-audit`) and `pix3 kit --with …` — on the
  owner's request.
- **A promo video** (`pix3 play --record` as video) and server time.

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
- **Negative control on the page** (owner's call, after S6): no scene restart on the page;
  `reset(seed)` is the only in-page reset. A possible future: a real page reload with the run
  resumed from URL params.
- **Agent page left behind / popup blocker** (owner's windowed Chrome): once an agent page stayed
  listed after `stop`, and the popup blocker behaved differently between runs. Confirm in a
  windowed Chrome that a `noopener` page can always `window.close()` itself; consider one
  reusable agent window so repeated starts never pile up windows.
- **Hand the human's window to the agent** ("continue from here"), out of scope of D7.
- **Screenshot right after a long run**: `pix3 bridge screenshot` timed out twice (30 s
  `Page.captureScreenshot`) on the agent page just after a 237-frame `pix3_game_run` in
  SwiftShader, then worked; not seen on a real GPU.

From `.plans/done/design-feedback.md` (2026-11-23), review findings left open on purpose:

- **Screen checks (`pix3 play --screens`)**: captions overlapping in one box mix their glyph masks
  (hide one caption at a time); a press target narrower than the 4 px seed scan is missed, and a
  non-rectangular one is under-measured (centroid chords of a triangle); the frame with captions
  hidden is not checked for repeating itself; a caption counts as `covered` (not judged) by a
  later mesh's whole box at ≥ 0.5 opacity, so a mostly transparent sprite over it (a glow, a frame
  with a hole) hides a caption that still shows; a press target that is a script-hit-tested sprite is invisible
  to the size check; the gallery checks never run in CI.
- **Run report**: `haptics` and `analytics` are read through the first live root, so a run that
  ends with no root loses them.
- **`juice.hitFlash`**: not yet looked at on real pixels in Chrome (a sprite with transparent
  edges); the first flash of a variant in a session still compiles it synchronously in that call
  (one hitch; `compileAsync` would need the flash to wait a frame); the program hold
  (`ProgramKeeper`) cannot reproduce render-time clipping state, so a clipped (`ScrollContainer`)
  flashed sprite may still compile per its own lifetime. Other effect variants only short-lived
  nodes use (a `core:tint` on spawned sprites) are not held and still relink after the last such
  node is freed (PipeBlast: the tint variant linked twice in a round).

From the PipeBlast 3D style lab (2026-11-24): `.plans/pipeblast-3d-lab-bugs.md` — the editor
writing invalid YAML into an empty `config: {}` (B1), four smaller bugs, and the renderer, bake and
editor-preview settings a 3D scene cannot reach without a dev global.

Known behaviour (owner's call): an agent's script or policy edit makes Vite full-reload every game
page, the human's included. `three` stays a peer dependency of `@pix3/vite-plugin`.
