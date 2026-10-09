# Write model: files are the truth (P1)

Date: 2026-10-09. Derived from `../pix3/.plans/pix3-core.md` §C (C.1–C.4), §B.3, §G.2 ("Гейт P1"), the S12
report (`../pix3-core-spikes/reports/pix3-core-p0-s12.md`) and `.plans/editor-core-port.md` (D4, D5, D6, §9).
Those stay authoritative; where this file disagrees it says so (AGENTS.md rule 13).

`EC` = `packages/editor-core/src`, `VP` = `packages/vite-plugin/src`, `RT` = `packages/runtime/src`.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| W1 | **`norm` in the editor is editor-mode on all three sides.** `baseline.norm := normOf(graph)` of the graph parsed from exactly the baseline text, right after the parse (before any operation); the external version E is parsed by the same `SceneManager` loader (textures come from its cache) and `normOf`'d. Disagrees with §C.2 "натуральный размер … из заголовка картинки … в редакторе" — that is S12 §4.2 option (a); this is option (b). | `SceneLoader` awaits every texture during the parse, so a fresh graph already carries the decoded natural size. One loader on every side cannot disagree with itself; a header parser in the editor could (SVG without `width`/`height`, where the browser's size is not in the header). |
| W2 | The image-header size reader lives in `RT/core/image-header-size.ts` (PNG, JPEG, WebP, GIF, SVG attrs/viewBox) and `NodeAssetLoader` uses it, so `pix3 validate`/`tree`/the plugin see the same `Sprite2D` size the editor does (spec: an un-sized `Sprite2D` normalises to the PNG's size in Node). The cross-check against the editor's decoded size is not automated yet (debt). | §C.2 "в редакторе, CLI и плагине одинаково" — the CLI side is where a header is the only source. |
| W3 | Baseline is `{path, sha, text, norm}`; no cached AST. The writer parses the text once per flush. Disagrees with §C.2 `{sha,text,ast,norm}`. | A cached `yaml` AST is mutable shared state; the parse is the cheap part (S12: 21 ms on the largest file). |
| W4 | Pure code (`diff`, `ScenePatchWriter`, `merge`) in `EC/core/scene-patch/`; services in `EC/services/project/`: `SceneBaselineService` (replaces `SceneDiskStateService`), `FlushService` (replaces `SceneWriteService` internals, keeps its public methods so mount/bridge/shell do not change), `SceneDraftService` (IndexedDB). | AGENTS.md: services by domain; non-services in `core/`. |
| W5 | Saver fixes in `RT/core/SceneSaver.ts` + `RT/nodes/Node2D.ts`: (1) a fixed property order — the keys of the node's bag in their order, then keys a type branch materialises, `transform` last (some nodes, lights, build their bag in the constructor, so "the file's order" is not available for every key) — `save(load(save(x))) == save(x)`; (2) `layout:`/`flow:` blocks carry `enabled` plus non-default keys only, and a disabled block with non-default keys is kept as `enabled: false` (closes S12 §4.4 "flow params lost while disabled"). Layout-derived values (flow positions, stretch sizes, instance child position overrides) stay as §C.2 allows. | §C.2 "Исправления saver'а"; S12 §2.3, §4.1, §4.4. |
| W6 | Fallback when the writer refuses (aliases, non-empty flow `children`, a `PatchError`): full serialization via the fixed saver, with a warning in the log. | §C.2. |
| W7 | `ExternalChangeService` keeps stabilisation + play hold + parse check; it reports into one consumer, `ExternalReloadService`, whose dirty branch becomes the §C.3 key-level merge (`SceneMergeService`). Known-hash recognition moves to the baseline. | One path for external versions (task brief). |
| W8 | Plugin: `.pix3/tx/` changeset (`POST /__pix3/api/changeset`), `.pix3/history/` journal (`GET /__pix3/api/history`, `POST /__pix3/api/history/restore`), recovery at start, claim and every write under the existing `serial` mutex. Single-file `PUT` stays for non-scene writes. | §C.4; port plan D6 / §8.10. |
| W9 | Notices ("тост" of §C.1/§C.3) are `appState.project.host.notices` owned by `HostNoticeService`, rendered under the state banner of `pix3-host-banner`, each also written to the log. | No toast surface existed; the banner is where "this tab cannot save" already lives. |
| W10 | `EditorHost` gains optional `history` (journal) and `files.writeChangeset`; `HostFileFailure.path`. A host without them degrades: no journal (merges still work, "kept in History" is not promised), per-file writes. | The contract is the seam (port plan D1). |
| W11 | Esc during a drag cancels it (nodes back, no operation): 2D handle drags and the 3D gizmo (`cancel3DTransform` ends the `TransformControls` drag with its `mouseUp` ignored). | Gate row "Esc во время drag" assumed an affordance the editor did not have (rule 13). |
| W12 | A read-only tab follows the writer tab: `ExternalChangeService` skips only frames whose `writerId` is this tab's (it skipped every `author: 'editor'` frame), and `scene.reload` / `scene.refresh-prefab-instances` are allowed in read-only mode. | Found by the browser gate: tab B kept a stale scene. |
| W14 | A scene file that is exactly what `JSON.stringify` prints (minified or indented) is patched as data and re-printed with its own layout (`scene-json-writer.ts`); anything else takes the YAML splice path. | DeepCore has JSON scenes (valid YAML); the splice writer produced invalid YAML on them and every flush fell back to a block-YAML rewrite. |
| W15 | An SVG's header size is what Chrome's `<img>` decodes: a missing/relative width or height comes from the `viewBox` ratio, else 300×150. | Measured in the browser (`size-crosscheck.mjs`, 13/13); a `viewBox`-only SVG is 300×150 there, not its box. |
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

### Debt / open

- Layout-derived values (flow positions, stretch sizes, instance child overrides under a flow root) still flush as authored (§C.2 accepts it until after MVP); they also show up as `pending` keys in a merge.
- Clobber detection catches only the last flush (§C.3, known regression vs 1.x).
- DeepCore is checked only locally (`PIX3_EXTRA_CORPUS`); rerun it after any writer change and before the migration (§A.4).
- The size cross-check covers `Sprite2D`; `AnimatedSprite2D`, `Sprite3D` and auto-sized UI (S12 §4.2 asks for them too) are not checked.
- The N9 "file changed on disk since" flake (seen twice before the harness fixes) is unexplained; the in-process restart race fixed in the plugin is one candidate.
