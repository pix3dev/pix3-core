# Play на странице игры: один путь запуска, отладка в оверлее, редактор без play-режима

Дата: 2026-11-18. Статус: ревизия 4 — S0 выполнен (§7), D6, D10, S1, S3, S4 уточнены по его итогам.
Утверждения о коде проверены по исходникам (`2.0.0-alpha.8`, `dae25f9`), рядом указан путь.
Ревью Codex шло по тексту плана: его песочница здесь не читает файлы.

## 0. Коротко

1. Игра запускается **только на своей странице** — плеер `packages/vite-plugin/player`, тот же,
   что уходит в `dist`. Запуск внутри редактора (вкладка Game, окно Game Window) удаляется.
2. Панель **Runtime переезжает в debug-оверлей** страницы игры (`/?debug`) рядом с профайлером.
3. **Тест-хост агента** (`pix3_game_run`: предикаты, боты, monkey, watch) переезжает на страницу
   игры. Один хост обслуживает редактор, `pix3 bridge` и headless `pix3 play`.
4. Имена агентских инструментов сохраняются, меняется адресат: редактор пересылает вызов
   странице игры. Изменения протокола перечислены явно (§2.2).
5. Каждый запуск и перезапуск — **новая загрузка страницы**. Редактор не держит «режима play»
   и ничего не откладывает на время игры.

Порядок: S0 спайк и сверка гарантий → S1 API страницы → S2 дерево в оверлее → S3 тест-хост на
странице → S4 связь и инструменты за флагом → S5 проверка и переключение → S6 удаление.
Старый путь работает и остаётся путём по умолчанию до S5.

## 1. Факты

### 1.1 Сейчас два пути запуска

| | В редакторе | Страница игры |
|---|---|---|
| Код | `editor-core/src/services/play/GamePlaySessionService.ts` (1144), хосты `tab` и `popout` | `vite-plugin/player/index.ts` (222) |
| Realm | общий с редактором, клон сцены в `SceneRunner` | свой документ, как в `dist` |
| Источник сцены | память редактора, несохранённое включено | файлы на диске |
| Отладка | `ui/runtime/runtime-panel.ts` (948 + 396 css), LIVE-режим инспектора (`inspector-panel.ts:110-522`) | `player/debug/` — оверлей: профайлер, Pause, Step (`overlay.ts:119-120`), `__PIX3_PLAYER__.debug.snapshot()` |
| Агент | `host/debug-bridge.ts` (767), таблица `host/bridge-tools.ts`: `pix3_play`, `pix3_game_run`, `pix3_scene` live, `pix3_screenshot game` | `pix3 play` — headless, `--bot`, `--profile` |

Режимы `browser` и `debug` в редакторе уже есть: `PlayTarget = 'tab' | 'window' | 'browser' |
'debug'` (`state/AppState.ts:224`), `launchPlay` делает flush и `window.open(url, 'pix3-play' |
'pix3-debug')` (`features/scripts/PlayCommands.ts:103-127`). Редактор этой страницей не
управляет (спецификация §6.24 «Run Modes and Debug Mode»).

### 1.2 Что держится на запуске в редакторе

- **Тест-контур агента** `services/game-test/` — ~11 тыс. строк без спеков (`GameTestService`
  2865, `GameInputService` 2530, `game-assertions` 1530, `game-bots` 1153, monkey, watch,
  reachability). Связь с play-сессией узкая: `getActiveRuntime()` → `{runner, renderer, canvas,
  windowRef}`, `setPauseRequested`, `setFocusPauseSuppressed`, `restart`
  (`GameTestService.ts:632,807,813,1176,1187,1290`; `GameInputService.ts:861-1186`). Остальное —
  `@/state` (4 импорта), `fw/di`, `HostService`, `background-ticker`.
- Часть контура **уже работает на странице**: `page-bot-host.ts` (273) — `BotSession` для
  `pix3 play --bot`, собирается CLI в IIFE с шимом `@pix3/runtime` (`cli/src/play/bundle.ts:1-36`).
  Предикаты, negative control и `direct-action` туда не входят (`page-bot-host.ts:26-33`).
- **Политики ботов** редактор берёт из `virtual:pix3/bot-policies` через
  `HostService.host.scripts.current().botPolicies` (`GameBotHost.ts:9-13`).
- **Механика «не трогать редактор, пока идёт игра»**: `ExternalChangeService.ts:419-424,498-515`,
  `SyncApplyService.ts:52-58` (отказ `stale, playing`), `ProjectScriptLoaderService.ts:131-155`
  (`queueRoots`), `LiveComponentService.ts:89`, а также S11 (`policyOnly`) и S13 (корни, принятые
  во время игры, применяются на `restart`) из `.plans/done/scripts-vite.md`. Всё это существует
  потому, что игра исполняется в realm редактора.
- **Владение сессией**: `playOwner`, отказ `not_owner` (`bridge-tools.ts:101`),
  `AgentKeepaliveService.ts:37-80`.
- **Живая правка**: `UpdateObjectPropertyOperation.ts:207` → `getRuntimeLivePropertySink()`.
- **Ошибки рантайма** → Logs и баннер во вкладке Game с «Copy for agent»
  (`RuntimeErrorBridgeService.ts`, `game-tab.ts:240-307`).
- Состояние `isPlaying / playModeStatus / playOwner / isGamePopoutOpen / gameAspectRatio`
  читают ~40 файлов `editor-core/src`.
- Не затрагивается: превью анимаций и peek во вьюпорте.

### 1.3 Транспорт и перезагрузка

