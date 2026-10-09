# Write model: files are the truth (P1)

Date: 2026-10-09. Derived from `../pix3/.plans/pix3-core.md` §C (C.1–C.4), §B.3, §G.2 ("Гейт P1"), the S12
report (`../pix3-core-spikes/reports/pix3-core-p0-s12.md`) and `.plans/editor-core-port.md` (D4, D5, D6, §9).
Those stay authoritative; where this file disagrees it says so (AGENTS.md rule 13).

`EC` = `packages/editor-core/src`, `VP` = `packages/vite-plugin/src`, `RT` = `packages/runtime/src`.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| W1 | **`norm` in the editor is editor-mode on all three sides.** `baseline.norm := normOf(graph)` of the graph parsed from exactly the baseline text, right after the parse (before any operation); the external version E is parsed by the same `SceneManager` loader (textures come from its cache) and `normOf`'d. Disagrees with §C.2 "натуральный размер … из заголовка картинки … в редакторе" — that is S12 §4.2 option (a); this is option (b). | `SceneLoader` awaits every texture during the parse, so a fresh graph already carries the decoded natural size. One loader on every side cannot disagree with itself; a header parser in the editor could (SVG without `width`/`height`, where the browser's size is not in the header). |
| W2 | The image-header size reader lives in `RT/core/image-header-size.ts` (PNG, JPEG, WebP, GIF, SVG attrs/viewBox) and `NodeAssetLoader` uses it, so `pix3 validate`/`tree`/the plugin see the same `Sprite2D` size the editor does. A spec checks Node `norm` == editor `normOf(graph)` for an unsized sprite. | §C.2 "в редакторе, CLI и плагине одинаково" — the CLI side is where a header is the only source. |
| W3 | Baseline is `{path, sha, text, norm}`; no cached AST. The writer parses the text once per flush. Disagrees with §C.2 `{sha,text,ast,norm}`. | A cached `yaml` AST is mutable shared state; the parse is the cheap part (S12: 21 ms on the largest file). |
| W4 | Pure code (`diff`, `ScenePatchWriter`, `merge`) in `EC/core/scene-patch/`; services in `EC/services/project/`: `SceneBaselineService` (replaces `SceneDiskStateService`), `FlushService` (replaces `SceneWriteService` internals, keeps its public methods so mount/bridge/shell do not change), `SceneDraftService` (IndexedDB). | AGENTS.md: services by domain; non-services in `core/`. |
| W5 | Saver fixes in `RT/core/SceneSaver.ts` + `RT/nodes/Node2D.ts`: (1) properties keep the order they had in the file (`transform` assigned in place, new keys appended) — `save(load(save(x))) == save(x)`; (2) `layout:`/`flow:` blocks carry `enabled` plus non-default keys only, and a disabled block with non-default keys is kept as `enabled: false` (closes S12 §4.4 "flow params lost while disabled"). Layout-derived values (flow positions, stretch sizes, instance child position overrides) stay as §C.2 allows. | §C.2 "Исправления saver'а"; S12 §2.3, §4.1, §4.4. |
| W6 | Fallback when the writer refuses (aliases, non-empty flow `children`, a `PatchError`): full serialization via the fixed saver, with a warning in the log. | §C.2. |
| W7 | `ExternalChangeService` keeps stabilisation + play hold + parse check; it reports into one consumer, `ExternalReloadService`, whose dirty branch becomes the §C.3 key-level merge (`SceneMergeService`). Known-hash recognition moves to the baseline. | One path for external versions (task brief). |
| W8 | Plugin: `.pix3/tx/` changeset (`POST /__pix3/api/changeset`), `.pix3/history/` journal (`GET /__pix3/api/history`, `POST /__pix3/api/history/restore`), recovery at start, claim and every write under the existing `serial` mutex. Single-file `PUT` stays for non-scene writes. | §C.4; port plan D6 / §8.10. |

## 1. Milestones

| M | Content | Acceptance |
|---|---|---|
| W-M1 | W2, W5 | runtime specs: header sizes, saver idempotence on the template corpus, toggles ≤2 lines |
| W-M2 | `EC/core/scene-patch/` from S12 (one parse per flush, splices end→start, CRLF/BOM, aliases → refusal, atomic `{x,y[,z]}` override vectors) | corpus spec: noop byte-identical, `norm(patch) == G`, ≤3 lines per changed key, comments kept, add/delete/move, merge rules |
| W-M3 | `SceneBaselineService` + `FlushService` (§C.1 table, snapshot with `nodeDataChangeSignal` cutoff, patch, `If-Match = baseline.sha`, success → `baseline := snapshot`) | specs on `FakeHost`: drag holds writes, idle 1.5 s, cap 10 s, Ctrl+S, N8 rows, delayed response |
| W-M4 | `SceneDraftService` (checkpoint 2 s + `pagehide`/`visibilitychange`, offer only if disk sha = draft baseline) | specs with fake IndexedDB |
| W-M5 | §C.3 merge for a dirty scene + "agent overwrote your edit" toast | specs: same key / deleted node / structural / N2 |
| W-M6 | W8 + History panel "Restore version" + full §C.3 hand-over | plugin specs: kill between renames, superseded changeset |
| W-M7 | Gate P1 rows in `../pix3-core-spikes/editor-e2e/m3.mjs` | headless Chrome on a real project |

## Progress

- 2026-10-09: plan written.
