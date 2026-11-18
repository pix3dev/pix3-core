# Play на странице игры — текст кита для S5

Черновик к `.plans/play-in-page.md`, этап S4: кит под новый поток пишется сейчас, а в
`packages/cli/kit-src/` попадает в S5 вместе с переключением `playHost` по умолчанию и публикацией
`PAGE_BRIDGE_TOOLS` как единственной таблицы `bridge-tools.ts` (до S5 кит описывает вкладку Game,
и его drift-спека держит кит к `BRIDGE_TOOLS`). Текст ниже — английский, как в ките; в S5 он
заменяет указанные места, затем `npm run build-kit` и `kit.spec.ts`.

## `kit-src/skills/pix3-editor/SKILL.md`

### description (frontmatter)

> … the sync → read → edit → sync loop, what a not-ok `pix3_sync` means (`expect_mismatch`,
> `gesture_in_progress`), your own game page and the human's (`not_your_page`), `pix3_game_run`,
> screenshots of the game page, …

### §1, after step 3 — new paragraph

The game does not run in the editor tab. `pix3_play start` opens **your game page**, a second
page in the same Chrome (`<dev server>/?debug&role=agent&mute…`, window `pix3-agent-play`); the
human's Play window is another (`…?debug&role=designer…`). `list_pages` shows them. The `pix3_*`
tools stay on the editor tab (`select_page` it for every `execute_3p_developer_tool`); only
`take_screenshot`, `click_at` and `press_key` go to a game page — `select_page` the one whose URL
the answer named (`page.url`), then select the editor tab again.

### §2, rows that change