- Агент попадает в редактор через CDP: `window.__PIX3_DEBUG__.call(tool, params)` из
  chrome-devtools-mcp либо `pix3 bridge` (`cli/src/bridge/command.ts:78`, `cdp-page.ts`).
- Chrome, которым владеет `pix3 editor`, запущен с отключённым троттлингом фона
  (`cli/src/editor/chrome.ts:16-22`). `--disable-popup-blocking` в списке нет.
- Страница игры и редактор — один origin; между ними уже есть `BroadcastChannel`
  `pix3-editor-presence` (`player/dev/editor-link.ts:13`, `host/editor-presence.ts:9`).
- Dev-инструменты плеера подключаются через `virtual:pix3/dev` → `installDevTools(context)`
  ленивым `import()` (`vite-plugin/src/build/player-modules.ts:311-365`); в сборку не попадают.
- Барьер синхронизации (`vite-plugin/src/sync/barrier.ts`) считает ревизии (`rev`) и ждёт
  подтверждения **вкладки редактора**. Страница игры в нём не участвует: событий `pix3:fs` она
  не слушает, сцены и ассеты после правки сама не перечитывает. Перезагружает её только Vite —
  при изменении скрипта, **политики бота** (и модуля, который импортирует только она) и
  `pix3project.yaml`. Full-reload Vite рассылает всем страницам с `/@vite/client`, поэтому
  перезагружается любая открытая страница игры, даже не импортирующая модуль (S0.5).

## 2. Решения

- **D1. Один путь запуска.** `PlayTarget` исчезает. Play = flush + `/?debug[&scene=…]` в окне
  `pix3-play`. Оверлей по умолчанию свёрнут до чипа с FPS (состояние уже запоминается). Чистая
  страница без оверлея — это `/?clean` и `pix3 play`.
- **D2. Окно, не вкладка редактора.** Окно открывается **синхронно в обработчике клика** на
  `about:blank` и получает URL после flush: flush асинхронный, и при обычной блокировке попапов
  жест может истечь. Размер — из `viewport` проекта, ограниченный экраном. Aspect-кнопки уходят;
  точные размеры — `pix3 play --size`.
- **D3. Вся логика отладки и тестов — на странице.** Редактор и CLI — клиенты одного контракта
  `window.__PIX3_PLAYER__`:
  - `debug` — `snapshot()` (есть), `tree()`, `node(id)`, `highlight(id|null)`, `pause()`,
    `resume()`, `step()`;
  - `tools.call(name, params)` — тест-хост.
- **D4. Редактор не исполняет игру.** Из `AppState` уходят `isPlaying`, `playModeStatus`,
  `playOwner`, `playStartedAt`, `isGamePopoutOpen`, `gameAspectRatio`, `playTarget`. Вся механика
  из §1.2 «не трогать редактор, пока идёт игра» удаляется вместе с причинами `stale, playing`.
  Барьер для вкладки редактора (`stale_modules` и остальное) не меняется.
- **D5. Запуск = новая загрузка.** `start` и `restart` всегда навигируют страницу заново
  (`?run=` несёт seed и config, `player-modules.ts:345-351` уже читает). Перезапуска раннера
  внутри живого документа нет: не остаётся ни старых подписок, ни прежних autoload-ов, ни
  вопроса, применились ли новые скрипты.
- **D6. Барьер готовности страницы.** Страница при загрузке получает `loadId` (случайный, один
  на документ) и `rev` ревизии файлов, которые она загрузила (dev-сервер отдаёт его плееру).
  `pix3_play start` отвечает `ok` только после `hello {loadId, rev}` с `rev` не старше последнего
  `pix3_sync`. Каждый вызов инструмента несёт `loadId`; ответ другого документа отбрасывается,
  прогон, чья страница сменилась, завершается `page_reloaded`.
  Механизм (S0.4): `rev` = `ProjectFiles.currentSeq` в момент отдачи HTML страницы — хук
  `transformIndexHtml` плагина (только serve) вписывает его в страницу; это нижняя граница того,
  что страница прочтёт, и после `pix3_sync` она равна `rev` барьера. Ждать `hello` с `rev` не
  старше последнего `pix3_sync` должен и `pix3_game_run`, не только `start`: правка скрипта или
  политики сама перезагружает страницу агента (§1.3), и прогон уходит в новый `loadId`. Барьер
  сам инвалидирует `virtual:pix3/scene-manifest` при изменении `pix3project.yaml` и при
  появлении/удалении сцены — сейчас это делает только watcher (`hot-update.ts:26-31`,
  `index.ts:237-244`), и страница, загруженная сразу после sync, может получить старый манифест.
- **D7. У агента своя страница для управления, читать он может обе.**
  - Управление (`start`, `restart`, `stop`, `pix3_game_run`, ввод) идёт только в цель
    `pix3-agent-play`, звук выключен (`?mute`). На страницу человека такие вызовы отвечают
    `not_your_page`. `playOwner`, `not_owner` и `stale, playing: designer` исчезают.
  - Чтение (`pix3_scene` live, `debug.tree/node/snapshot`, `pix3_errors`, скриншот) принимает
    `page: "designer" | "agent"`; по умолчанию — `designer`, когда окно человека открыто, иначе
    `agent`. Так агент смотрит в состояние, в котором человек нашёл баг: воспроизвести его на
    своей странице он не может.
  - Кнопка **«Показать агенту»** в оверлее ставит игру на паузу и копирует фразу для агента:
    сцена, кадр, `loadId`, последние ошибки. Баннер ошибки с «Copy for agent» делает то же.
  - Страницей агента владеет вкладка редактора со статусом writer; она же её закрывает — по
    `stop` и по idle-таймауту, который не истекает, пока идёт прогон или `watch`.
  - Передача управления окном человека агенту («продолжи отсюда») — вне объёма, в `TODO.md`.
