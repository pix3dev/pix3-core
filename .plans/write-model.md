# Write model: files are the truth (P1)

Date: 2026-10-09. Derived from `../pix3/.plans/pix3-core.md` §C (C.1–C.4), §B.3, §G.2 ("Гейт P1"), the S12
report (`../pix3-core-spikes/reports/pix3-core-p0-s12.md`) and `.plans/editor-core-port.md` (D4, D5, D6, §9).
Those stay authoritative; where this file disagrees it says so (AGENTS.md rule 13).

`EC` = `packages/editor-core/src`, `VP` = `packages/vite-plugin/src`, `RT` = `packages/runtime/src`.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| W1 | **`norm` in the editor is editor-mode on all three sides.** `baseline.norm := normOf(graph)` of the graph parsed from exactly the baseline text, right after the parse (before any operation); the external version E is parsed by the same `SceneManager` loader (textures come from its cache) and `normOf`'d. Disagrees with §C.2 "натуральный размер … из заголовка картинки … в редакторе" — that is S12 §4.2 option (a); this is option (b). | `SceneLoader` awaits every texture during the parse, so a fresh graph already carries the decoded natural size. One loader on every side cannot disagree with itself; a header parser in the editor could (SVG without `width`/`height`, where the browser's size is not in the header). |
| W2 | The image-header size reader lives in `RT/core/image-header-size.ts` (PNG, JPEG, WebP, GIF, SVG attrs/viewBox) and `NodeAssetLoader` uses it, so `pix3 validate`/`tree`/the plugin see the same `Sprite2D` size the editor does (spec: an un-sized `Sprite2D` normalises to the PNG's size in Node). Cross-checked in Chrome against the decoded size for every textured node type (`size-crosscheck.mjs`, 39 checks). | §C.2 "в редакторе, CLI и плагине одинаково" — the CLI side is where a header is the only source. |
| W3 | Baseline is `{path, sha, text, norm}`; no cached AST. The writer parses the text once per flush. Disagrees with §C.2 `{sha,text,ast,norm}`. | A cached `yaml` AST is mutable shared state; the parse is the cheap part (S12: 21 ms on the largest file). |
| W4 | Pure code (`diff`, `ScenePatchWriter`, `merge`) in `EC/core/scene-patch/`; services in `EC/services/project/`: `SceneBaselineService` (replaces `SceneDiskStateService`), `FlushService` (replaces `SceneWriteService` internals, keeps its public methods so mount/bridge/shell do not change), `SceneDraftService` (IndexedDB). | AGENTS.md: services by domain; non-services in `core/`. |
| W5 | Saver fixes in `RT/core/SceneSaver.ts` + `RT/nodes/Node2D.ts`: (1) a fixed property order — the keys of the node's bag in their order, then keys a type branch materialises, `transform` last (some nodes, lights, build their bag in the constructor, so "the file's order" is not available for every key) — `save(load(save(x))) == save(x)`; (2) `layout:`/`flow:` blocks carry `enabled` plus non-default keys only, and a disabled block with non-default keys is kept as `enabled: false` (closes S12 §4.4 "flow params lost while disabled"). Layout-derived values: see W16. | §C.2 "Исправления saver'а"; S12 §2.3, §4.1, §4.4. |
| W6 | Fallback when the writer refuses (aliases, non-empty flow `children`, a `PatchError`): full serialization via the fixed saver, with a warning in the log. | §C.2. |
| W7 | `ExternalChangeService` keeps stabilisation + play hold + parse check; it reports into one consumer, `ExternalReloadService`, whose dirty branch becomes the §C.3 key-level merge (`SceneMergeService`). Known-hash recognition moves to the baseline. | One path for external versions (task brief). |
| W8 | Plugin: `.pix3/tx/` changeset (`POST /__pix3/api/changeset`), `.pix3/history/` journal (`GET /__pix3/api/history`, `POST /__pix3/api/history/restore`), recovery at start, claim and every write under the existing `serial` mutex. Single-file `PUT` stays for non-scene writes. | §C.4; port plan D6 / §8.10. |
| W9 | Notices ("тост" of §C.1/§C.3) are `appState.project.host.notices` owned by `HostNoticeService`, rendered under the state banner of `pix3-host-banner`, each also written to the log. | No toast surface existed; the banner is where "this tab cannot save" already lives. |
| W10 | `EditorHost` gains optional `history` (journal) and `files.writeChangeset`; `HostFileFailure.path`. A host without them degrades: no journal (merges still work, "kept in History" is not promised), per-file writes. | The contract is the seam (port plan D1). |
| W11 | Esc during a drag cancels it (nodes back, no operation): 2D handle drags and the 3D gizmo (`cancel3DTransform` ends the `TransformControls` drag with its `mouseUp` ignored). | Gate row "Esc во время drag" assumed an affordance the editor did not have (rule 13). |
| W12 | A read-only tab follows the writer tab: `ExternalChangeService` skips only frames whose `writerId` is this tab's (it skipped every `author: 'editor'` frame), and `scene.reload` / `scene.refresh-prefab-instances` are allowed in read-only mode. | Found by the browser gate: tab B kept a stale scene. |
| W14 | A scene file that is exactly what `JSON.stringify` prints (minified or indented) is patched as data and re-printed with its own layout (`scene-json-writer.ts`); anything else takes the YAML splice path. | DeepCore has JSON scenes (valid YAML); the splice writer produced invalid YAML on them and every flush fell back to a block-YAML rewrite. |
| W15 | An SVG's header size is what Chrome's `<img>` decodes: a missing/relative width or height comes from the `viewBox` ratio, else 300×150. | Measured in the browser (`size-crosscheck.mjs`, 13/13); a `viewBox`-only SVG is 300×150 there, not its box. |
| W16 | **Flow-computed values are masked, not written.** `editorNormOfGraph(graph, B)` (= `normOfGraph` with every flow-derived leaf set back to B's value: a flow child's position — main axis only for an anchored child —, an `autoSize` container's main-axis size, the same as prefab-instance overrides) is the G of every diff: flush, draft, merge, bridge. `normOfGraph` stays for a fresh parse (a baseline, E). Anchor-layout rects (stretch/edges after a parent resize) are **still written**; a merge that drops the parent's resize drops them with it (`laid-out`). | Closes S12 §4.1(б) for the flow, contained in the editor (`EC/core/scene-patch/layout-derived.ts`). The anchor rects are not derivable: a child's rect against its parent's authored size is how the margins are stored (`Node2D.resolveHorizontalLayout`), so omitting it would move the child on reload. |
| W17 | Clobber detection keeps a **flush ledger** per path (key → value written, values replaced) since the last external version; E putting any key back to a replaced value is "agent overwrote your edit" for all of them; E settles the ledger. Replaces `LastFlush`. | §C.3 accepted "only the last flush" as a regression vs 1.x; the ledger is the protected set's window without its persistence. |
| W18 | **A write without an answer may have landed.** A flush failing with no HTTP answer records the sha of the text it sent (each attempt on the same baseline); a disk with exactly those bytes is the editor's own write — a 412 naming it or `ExternalChangeService` seeing it adopts it as the baseline (`acceptOwnHash`), and a draft stores those shas (`unconfirmedShas`) and is offered over either. | The N9 flake: Vite destroys open sockets on `close()` after the plugin renamed the file in place. A sha match is proof the bytes are this text, whoever answered. |
| W13 | `__PIX3_DEBUG__.status()` reports `dirty`, `flushing`, `gestureInProgress`, `pendingExternal`; `node(id).saved` is the node as the file gets it, `pending()` the unsaved keys per scene, `screen(id)` a node's origin on the page (to click or drag it). | The agent's view of §C.1's "dirty" indicator and of why a sync answers `gesture_in_progress`. |

## 1. Milestones

| M | Content | Acceptance |
|---|---|---|
| W-M1 | W2, W5 | runtime specs: header sizes, saver idempotence on the template corpus, toggles ≤2 lines |
| W-M2 | `EC/core/scene-patch/` from S12 (one parse per flush, splices end→start, CRLF/BOM, aliases → refusal, atomic `{x,y[,z]}` override vectors) | corpus spec: noop byte-identical, `norm(patch) == G`, ≤3 lines per changed key, comments kept, add/delete/move, merge rules |
| W-M3 | `SceneBaselineService` + `FlushService` (§C.1 table, snapshot with `nodeDataChangeSignal` cutoff, patch, `If-Match = baseline.sha`, success → `baseline := snapshot`) | specs on `FakeHost`: drag holds writes, idle 1.5 s, cap 10 s, Ctrl+S, N8 rows, delayed response |
| W-M4 | `SceneDraftService` (checkpoint 2 s + `pagehide`/`visibilitychange`, offer only if disk sha = draft baseline) | specs with fake IndexedDB |
| W-M5 | §C.3 merge for a dirty scene + "agent overwrote your edit" toast | specs: same key / deleted node / structural / N2 |
| W-M6 | W8 + History panel "Restore version" + full §C.3 hand-over | plugin specs: kill between renames, superseded changeset |
| W-M7 | Gate P1 rows in `../pix3-core-spikes/editor-e2e/gate-p1.mjs` (M3 stays as is) | headless Chrome on a real project |

## Progress

- 2026-10-09: plan written.
- 2026-10-09: W-M1…W-M7 done (commits `71faad4`…`f2a16ef`, local).
  - **W-M1** runtime: `save(load(save(x))) == save(x)` on all 30 template scenes (13/34 failed in S12); `layout`/`flow` write `enabled` + non-default keys (toggle = 1–2 lines; a disabled flow keeps its parameters); `NodeAssetLoader` sizes textures from the image header.
  - **W-M2** `EC/core/scene-patch/`: corpus spec 156/156 (noop byte-identical, `norm(patch) == graph`, comments kept, ≤3 lines per key, add/delete/reparent/reorder, instance override + root, N2, merge rules).
  - **W-M3** `FlushService` + `SceneBaselineService` replace `SceneWriteService`/`SaveSceneOperation`/`SceneDiskStateService`. `SaveSceneCommand` pushed every save into the undo history — removed. Play start flushes first.
  - **W-M4** `SceneDraftService` (IndexedDB). `beforeunload` warns only when a dirty scene has no durable checkpoint of its current state.
  - **W-M5** `SceneMergeService` (§C.3) + clobber detection + prefab re-baseline; `HostNoticeService`.
  - **W-M6** plugin changeset-tx, recovery, journal (by a sub-agent, reviewed); editor: one changeset for ≥2 dirty scenes, History panel "Versions on disk" + "Restore…", two-tab hand-over steps 2–4 (`WriterService.reconcile`, `rejected-draft` on `writer_superseded`).
  - **W-M7** gate: `../pix3-core-spikes/editor-e2e/gate-p1.mjs`, headless Chrome 155, real input over CDP, judged by bytes on disk / bridge / DOM / network. Green on 10 consecutive runs after the harness fixes below (37 checks; 36 after dropping a check that proved nothing — "A's history intact"); one more run did not start (Chrome did not come up). Seen twice before those fixes and not since: the reopened tab rejected the N9 draft as "the file changed on disk since" — unexplained; the gate prints the draft's baseline sha, the disk sha and the journal when it happens.
  - `npm test` (all packages), `lint`, `type-check` clean.

### Gate P1 (§G.2) — where each row is proven

| Row | Proof | Result |
|---|---|---|
| Drag | gate: 0 `PUT`/changeset between the drag crossing the 5 px threshold and the release | ✓ (2.6 s drag, 0 writes) |
| Idle after drag | gate: on disk 1.5–1.6 s after release, diff 2 lines, 24/24 comments in order | ✓ |
| Continuous edits 15 s | gate: 12 one-direction drags 1.2–1.5 s apart; first write 10.0–10.2 s after the first edit; none inside a gesture | ✓ |
| Esc during drag | gate: node back, 0 writes | ✓ (after W11) |
| N10 | gate: rename → `__PIX3_DEBUG__.sync()` at once → file has it (sync 28 ms) | ✓ |
| N8 flush → Ctrl+Z → agent rename | gate: disk = original position + agent rename (diff 2 lines vs the original) | ✓ |
| N8 perform → undo → external write | spec `SceneMergeService.spec` | ✓ |
| N8 coalesce across a flush | spec `FlushService.spec` (coalesced steps before and after a flush: final value on disk, one history entry, Ctrl+Z in memory then flushed) | ✓ |
| N8 edit during a delayed changeset response | spec `FlushService.spec` (write gated, edit after the cutoff stays dirty, Ctrl+Z after) | ✓ |
| External same key / deleted node / structural | gate (same key: notice + `rejected-draft` in `.pix3/history`) + specs (all three) | ✓ |
| N2 | specs (corpus + merge) | ✓ |
| Ctrl+Z after flush | gate: undone in memory, dirty, next flush restores the original bytes | ✓ |
| N6 error of the 2nd rename / kill between renames | plugin specs `changeset.spec` (fault after rename 1 → both old; kill + restart → roll forward or back) | ✓ (not over HTTP: the fault hook is a `ProjectFiles` option) |
| N4 | `plugin-barrier.mjs` / M3 (unchanged by this work) | as before |
| Script edit with `/` open | M3 | as before |
| Close tab → new tab → first edit | gate: new tab is the writer; Ctrl+S → disk in ~20 ms | ✓ |
| Two tabs | gate: B read-only + banner, **B follows A's writes** (after W12), no 412, take over, B's edit on disk | ✓; "A's history intact" is not checked in the browser (the bridge does not expose the undo stack; nothing in the hand-over touches it) |
| Changeset A after B's claim | plugin spec (claim under the mutex; late changeset → 409) | ✓ |
| A dies mid-changeset | plugin spec (recovery at start) | ✓ |
| Sync with a stale `expect` | plugin (unchanged) | as before |
| N9 draft | gate: dev server stopped, edit, checkpoint in IndexedDB, tab closed, server restarted, new tab offers it, "Restore" writes it | ✓ |
| Play rows | M3 (unchanged) | as before |

Harness lessons (rule 12) — three "failures" were the harness, one "pass" was too: a fixed press point slid off the node after the first drag (later drags moved nothing, so "positions equal" passed trivially and hid W12); alternating ±12 px drags put the node back on its baseline every second gesture (a flush then rightly writes nothing); the gesture window started at the press, not at the 5 px threshold.

- 2026-10-09 (after push `220d6bc`): DeepCore corpus (`PIX3_EXTRA_CORPUS=../DeepCore`, 6 scenes + 6 JSON copies) 216/216 with the templates after W14; header-vs-decoded size cross-check in Chrome 13/13 — and found that **no SVG sprite loaded in the 2.x editor** (type-less blobs from `ProjectStorageService.readBlob`; fixed); W11 for the 3D gizmo, checked in Chrome (`esc3d.mjs`, with a no-Esc control); §C.3 "changed nodes highlighted for 3 s" wired (it was a dead affordance in the tree); `services/project/coauthoring/` → `disk/`, `external-merge/` removed; the plugin no longer lets a closing `ProjectFiles` write behind the next server's back (in-process restart). Browser scripts committed in `../pix3-core-spikes` (`71079b3`).

- 2026-10-09 (debts): the five open items below were worked through (commits local, `06dbd2d`…`0c33774`; browser scripts in `../pix3-core-spikes`).
  - **DeepCore** is one command: `npm run test:corpus` (`06dbd2d`; `../DeepCore` by default, another project as the argument; fails if the project is missing). The saver fixed-point spec takes the extra corpus too. 263/263 (scene-patch spec 218, of them 60 on DeepCore's 12 scenes; saver spec 45, of them 12 DeepCore) before and after every writer/merge change below.
  - **Size cross-check** (`size-crosscheck.mjs`, 39/39): besides `Sprite2D`, every textured type saves the same node in the editor as the runtime's Node harness (loaded through Vite SSR), and a `flow`/`autoSize` column over un-sized sprites lays out the same from decoded and from header sizes. `Sprite3D`, `AnimatedSprite2D/3D` and the UI controls do not take their saved size from the texture at all (defaults; the controls keep the natural size privately for 9-slice), and no runtime UI auto-sizes from a texture except through the flow — so the S12 §4.2 risk exists only for `Sprite2D`, already covered. The check found two real bugs, fixed: an `AnimatedSprite2D` with no (or an unknown) clip wrote the resource's first clip once the `.pix3anim` loaded — a pending key on open and a write on the first flush (`23b0507`, runtime); and the editor never laid out a scene loaded into an already measured viewport, so a flow column showed its file positions until a resize (`c28a52e`).
  - **Layout-derived values** (W16, `fd439b8`): closed for everything the flow computes; S12's "flowEnabled on an instance root" is one override line. Not closed for anchor-layout rects — see below.
  - **Clobber** (W17, `a7e2780`): every flush since the last external version; spec with three flushes and a stale read from before the first.
  - **N9 flake** (W18, `0c33774`): cause found and reproduced on demand — `n9-race.mjs` stops the server the moment a Ctrl+S is on disk: before the fix 6/6 rejected, after 22/22 offered and restored (three runs) (keeping only the last attempt was not enough: 6/8 rejected — the idle retry while the server is down replaced it). The in-process-restart race of `21afe92` was not it (the data shows the draft's baseline = the version before the lost save, the disk = that save). Gate P1 after all changes: 5 runs × 37/37 (N9 4/4 each), plus 6 × 37/37 before the runtime/viewport commits. Harness (rule 12): the gate's fixed Chrome port 9366 was shared with a leftover Chrome of a killed run and another agent's Chrome — the "Chrome did not come up" and one hung run; `launchChrome` now takes a free port and kills its Chrome on exit. After a runtime change the dev server's `.vite-cache*` must go (it pre-bundles `@pix3/runtime` and kept the old `AnimatedSprite2D`).
  - `npm test` (3555), `lint`, `type-check` clean at every commit.

### Debt / open

- **Anchor-layout rects after a parent resize still flush** (W16): resizing a container writes the stretched/edge-anchored children's `width`/`height`/`position` too. Not a bug of the writer: under the current format a child's rect against its parent's *authored* size is the only place the margins live (`resolveHorizontalLayout` derives them from it), so the file must change or the child moves on reload. A merge stays consistent (`laid-out`). Smallest next step: store the margins in the `layout:` block of an edge/stretch-anchored node (loader + saver + `pix3 validate` table + spec "Scene File Format"), after which those rects are derived and can be masked like the flow (`layout-derived.ts`) — a format change, hence not done here.
- Clobber detection does not track structural flushes (a node the editor added/removed/moved that a stale write undoes), and the ledger lives in the tab (1.x persisted its protected set in `.pix3/protected.json`).
- DeepCore stays out of CI by design; run `npm run test:corpus` after any writer change and before the migration (§A.4).