| Tool | Params | Does |
| --- | --- | --- |
| `pix3_status` | — | … `play` `{playHost: "page", pages: [{role, url, loadId, rev, scene, status, paused, pausedBy?}]}` — the game pages open now: `designer` = the human's, `agent` = yours … |
| `pix3_scene` | `path?`, `maxDepth?`, `nodeId?`, `find?`, `page?` | as before; while a game page is open, `nodeId` / `find` also read the running game there: `live.components`, `screen` (CSS px **of that page** — `click_at` there, not in the editor tab) and `page {role, loadId}`; `page` `designer\|agent` picks it (default: the human's while open, else yours) |
| `pix3_play` | `action` `start\|stop\|restart\|pause\|resume\|status`, `scenePath?`, `run?` | your game page: `start` writes the editor's unsaved edits and loads the page fresh with the active scene (or `scenePath`); answers `page {url, loadId, rev}` once it is ready; `restart` = a fresh load with the last start's scene and `run`; `stop` closes it; `status` lists the pages. No `aspect`: exact phone sizes are `npx pix3 play --size` |
| `pix3_game_run` | as before | runs on your game page; after a `pix3_sync` that reloaded it, it waits for the new load; the answer carries `page` |
| `pix3_screenshot` | `target` `game\|viewport`, `page?` | `game`: brings a game page to the front (`page`; default the human's while open, else yours) and answers its `page {role, url, loadId}` — `select_page` that one for `take_screenshot` |
| `pix3_errors` | `since?`, `clear?`, `page?` | errors of the editor and the game pages, each with `origin` (`editor`, `designer`, `agent`) and a page's `loadId` |

After the table: "tap or drag the running game with chrome-devtools-mcp's `click_at {x, y}` /
`press_key` **on your game page** at the `screen` `pix3_scene {nodeId, page: "agent"}` gives —
coordinates of the human's page or of an older load of yours land nowhere."

### §3 step 4

> **Then verify**: `npm run check`, and `pix3_play {action:"restart"}` (or `start`) →
> `pix3_game_run` with predicates → `pix3_errors` → `pix3_screenshot {target:"game", page:"agent"}`
> + `take_screenshot` of that page.

### §4 — rows

Remove `stale` / `playing` (a sync is never held for play). After the table a second one:

| `reason` | Meaning | Do |
| --- | --- | --- |
| `not_your_page` | you aimed `start`/`restart`/`stop`/`pause`/`resume`/`pix3_game_run`/input at the human's page, or called from a read-only editor tab | read it with `page:"designer"`; drive your own page |
| `no_game_page` | that page is not open (or did not answer) | `pix3_play {action:"start"}` |
| `popup_blocked` | the browser refused the window; the answer has `url` | open `url` with `new_page`, then `pix3_play` again (`npx pix3 bridge` does it itself) |
| `flush_failed` | the editor could not write its unsaved edits; nothing started | `pix3_status`, `pix3_sync`, then start again |
| `page_reloaded` | your page reloaded during the call (a script or bot-policy change does that) | run again |
| `page_stale` | your page is older than the last `pix3_sync` and did not reload by itself (a scene or asset changed) | `pix3_play {action:"restart"}`, then run |

### §5 — replaced: «Your game page and the human's»

The human plays in their own window; you play on yours. Everything that changes a game —
`start`, `restart`, `stop`, `pause`, `resume`, `pix3_game_run`, `click_at`, `npx pix3 bridge
tap/swipe` — goes to your page; aimed at the human's it is `not_your_page`, whatever you pass.
Reading works on both: `pix3_scene`, `pix3_screenshot`, `pix3_errors` take `page:"designer"` to
look at the game exactly as the human has it. When the human found a bug, they press **Show agent**
on their page: the game pauses there and they paste you a message with the page, its `loadId`,
the scene, the frame and the latest errors — read that page as it is, then reproduce on yours.

Each `start`/`restart` is a new load of the files on disk (`page.loadId` changes; `run` puts its
seed and config into the URL). A script or bot-policy change you sync reloads every game page by
itself — the human's too — so read their page before you change a script. Your page closes after
10 idle minutes; `start` opens it again.

`pix3_game_run` needs your page (`no_game_page` otherwise; `pix3_play start` first). [the
predicates, bots and answer paragraphs stay as they are]

### §7 — short forms

`play.start()` … stay; `play.status()` returns `{playHost, pages}`.

### §8 — keepalive

> Your game page keeps ticking while it is hidden for as long as a run or `watch` holds it (frames
> from a worker); Chrome that `pix3 editor` started does not throttle background pages and lets
> the editor open your page without a click (`--disable-popup-blocking`).

### §9 — rows that change

| MCP | Shell |
| --- | --- |
| `pix3_play {action}` | `npx pix3 bridge play '{"action":"start"}'` (`restart`, `stop`, `resume`, `status`); a blocked window is opened by the CLI itself |
| `pix3_screenshot` + `take_screenshot` | `npx pix3 bridge screenshot [--page designer\|agent] [--out f.png]` — captures that game page |
| `click_at` at a `screen` | `npx pix3 bridge tap --node <id or name> [--touch]` or `tap <x> <y>` — your page only, refused (`page_reloaded`) when the page reloaded since the node was read |

The paragraph on `pausedBy` stays: `pix3_play status` → `pages[agent].pausedBy`.

## `kit-src/AGENTS.md`, rule 4

> … Then run the game: with the editor open, `pix3_sync` with `expect` and `pix3_play` /
> `pix3_game_run` / `pix3_errors` / a screenshot of **your game page** (`pix3-editor`: the game runs
> on its own page; the human's Play window you read, never drive); without it, `pix3 smoke` …

## `kit-includes/engine-api-map.md`

Без изменений: в нём нет ни запуска игры, ни моста.

## Проверка в S5

- `kit.spec.ts`: таблица §2 = `BRIDGE_TOOL_NAMES` (после S5 — из `PAGE_BRIDGE_TOOLS`), причины
  §4 ⊆ `BRIDGE_REASONS` (новые причины туда уже внесены в S4).
- Слепой прогон агента по киту на `core-tests` (S5): каждое место, где агент ошибся страницей, —
  правка этого текста.