- **D8. Связь редактор↔страница — `BroadcastChannel` RPC.** Кадры: `hello/bye {role, loadId,
  rev}`, `call {id, loadId, tool, params}` → `result {id, loadId}`, `error`. Адресат — роль
  (`designer` | `agent`) плюс `loadId`. При смене `loadId` ожидающие вызовы отменяются.
  `start/restart/stop` одной роли выполняются по очереди. Прямая ссылка на `Window` не
  используется: теряется при перезагрузке редактора, у CDP-цели её нет.
- **D9. Открытие страницы агента.** В своём Chrome добавляем `--disable-popup-blocking`.
  `pix3 bridge` создаёт цель через `Target.createTarget` (как `chrome-owner.ts:246`). В чужом
  браузере `pix3_play start` отвечает `popup_blocked` с URL. В headless (S0.3) окно открывается
  и без флага, вторая цель видна в `/json/list` прокси; в оконном Chrome флаг не проверен.
- **D10. Код тест-хоста остаётся в `editor-core/src/services/game-test/`**, меняется точка
  входа: `page-bot-host.ts` вырастает в `page-test-host.ts`; `editor-core` публикует его готовым
  модулем, `virtual:pix3/dev` импортирует по пути файла (как оверлей). Политики на dev-странице
  хост берёт из того же `virtual:pix3/bot-policies`; для `dist` CLI компилирует политику, как
  сейчас. Редактору этот корень больше не нужен — S11 и S13 удаляются.
  Условия (S0.1, S0.6): отдельный вход `editor-core/dist/page-test-host.js` с теми же external,
  что у редактора (`@pix3/runtime`, `three`) — тогда Vite отдаёт ему prebundle страницы, и
  `instanceof` верен без шима; путь — `findPackageDir(root, '@pix3/editor-core')/dist/…`
  (каталог уже в `fs.allow`, `vite-config.ts:67-75`), без `editor-core` хоста нет. Граф входа не
  должен доходить до сервисов редактора: сегодня `GameTestService` тянет 116 модулей и 1,27 МБ
  (`GamePlaySessionService`, вьюпорт, `ProjectStorageService`, `yaml`), так что разрез через
  `GameRuntimeHandle` (S3) — обязательное условие, и `check-dist` его проверяет.
- **D11. Живая правка в этот план не входит.** Правка свойства при открытой игре = сохранение и
  Play. Пересылка `property(...)` покрывает один путь из нескольких (undo/redo, компоненты,
  `LiveComponentService`, текстуры) и без привязки к `loadId` пишет не в ту игру; отдельная
  задача в `TODO.md`. LIVE-чтение переезжает в детали объекта во вкладке Scene.

Отвергнуто: `<iframe>` страницы игры во вкладке Game. Сохраняет одну страницу для скриншотов и
`click_at`, но оставляет вкладку и aspect-обвязку в редакторе.

### 2.2 Инструменты моста после перехода

| Инструмент | Адресат | Что меняется | Новые / ушедшие отказы |
|---|---|---|---|
| `pix3_play` | редактор → страница агента | `start`/`restart` = flush + новая загрузка + барьер D6; ответ несёт `page {url, loadId, rev}`; `aspect` удалён; `run` (seed, config) живёт в `?run=` и повторяется `restart`; `pause`/`resume` → `debug.pause/resume` страницы, `status` — как `pix3_status.play`, `pausedBy` прогона сохраняется | + `no_game_page`, `popup_blocked`, `flush_failed`, `not_your_page`; − `not_owner` |
| `pix3_game_run` | страница агента | параметры те же; + `page_reloaded` | + `no_game_page`, `page_reloaded` |
| `pix3_scene` (игра открыта) | редактор + страница по `page` (D7) | `live`, `runtimeOnly` со страницы; `screen` — в CSS-пикселях **этой страницы**, рядом `page {role, loadId}`; без страницы — как вне play | — |
| `pix3_status` | редактор | `play` = `{pages: [{role, url, loadId, rev, paused}]}` вместо `playOwner` | — |
| `pix3_sync` | редактор | не откладывается из-за игры | − `stale, playing: agent\|designer` |
| `pix3_screenshot game` | страница по `page` (D7) | выводит её вперёд, отвечает `page`; сам снимок — `take_screenshot` по этой странице | + `no_game_page` |
| `pix3_errors` | редактор + страницы | записи помечены `source: editor \| designer \| agent` и `loadId` | — |
| `pix3 bridge screenshot\|tap\|swipe` | CLI | `screenshot --page designer\|agent`; `tap`/`swipe` — только страница агента; координаты и ввод — одна цель, один `loadId` | + `no_game_page`, `not_your_page` |

Отказы A3 `already_playing` и `not_playing` в таблице не учтены: при D5 `start` поверх живой
страницы — это новая загрузка, `already_playing` не нужен; `not_playing` совпадает с `no_game_page`.
Решается в S4, в `BRIDGE_REASONS` одна причина на случай. Сверка с прежними гарантиями (A1–A29, S7, S11–S13, §6.24) — таблица в §7, S0.

## 3. Этапы

После каждого этапа: clean & simplify по диффу, попытка ревью Codex, `npm run verify`.
Документация и кит правятся в том же этапе, что и код.

### S0. Спайк и сверка гарантий (2 дня; решение «идём / меняем D3, D6, D10»)

Проверки (Skyways и `core-tests`, плюс проект, поставленный из тарболов `release:check --keep`):

1. Тест-хост на dev-странице видит **тот же** экземпляр `@pix3/runtime`, что и игра. Если нет —
   шим по форме из `bundle.ts:31-36`, проверенный на полном хосте, не только на `BotSession`.
2. Скорость прогона с ботом в **перекрытом** и в headless-окне: фактические шаги симуляции и
   доставленные события против вкладки Game сейчас.
3. Открытие окна: клик человека с обычной блокировкой попапов и медленным flush (D2);
   `window.open` из `Runtime.evaluate` при `--disable-popup-blocking`; headless — вторая цель
   видна в `/json/list` прокси.
4. `rev` на странице: откуда плеер его берёт и совпадает ли он с `rev` барьера после `pix3_sync`
   для сцены, скрипта, autoload-а, текстуры и `pix3project.yaml`.
5. Что именно Vite перезагружает на странице игры сам (скрипт, политика, сцена, ассет).
6. Тарболы: dev-загрузка хоста и политик, инъекция на `dist`, обычная сборка без dev-хоста.

Сверка гарантий — таблица «сохраняется / меняется / с какого этапа» по спецификации §6.24,
`.plans/done/agent-bridge.md` (A1–A29: владение, `restart`, скриншот, причины отказов, порядок
`sync → start → run`) и `.plans/done/scripts-vite.md` (S7, S11–S13). Таблица дописывается в §2.2.

### S1. Контракт страницы: дерево и управление (2 дня)

- `player/debug/tree.ts`: обход живого `THREE.Scene` → DTO. Переносится `collectLiveTree`
  (`editor-core/src/core/agent-introspection.ts:220-330`) и сборка деталей объекта из
  `runtime-panel.ts`. В `editor-core` остаётся реэкспорт до S6.
- `DebugSession`: `tree()`, `node(id)`, `highlight(id|null)` (Box3 в живой сцене с учётом слоя).
- `loadId` и `rev` в `Pix3PlayerState` (D6): `transformIndexHtml` (serve, только страница игры —
  страница редактора raw) в `vite-plugin/src/index.ts` вписывает `rev`; `virtual:pix3/dev`
  (`devSource`, `player-modules.ts`) отдаёт его плееру, в сборке — `null`; `player/index.ts`
  ставит `loadId = crypto.randomUUID()` и `rev`. Спеки: `player-modules.spec.ts`, хук.
- `pix3 play --tree` печатает дерево в конце прогона (`--json`).
- Спеки: `tree.spec.ts`, `session.spec.ts`. Документы: `vite-plugin/README.md`, `cli/README.md`,
  `usage.ts`, `kit-src/skills/pix3-verify/SKILL.md`.

### S2. Runtime-дерево в оверлее (2 дня)

- Оверлей получает вкладки **Profiler** (как сейчас) и **Scene**: дерево с фильтром, чипы `×N`
  и `HIDDEN`, счётчик объектов, детали выбранного объекта, подсветка в игре. Только чтение.
- Обновление — по кнопке и при открытии вкладки. Непрерывный режим и виртуализацию списка
  добавляем, только если замер на Skyways (1500+ объектов, `fog-puffs ×1245`) покажет нужду.
- Проверка в браузере на Skyways: дерево, фильтр, подсветка 3D-объекта и 2D-узла, цена кадра
  с открытой вкладкой Scene.

### S3. Тест-хост на странице (5–7 дней, самый рискованный)

- `GameRuntimeHandle`: `runner, renderer, canvas, windowRef, setPauseRequested,
  setFocusPauseSuppressed`. `restart` в него не входит (D5: перезапуск — дело вызывающего).
  `GameTestService` и `GameInputService` зависят от него; `@/state` и DI заменяются параметрами.
- Контракт прогона: один активный прогон на страницу; `pagehide` и отмена отпускают клавиши и
  указатели, снимают паузу и подавление фокус-паузы; второй `game_run` при активном — отказ.
- Две реализации: редакторная (над `GamePlaySessionService`, живёт до S6) и страничная.
- `page-test-host.ts` = `page-bot-host.ts` + предикаты, watch, monkey, `direct-action`, negative
  control; `installPageTools(context)` → `__PIX3_PLAYER__.tools.call`. Подключается лениво: при
  `?debug` и при инъекции CLI. Вход собирается в `editor-core/dist/page-test-host.js` (D10);
  `check-dist` отказывает, если вход импортирует `lit`, `yaml` или сервисы редактора.
- **Фоновые тики** (S0.2): плеер крутит цикл на rAF (`player/index.ts:178-185`), скрытый документ
  rAF не получает, и прогон на свёрнутой или фоновой странице агента встанет. Сейчас редактор
  держит игру `BackgroundTicker` под keepalive (спецификация «Agent keepalive»). Страница агента
  и страница с активным прогоном или `watch` ставят планировщик кадров на воркер, пока документ
  скрыт (порт `background-ticker.ts` в `player/dev/`).
- Шим для IIFE поверх `dist` (S0.1) покрывает весь хост, а не только `NodeBase`: `isInteractive`
  (чистая), `getGameDebug` / `reportScriptError` (через `globalThis`, берётся настоящий
  `core/game-debug.ts`), `DEFAULT_FIXED_DELTA_SEC`, `collectRenderabilityIssues` (с `NodeBase` по
  форме). `three` в IIFE остаётся второй копией (только математика; уже сейчас каждый
  `pix3 play --bot` пишет «Multiple instances of Three.js»).
- `pix3 play --run '<json>'` принимает параметры `pix3_game_run`; `--bot` остаётся сокращением.
- **Паритет** проверяется без моста: сценарии `pix3-e2e/bridge-e2e` идут через редакторный хост
  и через `pix3 play --run` на dev и на `dist`. Сравниваются вердикты, порядок действий и итоговое
  состояние игры (время и идентификаторы нормализуются). Расхождение — блокер этапа.
- Одна и та же политика на dev-странице и в IIFE поверх `dist` — отдельный сценарий паритета.
- Спеки `services/game-test/*.spec.ts` переводятся на фейк `GameRuntimeHandle`.
- Документы: `cli/README.md`, `usage.ts` (`--run`), `pix3-verify/SKILL.md`,
  `kit-src/design/tests/bots/pix3-test-bot.d.ts`.

### S4. Связь и инструменты за флагом (4–5 дней)

Всё новое включается настройкой редактора `playHost: 'page'`; по умолчанию — старый путь, так
что вкладка Game и мост остаются согласованными.

- `PlayPageLink` (редактор) и `player/dev/editor-rpc.ts` (страница): протокол D8, барьер D6 — для
  `start`, `restart` и `pix3_game_run`; барьер sync инвалидирует манифест сцен (D6).
- `game.play` под флагом: flush (ошибка flush останавливает запуск), окно по D2, страница
  агента по D7 и D9. `game.stop` закрывает окно.
- Инструменты моста — по таблице §2.2, реализация выбирается флагом.
- `pix3 bridge`: выбор цели страницы агента через `listPages` (`cdp-page.ts`).
- Ошибки рантайма со страницы → Logs редактора; баннер и «Copy for agent» — в оверлей.
- Параметр `page` у читающих инструментов и отказ `not_your_page` у управляющих (D7); кнопка
  «Показать агенту» в оверлее.
- Кнопка «Показать в редакторе» во вкладке Scene (сообщение в канал, выделение по `nodeId`).
- `chrome.ts`: `--disable-popup-blocking`.
- Кит пишется под новый поток, но публикуется в S5: `pix3-editor/SKILL.md` (таблица
  инструментов, «игра — отдельная страница: `select_page` для `take_screenshot` и `click_at`»,
  таблица отказов, соответствия `pix3 bridge`), `kit-src/AGENTS.md`,
  `kit-includes/engine-api-map.md`.

### S5. Проверка и переключение (3 дня)

Сценарии, все с флагом `page`; провал любого оставляет старый путь по умолчанию:

- **Sync и reload.** Изменить сцену, скрипт, autoload и текстуру, сразу `sync → start → run`;
  ревизию подтвердить независимым признаком в игре. То же с ошибкой flush, с перезагрузкой во
  время ожидания готовности и во время действия бота.
- **Изоляция.** Две вкладки редактора, окно человека и страница агента; одновременно `restart`,
  `stop`, `watch`, ошибка скрипта, закрытие цели. Перезагрузка редактора при открытой игре —
  страница находится заново.
- **Баг в окне человека.** Человек играет, жмёт «Показать агенту»; агент читает узел, состояние
  компонентов, дерево и скриншот страницы `designer`, а `tap` и `restart` по ней получают
  `not_your_page`; игра человека при этом не сдвинулась ни на кадр.
- **Ввод и кадр.** `screen → tap/swipe → screenshot` при DPR 1 и 2, изменённом размере окна;
  попадание сверяется с состоянием игры. Освобождение ввода после отмены прогона.
- **Слепой прогон агента по киту** на `core-tests`: каждое место, где агент ошибся страницей, —
  правка кита.
- `pix3-e2e/bridge-e2e/run.mjs` и `debug-e2e/run.mjs` — на новый поток.
- Skyways: `pix3 play dist --profile --bot …` до и после — логика и счётчики не изменились.

После прохождения: флаг по умолчанию `page`, кит и `bridge-tools.ts` публикуются, спецификация
§6.24 переписывается. Это отдельный релиз `alpha.N`.

### S6. Удаление из редактора (3–4 дня, следующий релиз)

- `ui/viewport/game-tab.ts` (561), `ui/runtime/` (1344), записи в `core/LayoutManager.ts:39,66`,
  миграция сохранённых раскладок (вкладки `game` и `runtime` выбрасываются, остальное цело —
  проверить на сохранённой раскладке);
- `services/play/GamePlaySessionService.ts` и спеки, popout, `SetPlayTargetOperation`,
  `SetPlayModeOperation`, `SetPlayPausedOperation`, `Start*GameCommand`, `PauseGameCommand`,
  `RestartGameCommand`, `StopGameCommand`, `play-workspace.ts`, флаг `playHost`;
- поля `AppState` из D4 и их читатели: `ExternalChangeService` (ветка play),
  `SyncApplyService.ts:52-58`, `LiveComponentService.ts:89`,
  `ProjectScriptLoaderService.queueRoots`, `AgentKeepaliveService` (ветка play), LIVE-режим
  `inspector-panel.ts`, вызов sink в `UpdateObjectPropertyOperation.ts:207`, статус-бар, меню Run;
- редакторный корень `virtual:pix3/bot-policies`, `policyOnly` в барьере (S11) и очередь корней
  S13 в плагине и редакторе; `GameBotHost` остаётся только в страничном виде;
- редакторная реализация `GameRuntimeHandle`, реэкспорт `collectLiveTree`,
  `core/canvas-screenshot.ts`, если не осталось читателей.

`getRuntimeSceneRoot` / `registerRuntimeSceneRoot` (`runtime/src/core/game-debug.ts:118-140`)
остаются экспортом `@pix3/runtime`: их удаление — вопрос совместимости, не этого плана.

Остаётся в редакторе: кнопка Play, Run → Play / Play Scene / Stop, индикатор «игра открыта».

Проверка: `knip` и `knip:prod` пусты, `npm run verify`, ручной проход в `/__pix3/` на Skyways.
Документы: `docs/pix3-specification.md` (24 упоминания), `docs/nodes-and-systems.md`,
`docs/node-types-reference.md`, `CLAUDE.md` (роутер, Status), `packages/cli/README.md`,
`AGENTS.md:85`, кит-скиллы `pix3-nodes`, `pix3-scripts`, `pix3-scene-format`. План переезжает в
`.plans/done/`; живая правка, передача управления окном человека агенту и `getRuntimeSceneRoot`
— в `.plans/TODO.md`.

Итого 21–25 рабочих дней. Из редактора уходит ~4,5 тыс. строк и ~40 мест чтения play-состояния,
из плагина — механика S11/S13; на страницу добавляется ~1,5 тыс. (дерево, вкладка Scene, RPC).

## 4. Риски

| Риск | Что делаем |
|---|---|
| Вторая копия `@pix3/runtime` рядом с тест-хостом | S0.1; запасной путь — шим по форме |
| Прогон попал на старую или сменившуюся страницу | `loadId` и `rev` в каждом вызове (D6), сценарии «Sync и reload» в S5 |
| Вызов ушёл в чужую сессию (человек / агент / вторая вкладка редактора) | адресация ролью и `loadId` (D8), владелец — writer (D7), сценарии «Изоляция» |
| Тест-хост ведёт себя иначе на странице (время, фокус, ввод) | паритет в S3 без моста, S0.2, старый путь по умолчанию до S5 |
| Агент кликает координаты игры во вкладке редактора | `page` в ответах, `pix3 bridge` выбирает цель сам, слепой прогон в S5 |
| Попап заблокирован | окно открывается в клике до flush (D2); агенту — `popup_blocked` с URL |
| Игра читает файлы, а не память редактора | обязательный flush; `flush_failed` останавливает запуск |
| Правка при открытой игре больше не видна сразу | D11: сохранить и Play; живая правка — отдельная задача |
| Старые сохранённые раскладки | миграция в S6 |
| Две игры одновременно грузят машину | страница агента без звука, закрывается по `stop` и idle |
| Правка скрипта или политики агентом перезагружает окно человека (full-reload Vite — всем страницам) и стирает состояние, которое человек «показал агенту» | S0.5; решение владельца (§7, S0): принять или гасить reload для правок, которые страница не импортирует |
| Свёрнутая страница агента не тикает (rAF) | фоновые тики на воркере (S3) |

## 5. Решения владельца (2026-11-18, приняты)

1. Одна кнопка Play, оверлей свёрнут (D1).
2. У агента своя страница для управления; страницу человека он читает, но не трогает (D7).
   Замечание владельца: найдя баг, человек должен иметь возможность сразу показать агенту
   текущее состояние своей игры — отсюда параметр `page` и кнопка «Показать агенту».
3. Живая правка свойств при открытой игре в этот план не входит (D11).
4. Переключение и удаление — двумя релизами (S5, затем S6).

## 6. Журнал ревью

Ревизия 2, 2026-11-18, по ревью Codex (только текст плана) и собственной сверке с кодом:

- Удаление «отложенных изменений» заменено явным барьером готовности: `loadId` + `rev`, запуск
  всегда новой загрузкой (D5, D6). Уточнено по коду: страница игры сама перечитывает только
  скрипты (§1.3).
- Канал получил адресацию ролью и `loadId`, корреляцию вызовов, владельца-writer и правило
  закрытия страницы агента (D7, D8).
- Окно открывается в клике до flush (D2); проверка с включённой блокировкой попапов — в S0.
- `GameRuntimeHandle` получил контракт прогона (один активный, освобождение ввода, отмена);
  `restart` из него убран. Источник политик расписан (D10), найдено и добавлено удаление S11/S13.
- Живая правка вынесена из плана (D11): один `property` не паритет.
- Изменения протокола сведены в таблицу §2.2.
- Порядок: «Показать в редакторе» — из S2 в S4; паритет S3 — без моста; S4 за флагом;
  проверочные сценарии — до переключения (S5), удаление — после (S6).
- Сокращено: `--tree --find`, запоминание размера окна, непрерывный режим и виртуализация дерева
  (по замеру), удаление `getRuntimeSceneRoot`.
- Не принято: сузить `--run` — он и есть инструмент проверки паритета в S3.

Ревизия 3, 2026-11-18, по решениям владельца:

- Все четыре рекомендации §5 приняты.
- D7 разделён на управление (только страница агента) и чтение (обе страницы, параметр `page`):
  агент должен видеть состояние, в котором человек нашёл баг. Добавлены кнопка «Показать
  агенту», отказ `not_your_page`, сценарий проверки в S5.

Ревизия 4, 2026-11-18, по итогам S0 (§7):

- §1.3: Vite перезагружает страницу игры не только на скрипт — ещё на политику бота и
  `pix3project.yaml`, и всем страницам сразу.
- D6: механизм `rev` (HTML-хук, `currentSeq`); барьер готовности — и для `pix3_game_run`;
  барьер sync инвалидирует манифест сцен.
- D9: в headless проверено, в оконном Chrome — нет.
- D10: отдельный вход `dist/page-test-host.js` с external `@pix3/runtime`/`three`; граф без
  сервисов редактора — условие.
- S1: файлы для `loadId`/`rev`. S3: фоновые тики на воркере, полный список шима для `dist`,
  проверка входа в `check-dist`. S4: барьер D6 для `pix3_game_run`, инвалидация манифеста.
- §2.2: `run`, `pause/resume/status`, `pausedBy`; отказы `already_playing`/`not_playing`.
- §4: два риска — reload окна человека правкой агента, свёрнутая страница агента.

## 7. Ход работ

### S0 (2026-11-18)

Стенд: копия Skyways в `/tmp/claude-1001/play-in-page-s0/sky` (`@pix3/*` — ссылки на этот checkout,
`2.0.0-alpha.8`; `core-tests/game*` стоят на npm `alpha.2` и для проверки не годятся), Vite 8.3.8,
chrome-headless-shell 155 (`pix3-e2e/chrome.sh`, SwiftShader), `pix3 editor --headless
--chrome-only`, `pix3 bridge`. Код спайка — там же (`probe/`); в репозитории кода не менялось.

| Проверка | Результат | Следствие |
|---|---|---|
| 1. Тот же `@pix3/runtime` у хоста | Да. ESM-бандл хоста (esbuild, `@pix3/runtime`/`three` external), импортированный на `/?clean` по пути: `runner instanceof SceneRunner` — true, `instanceof NodeBase` — 244 из 244 узлов; рантайм один — `/node_modules/.vite/deps/@pix3_runtime.js`. Так же уже живут `editor-core/dist` и плеер (`vite-config.ts:94-97`). Но полный хост сегодня не собирается отдельно: `GameTestService` тянет 116 модулей, 1,27 МБ (`GamePlaySessionService`, вьюпорт, `ProjectStorageService`), на странице падает на `yaml`; без `GameTestService` (`page-bot-host` + bot-world + monkey) — 9 модулей, 55 КБ | D10 подтверждён с условиями (вход `dist/page-test-host.js`, разрез S3 обязателен). Для `dist` шим: `NodeBase` по форме, `isInteractive`, `getGameDebug`/`reportScriptError` (globalThis, `game-debug.ts:79-140,327-345`), `DEFAULT_FIXED_DELTA_SEC`, `collectRenderabilityIssues` (`renderability-lint.ts:220`) |
| 2. Скорость прогона | Headless, `core-loop`, seed 58, 600 тиков: страница (`pix3 play dev --bot`, 390×844@2) ≈ 6,9 тика/с (602 тика, ~83 с со стартом); вкладка Game (`pix3_game_run`, 9:16) — 6,5 тика/с (`wallMs` 92 573). В обоих 1 действие, 0 отказов. В headless страница не скрывается: после `Target.activateTarget` другой цели — `visible`, `hasFocus` true. Перекрытое/свёрнутое окно не проверено (нет оконного Chrome). По коду: плеер на rAF (`player/index.ts:178-185`), редактор под keepalive — на `BackgroundTicker` (`GamePlaySessionService.ts:104,591`) | Паритет скорости в headless есть. Скрытая страница агента в оконном Chrome встанет — S3 получает фоновые тики на воркере |
| 3a. Окно после async flush | В chrome-headless-shell блокировщика попапов нет: `window.open` открывает и через 6 с после клика, и без жеста. Активация клика (`navigator.userActivation.isActive`) жива через 3 с и погашена через 6 с (окно Chrome — 5 с). `about:blank` в клике + навигация через 6 с — работает (URL дочернего окна читается, один origin) | D2 без изменений; поведение блокировщика в оконном Chrome не проверено |
| 3b. `window.open` из `Runtime.evaluate` | Открывает в headless и без `--disable-popup-blocking`, и с ним; `Runtime.evaluate {userGesture: true}` тоже открывает | D9 без изменений; `userGesture` — запасной путь для `pix3 bridge` |
| 3c. Вторая цель в прокси | `pix3 editor --headless`: после `window.open('/?clean&agent=1', 'pix3-agent-play')` из вкладки редактора `/json/list` прокси показывает 2 страницы; повторный `window.open('', name)` возвращает то же окно; `close()` убирает цель | Подтверждено |
| 4. `rev` на странице | Сейчас его нет: `Pix3PlayerState` без `rev`, корни редактора несут `__pix3Revision` (`script-graph.ts:49-56`), но страница их не импортирует. `rev` барьера = `ProjectFiles.seq` (`barrier.ts:144,174`), и `GET /__pix3/api/hello` после `pix3_sync` отдаёт тот же `seq` для скрипта (15/15), политики (17/17), сцены (19/19), svg (21/21), нового png (23/23), `pix3project.yaml` (25/25); файл в `.pix3/` seq не двигает. Watcher поднимает `seq` сам через ~300 мс, поэтому `changed` у sync был пуст. Autoload отдельно не проверен (у Skyways `autoloads: []`): это скрипт + запись в `pix3project.yaml`, оба случая выше | Механизм D6 — `currentSeq` в HTML через `transformIndexHtml` (S1). Манифест сцен инвалидирует только watcher (`hot-update.ts:26-31`, `index.ts:237-244`; без редактора `hotUpdate` выходит сразу, `index.ts:397`) — барьер должен делать это сам (S4) |
| 5. Что перезагружает Vite | Метка в `window` после правки на диске, 3 с, без sync и с sync — одинаково: скрипт `scripts/Tutor.ts` — reload; политика `design/tests/bots/menu.ts` — **reload**; `pix3project.yaml` — reload; сцена, svg, новый png, png в `.pix3/` — нет. Политику страница не импортирует: full-reload Vite уходит всем клиентам | §1.3 исправлен. Правка агента перезагружает и окно человека — риск в §4, решение владельца ниже. `pix3_game_run` ждёт `hello` (D6) |
| 6. Тарболы | По `files`/`exports` и `npm pack --dry-run` (полный `release:check --keep` не запускался): `editor-core` публикует только `dist` → хост должен быть файлом `dist/`, импорт по пути обходит `exports` (как оверлей); каталог в `fs.allow`; `lit`/`yaml` — зависимости `editor-core`, разрешимы. Политики: `virtual:pix3/bot-policies` отдаётся плагином в serve. Сборка: `devSource('none')` не импортирует ничего (`player-modules.ts:325-335`); в `Skyways/dist/index.html` нет `startPageBot`, `BotSession`, `mountDebugOverlay`, `bot-policies`. CLI несёт `dist/play/prebuilt/page-bot-host.js` (262 КБ) — путь `dist` | Подтверждено рассуждением; в S3 — `release:check` с новым входом и проверка, что сборка его не несёт |

Попутно: первый прогон `pix3 play dev --bot` упал «the page reloaded during the run», в логе Vite —
`page reload .pix3/screenshots/…/0-start.png`; повторить не удалось (png в `.pix3/` reload не
вызвал), возможная причина — переоптимизация зависимостей после пробы. В долг S5.

**Сверка гарантий**

| Гарантия (источник) | Судьба | Этап | Примечание |
|---|---|---|---|
| Одна таблица инструментов, два транспорта; отказ всегда `{ok:false, reason, detail}` (A1, A3) | сохраняется | S4 | новые причины — §2.2; `already_playing`/`not_playing` — §2.2 |
| Порядок `sync → start → run` (A4, A5, барьер) | меняется | S1, S4 | `start` и `pix3_game_run` ждут `hello` с `rev` ≥ sync (D6) |
| `restart` = stop → применить отложенное → start (A4, S13) | меняется | S4, S6 | новая загрузка (D5); очередь корней S13 удаляется |
| `start` ждёт запуска рантайма ≤ 15 с (A19) | меняется | S4 | заменяется `hello` (D6) |
| Sync во время игры `stale`, `playing` (A5) | удаляется | S6 | под флагом — с S4 |
| Владение `playOwner`, `not_owner` (A3, `bridge-tools.ts:101`) | меняется | S4, S6 | роли страниц, `not_your_page` (D7) |
| `run` {seed, config} живёт до stop, повторяется на restart (`bridge-tools.ts:112-118`) | сохраняется | S4 | `?run=` (D5); **не было в §2.2** — добавлено |
| `pause`/`resume`/`status`, `pausedBy: pix3_game_run`, `pauseOnOutcome` | меняется | S3, S4 | `debug.pause/resume` страницы; **не было в §2.2** — добавлено |
| Скриншот: инструмент только готовит вид, снимок — `take_screenshot` (A2) | меняется | S4 | цель — страница по `page` |
| Keepalive: скрытая вкладка тикает от воркера (A6, спецификация «Agent keepalive») | меняется | S3 | **в плане не было** — фоновые тики страницы |
| Флаги Chrome против троттлинга (A6, `chrome.ts:16-22`) | сохраняется | S4 | + `--disable-popup-blocking` |
| Четыре режима Play, `game.play-entry`, F5/F6 (§6.24) | меняется | S5, S6 | один путь (D1); F5/F6 — Play / Play Scene |
| `?scene=`, ссылка «Pix3 editor», `?debug`, Pause/Step, `debug.snapshot()` (§6.24) | сохраняется | — | оверлей получает вкладку Scene (S2) |
| Всё dev-only, по пути файла, сборка не несёт (§6.24, P33/P34) | сохраняется | S3 | распространяется на тест-хост и политики (S0.6) |
| `pix3 play --profile`, `--bot` на `dist` через IIFE (§6.24) | сохраняется | S3 | шим расширяется (S0.1) |
| Контракт B: на странице редактора нет `/@vite/client` (`barrier.ts:30-34`) | сохраняется | — | страницы игры его имеют — отсюда reload всех (S0.5) |
| S7: живые компоненты следуют за скриптом; во время игры не меняются | меняется | S6 | первая часть остаётся, оговорка про игру уходит |
| S11 `policyOnly` | удаляется | S6 | политики исполняет страница (D10) |
| S12 исчезнувший тип паркуется | сохраняется | — | редактор |
| S13 корни, принятые во время игры, — на `restart` | удаляется | S6 | D5 |
| Ошибки рантайма → Logs, баннер с «Copy for agent» | меняется | S4 | со страницы, баннер в оверлее |

Не проверено: блокировщик попапов и жест в **оконном** Chrome (D2, D9); скорость и тики на
перекрытом / свёрнутом окне; `release:check --keep` целиком (S0.6 — по `files`/`exports`);
autoload отдельно от скрипта и `pix3project.yaml`; что страница после sync показывает новое
содержимое сцены (проверен только `rev`, `Cache-Control: no-cache` у сцен и ассетов).

Решение «идём / меняем»: **идём** по S1–S4 с правками ревизии 4. Нужно решение владельца: правка
скрипта или политики агентом (и любой sync с ними) перезагружает окно человека и стирает
состояние, которое тот «показал агенту» (D7). Варианты: принять (агент сначала читает, потом
правит) или в S4 гасить full-reload для правок, которых страница не импортирует (политики), —
скрипты игры перезагружать всё равно нужно.
