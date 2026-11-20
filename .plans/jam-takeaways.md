# Наследие геймджема: база из catstd и Pixel Drop

**Источник (2026-11-20).** Обзор двух джем-проектов — `~/projects/catstd` (TS, Capacitor, ~46k строк)
и `~/projects/goldcrest/games/rh-game-pixeldrop-source` (JS, Canvas/Pixi, Capacitor, ~81k строк) —
на то, что каждая игра дописывала руками, а Pix3 мог бы дать из коробки. Отбор по правилам владельца:
никаких жанровых механик в движке и шаблонах, никаких сэмплов в pix3-core, инструменты проверки
игры агентом — в приоритете, игровой экран — пиктограммы.

Из игр берём идею и контракт; код пишется заново под Pix3. Ни один файл не копируется.

**Ревизия 2 (2026-11-20)** — после ревью Opus (по коду) и Codex (по тексту плана), оба
«Request changes». Что изменилось: единый канал `RunOverrides` вместо россыпи query-параметров;
A1 не останавливает агентские прогоны и режет `dt`; сейв с `storage.namespace` и загрузкой до
скриптов; реклама — отдельный модуль `platform` с явным контрактом показа; запись прогона пишет
только внешние воздействия по тикам и полный заголовок; `sweep` и `shots` слиты в сетку `pix3 play`;
F с правильными кодами и JSON; тир качества, `verify-docs`, `--with` — в TODO. Ответы на открытые
вопросы ревизии 1 — в «Решения ревью».

## Что уже есть и не трогаем

`scene.random` + `--seed` (только `SeededRandom`, на шаг времени не влияет), боты (`pix3 play --bot`,
`design/tests/bots`, `Pix3TestBot`; ядро `BotSession`/`BotWorld` в `game-bots.ts` от страницы не
зависит, к ней привязаны `DomInputSink`, `BackgroundTicker`, загрузчик политик), `pix3 smoke` (Node,
manual 1/60, без бота, свой `MemoryStorage` в `cli/src/smoke/dom-shim.ts`), `scene.juice`/`tween`/
`time`, `scene.haptics.vibrate`/`stop` (только `navigator.vibrate`), модуль `playable`
(`openStore`, `gameEnd`, `onGameEnd`, `getViewport`, `onResize`, `reset`, `setPlayableAdapter`,
MRAID/DAPI — плейбл-реклама), `trackSafeArea` (проба `env()`, только на `resize`), статический
`runtimeQuality`, `scene.commands`, `registerGameDebug` (`snapshot`/`actions`/`reset(seed)`),
`RunOverrides` + `setRunOverrides` (dev `?run=`, сборка `globalThis.__PIX3_RUN__`), `pix3 play
--shots` (снимки `bot.screenshot`), `diffJsonPaths` (`cli` `report-format.ts`), `pix3 sfx`, `pix3 font`,
`build: 'html'`, `E_LOCALE_*` и `W_LOCALE_MISSING` (нет файла локали; таблицы — JSON).

## Сквозные правила для каждого этапа

- **Один канал настроек прогона — `RunOverrides`.** Всё, что тест/агент/CLI задаёт странице до
  загрузки (режим хранилища и стартовый снимок, локаль, исходы рекламы, reduced motion, запись), —
  новые поля `RunOverrides`; флаги CLI пишут в него, поэтому то же работает на `pix3 play dist`.
  Новых query-параметров нет (кроме того, что уже даёт `?run=`).
- **Стрип.** Каждый новый ленивый геттер `SceneService` (`storage`, `analytics`) и модуль `platform`
  вносится в `vite-plugin/src/build/strippable-runtime-modules.ts` (keep-name геттера,
  `lazyValueImporters: ['core/SceneService']`); spec таблицы должен пройти, размер стартера в
  `report.json` не растёт. `AppLifecycle` нестрипаемый (его импортируют Audio и Input).
- **Headless и редактор безопасны:** всё новое — no-op или инертная заглушка, не бросает; есть
  опция в `HeadlessGameOptions`, где имеет смысл.
- **Код + доки + кит в одном изменении** каждого этапа: `docs/nodes-and-systems.md`,
  `docs/pix3-specification.md` (форматы), `packages/cli/README.md` + `usage.ts`, роутер `CLAUDE.md`,
  `kit-src` (рецепты, `pix3-test-bot.d.ts`, `.pix3/types`), пересборка кита, `kit.spec.ts`.
- После этапа: clean & simplify, ревью (Codex — одна попытка), lint / type-check / тесты / `knip`.

---

## Этап A. Платформенная база runtime

### A1. Жизненный цикл: `AppLifecycle` и `scene.app` (S–M)

- **Модуль `core/AppLifecycle.ts`**, два независимых поля: `visible` (`visibilitychange`,
  `pagehide`/`pageshow` вкл. возврат из bfcache, `freeze`/`resume`) и `focused` (`blur`/`focus`).
  На него переводятся `AudioService` (читает оба поля — как сейчас глушит и при потере фокуса
  видимой вкладки, `hasFocus`) и `InputService` (сброс нажатий на `blur` сохраняется). Дубли событий
  (`visibilitychange` + `pagehide`) схлопываются в один переход.
- **Скриптам** — только видимость: `scene.app.state: 'active' | 'background'`,
  `scene.app.onBackground(cb)`, `scene.app.onForeground(cb)` где `cb({ awayMs })`. Подписка живёт,
  пока жив владелец: отписка при detach скрипта или dispose автолоада (автолоады переживают
  `changeScene` и — главные подписчики: сейв, аналитика), плюс возвращаемая функция.
- **Агентские прогоны не останавливаются.** Пока хост подавил паузу по фокусу
  (`setFocusPauseSuppressed`, `page-test-host.ts` — фоновые тики через worker), `app.state`
  остаётся `active` и сигналы молчат. Тест на это.
- **Потолок `dt` в realtime (обязательно, с тестом в `SceneRunner.time.spec.ts`).** Сейчас
  `runOneTick(this.clock.getDelta())` (`SceneRunner.ts` ~1247) после фона отдаёт твинам, скриптам и
  ECS всё время отсутствия; ограничен только аккумулятор физики. Ввести общий потолок (0.1 с) и
  `dt = 0` на первом тике после возврата.
- **Причины паузы — множество флагов**, не состояние: `background`, `ad` (B1), пауза хоста/бота
  (`runner.pause` у `bot.screenshot`). Время и звук идут, только когда множество пусто — закрытие
  рекламы в скрытой вкладке ничего не запускает. Тот же приём, что `AudioService.setPaused`.
- **Кнопка «назад»:** `scene.app.pushBack(handler)` → `pop()`; обработчик возвращает `handled`.
  Защитная запись в `history` ставится лениво при первом `pushBack` и **никогда** в
  `build: 'html'`, в iframe и в редакторе, если игра не включила явно (`pix3project.yaml`
  `app.backButton: true`). Нативная оболочка зовёт `window.__pix3Back()` → `boolean handled`; пустой
  стек → `false`, оболочка решает сама.
- **Бот:** `bot.background(ms)` — уход в фон и возврат (catstd ловил залипший drag после фона).
- Тесты: дубли событий, bfcache, удерживаемый указатель при фоне, пустой стек «назад» — обычная
  навигация. Восстановление аудио на iOS — ручная проверка на устройстве, отметить в записи.

**Сделано (2026-11-21).** `core/AppLifecycle.ts` (синглтон страницы, DOM-слушатели только пока есть
подписчики; `blur` = фокус потерян независимо от `hasFocus()`), `core/AppApi.ts` = `scene.app`. Audio и
Input переведены на него; Input сбрасывает указатели на потерю фокуса и на уход в фон. Runner: множество
`RunnerPauseReason` (`host`/`background`/`ad`, `setPauseReason`, `getPauseReasons`; `paused` = только
`host`, как читают GameTestService/page-test-host), `MAX_REALTIME_DELTA_SEC = 0.1`, 0 с на первом тике
после возврата, снятие паузы изнутри тика не делает вложенный тик. Хост держит игру `active` через
`runner.setBackgroundHeld` (в `setBackgroundTicks`). Назад: `pushBack` → `pop`, `window.__pix3Back`,
history-guard по `runtimeBackButton` (`app.backButton` в манифесте плагина и редактора; без ключа — только
zip на верхнем уровне). `bot.background(ms)` — синхронный круг через `simulateBackground`.
Отклонения: **владелец — явный первый аргумент** (`onBackground(this, cb)`, `pushBack(this, h)`):
`SceneService` один на всех, угадать вызывающего нельзя; отписка идёт через индекс signal-target-links,
поэтому срабатывают все готовые страховки (detach, `removeComponent`, автолоады). `HeadlessGameOptions`
не тронут: в Node жизненный цикл инертен. Не проверено: восстановление аудио на iOS (устройство).
Для игр: пересобрать vite-plugin (плеер). Хук для B1: `runner.setPauseReason('ad', …)`.

### A2. Отступы от нативной оболочки (S, независим от A1)

`env(safe-area-inset-*)` в WKWebView под Capacitor отдавал 0 (catstd). В плеере:
`window.__pix3SetInsets(top, right, bottom, left)` (CSS px) — переопределяет пробу `env()` до
следующего вызова; пере-проба `env()` также на `orientationchange` и `visualViewport.resize`.
Обновить формулировку пункта safe area в `.plans/TODO.md` (устарела: `trackSafeArea` есть).

**Сделано (2026-11-21).** `window.__pix3SetInsets(t, r, b, l)` в `trackSafeArea` (вызов без чисел —
назад к пробе `env()`), пере-проба на `orientationchange` и `visualViewport.resize`; пункт TODO
переписан на проверку в настоящей Capacitor-оболочке. Тест плеера не добавлен: у `player/index.ts` нет
spec (он грузит `virtual:pix3/*`); остаётся ручной/e2e проверкой.

### A3. Сохранения: `scene.storage` (M)

- **Пространство:** новое поле `storage.namespace` в `pix3project.yaml`; `pix3 new` пишет его
  сразу (slug + короткий случайный суффикс); без поля — предупреждение `W_STORAGE_NAMESPACE` в
  `validate` и fallback на имя проекта. Ключ — `pix3:<namespace>:`; `clear()` трогает только его.
- **Загрузка до скриптов:** плеер читает снимок (через адаптер, может быть async) и прогоняет
  миграции **до** `onStart` первого скрипта и автолоадов; дальше API синхронный по кэшу в памяти.
  Миграции объявляются в манифесте/автолоаде заранее: `scene.storage.version` + регистрируемые
  `migrate(from, to, fn)` (точная форма — в задании этапа; требование — без гонки с первым `get`).
- **API:** `get<T>(key, fallback)` возвращает клон (`structuredClone`) — мутация без `set` не
  сохраняется молча; `set`, `remove`, `clear`, `flush(): Promise<{ ok, error? }>`, `export()` /
  `import(json)` (повреждённый импорт отвергается целиком), `persistent: boolean`.
- **Запись:** после изменения с короткой задержкой (~250 мс), записи сериализуются, ошибка
  оставляет неприменённые изменения в очереди; принудительный flush на `visibilitychange→hidden`
  (`pagehide` на iOS ненадёжен) и `onBackground`. Каждый доступ к `localStorage` в try/catch; без
  него — память и `persistent === false`.
- **Тестовый режим:** `RunOverrides.storage: 'memory' | { snapshot }` — бот, `pix3 play
  --storage <json|file>`, сетка D; не по `--seed`. Play из редактора — своё пространство
  (`<namespace>:editor`), сейв игрока не трогается. `HeadlessGameOptions.storage`; smoke использует
  тот же механизм, свой `MemoryStorage` в dom-shim убрать или свести к нему.
- **Адаптер:** `setStorageAdapter({ read(): Promise<string|null>, write(snapshot): Promise<void> })`
  — Capacitor Preferences / SDK портала.
- Тесты: холодный старт, квота, сбой миграции, изменение во время `flush`, повреждённый импорт.
- Вне объёма: облачное слияние — рецепт в ките по `pixeldrop/src/core/cloudMerge.js`.

**Сделано (2026-11-21).** `core/GameStorage.ts` = `scene.storage` (ленивый геттер, стрипаемый:
`keepWhenMentioned: ['storage', 'GameStorage']`; при стрипе сборка отдаёт `runtimeStorageNamespace = null`
и плеер ничего не читает). Снимок — один JSON `{version, data}` под `pix3:<namespace>:save`.
`SceneRunner.setStorage({ namespace, mode? })`; чтение ждётся в `runGraph` после шрифтов и локалей, до
`onAttach` автолоадов и любого `onStart`; повторный старт только пере-подписывает flush. Форма миграций:
`migrate(from, to, fn)` в `onAttach` автолоада, сейв мигрируется лениво при первом доступе (поэтому нет
гонки с первым `get`), `version` = максимальный `to`; поздняя регистрация — `console.error`. Сбой/дыра
миграции: сейв на диске не трогается, сессия из памяти (`persistent=false`); нечитаемый снимок —
пусто и перезапись. Запись: 250 мс, очередь из одной записи, ошибка оставляет `dirty`; flush на
переходе в фон и на `visible=false` (через `AppLifecycle`), на `runner.stop()`. Плеер: `:editor` — когда
страницу открыл редактор (`devPageLink()`). `pix3 new` пишет `storage.namespace` (слаг + 4 hex),
`W_STORAGE_NAMESPACE`, `pix3 play --storage memory|json|file`, `HeadlessGameOptions.storage` (по
умолчанию `memory`), smoke — `memory`; `run.storage` проверяется в мосту.
Отклонения: адаптер получает ключ — `read(key)`, `write(key, snapshot)` (иначе Capacitor Preferences не
знает, куда писать, и `:editor` не работал бы); `W_STORAGE_NAMESPACE` только если скрипт проекта говорит
`storage` (или значение невалидно) — иначе предупреждение у каждой старой игры без сейва; `MemoryStorage`
в dom-shim оставлен для скриптов, что ходят в `localStorage` сами — движок туда не ходит. Попутно:
редактор при перезаписи манифеста (бэкфилл `projectId`) терял `app` из A1 — теперь пишет и `app`, и
`storage`. Рецепт облачного слияния — одна строка в `pix3-scripts` (слияние в `read` адаптера), полный —
в H. Для игр: пересобрать vite-plugin (плеер изменён).

### A4. Хаптика: виды, троттлинг, адаптер (S)

Расширяем `scene.haptics` (`vibrate`/`stop` остаются): `play(kind)`, `kind ∈ 'selection' | 'light' |
'medium' | 'heavy' | 'success' | 'warning' | 'error'` с весом и паттерном для `navigator.vibrate`;
импульс гасится, если не менее тяжёлый был < 60 мс назад; `setEnabled`, `available`;
`setHapticsAdapter({ play, vibrate })` (Capacitor Haptics, SDK портала). Без адаптера на iOS молчит —
так и документируем. Карта «событие → вид» — игре.

**Сделано (2026-11-21).** `core/HapticsApi.ts` (класс вместо литерала в `SceneService`), экспорт
`HapticKind`, `HapticsAdapter`, `setHapticsAdapter`. Веса и паттерны — по catstd (без его `rumble`:
вне списка плана); `selection` без адаптера не играется (мотору слишком коротко, как в catstd).
Троттлинг по `performance.now()`, считается только сыгранный импульс. Адаптер — на всю страницу
(модульный), `setEnabled` — на экземпляр `scene.haptics` (`SceneService` один на страницу); выключение
делает `stop()`. Сверх плана: `isEnabled`. Не стрипаемый: модуль крошечный, `scene.haptics` и так
всегда был в плеере. Проверка на устройстве (Android-вибро, iOS через Capacitor) — ручная, в H.

### A5. «Меньше движения» (XS)

`scene.app.reducedMotion` (из `prefers-reduced-motion`, переопределяемо игрой и
`RunOverrides.reducedMotion`, CLI `pix3 play --reduced-motion`). `scene.juice.shake` ×0.25, `flash`
без вспышки на весь экран; `tween` не трогаем.

**Сделано (2026-11-21).** Состояние — в `AppLifecycle` (на страницу): `RunOverrides.reducedMotion` →
выбор игры (`scene.app.setReducedMotion(on | null)`, сбрасывается в `app.clear()` на конце сессии) →
`matchMedia('(prefers-reduced-motion: reduce)')` (читается при каждом обращении, без кэша; в Node —
false). Прогон сильнее игры: тест форсирует, даже если автолоад игры восстановил свой тумблер.
Отклонение: ×0.25 применяется не в `juice.shake`, а при проигрывании (`shakeMotionScale()` в
`ShakeBehavior` и `Camera2D`) — `shake` пишет амплитуду в config и следующий вызов без неё
уменьшал бы ещё раз; заодно гасятся авторские `core:Shake`. `flash` под reduced motion не делает
ничего. CLI: `pix3 play --reduced-motion` пишет в `__PIX3_RUN__` (dev и dist); `smoke` флаг не
получил — в Node нечего смотреть. Для игр: пересобрать vite-plugin (плеер не менялся, но рантайм
идёт через его prebundle).

---

## Этап B. Портал (M)

### B1. Модуль `platform`: реклама и уровни

`playable` — плейбл-реклама (MRAID/DAPI), внутри неё rewarded не бывает; не трогаем. Рядом —
модульный `platform` (`import { platform } from '@pix3/runtime'`), стрипаемый, со своим
`setPlatformAdapter`.

- **Показ:** `platform.showRewarded(placement, { onReward })` и `platform.showInterstitial(placement)`
  возвращают `Promise<{ id, outcome }>` с `outcome ∈ 'closed' | 'skipped' | 'unavailable'`.
  `onReward` вызывается **не более одного раза** за показ и может прийти до закрытия (раннее
  начисление); промис резолвится один раз — по закрытию. Каждый показ имеет `id`.
- **Движок, а не адаптер, держит контракт:** поздний reward после close — игнор + `console.warn`;
  нет close за таймаут (60 с) → `'unavailable'`; повторный вызов во время показа → `'unavailable'`;
  остановка сцены во время показа → `'unavailable'`, `onReward` уже не вызывается (мёртвый граф);
  отказ SDK → `'unavailable'`. На время показа — причина паузы `ad` (A1): время и звук стоят, снятие
  паузы и звука **до** резолва.
- **Адаптер** сообщает сигналы `started / rewarded / closed / failed` по `id`; движок сводит.
- **Без адаптера:** production — всегда `'unavailable'`; dev-страница — плашка-заглушка
  (пиктограмма ▶ и таймер); тесты — исход задаётся явно `RunOverrides.ads` (`'reward' | 'skip' |
  'unavailable'` или список по порядку показов).
- `platform.levelStart(id)` / `levelComplete(id, result)` — проброс адаптеру, без логики.
- Тесты: перестановки и дубли сигналов, отсутствие close, смена сцены во время показа, скрытая
  вкладка при закрытии. Адаптеры конкретных порталов (MY.GAMES JAM, RH, CrazyGames) — вне pix3-core;
  в ките рецепт «адаптер за 30 строк».

### B2. Фасад аналитики: `scene.analytics` (S)

`track(name, props?)`, `setUserProps`, `addSink(sink)`; буфер до первого sink — ограниченный (500
событий, старые выбрасываются со счётчиком); упавший sink логируется и не роняет игру; сброс на
`onBackground`. Необязательный `defineEvents([...])` — неизвестное имя → `console.warn` в dev.
`pix3 play --json` и smoke отдают события прогона. Вендорские sinks — вне ядра.

---

## Этап C. Запись и повтор прогона (M)

Цель — воспроизводимый баг-репорт. **Гарантия побитового повтора — Node (`HeadlessGame`, manual
1/60, детерминированный `flushPending`). Chrome — best-effort:** повтор Chrome → Chrome
поддерживается, тик расхождения после асинхронной загрузки помечается как «вероятно, загрузка».

- **Что пишем — только внешние воздействия**, по логическому тику (кадр `InputService.beginFrame`),
  с фазой и порядковым номером внутри тика: события указателя (`pointerId`, down/move/up/cancel,
  координаты — доля канваса, как `toCanvasFraction` у бота), клавиши/действия, команды, вызванные
  **извне** (бот direct-action, мост), события среды (фон с `awayMs`, resize, исход показа рекламы).
  Команды, порождённые самой игрой, не пишутся как вход (иначе повтор выполнит их дважды) — они
  сверяются как результат.
- **Заголовок:** версия формата, хеш сборки/ресурсов, полный `RunOverrides` (config, стартовый
  снимок storage, локаль, исходы рекламы), режим времени и `fixedDeltaSec`; для realtime-записи
  (живой игрок) — `dt` каждого тика (повтор идёт в manual с этими `dt`); вьюпорт и DPR.
- **Контрольные точки:** по умолчанию каждые 30 тиков — канонический снимок `gameState()` + дерева
  (позиции/видимость, стабильный порядок по id). Повтор называет **интервал** «между тиком 390 и
  420», путь в снимке (`diffJsonPaths`) и сохраняет оба снимка; `--every 1` — точный тик ценой
  размера.
- **CLI:** `pix3 play --record <file.pix3replay>` (запись через `RunOverrides.record`, файл
  забирает CLI), `pix3 smoke --replay <file>` (Node, гарантия), `pix3 play --replay <file>` (Chrome,
  скриншот на точке расхождения). Формат — JSON Lines, раздел спецификации «Replay files».
- **Первые тесты:** один тап → ровно одна команда при записи и повторе; намеренная ошибка между
  контрольными точками; временное расхождение, исчезающее к следующей точке; рукописные «плохие»
  записи, которые повтор обязан отвергнуть.
- Зависимости: A3 (снимок storage), B1 (исходы рекламы), A1 (события фона).

## Этап D. Сетка прогонов и эталоны в `pix3 play` (M–L)

Новых команд нет: `sweep` и галерея экранов (G) — это сетка свежих загрузок внутри `pix3 play`.

### D1. `--golden` (S, первым)

`pix3 play --bot <n> --seed N --golden <file.json> [--write]` и `pix3 smoke --golden`: итоговый
`gameState()` (и события B2) против эталона через `diffJsonPaths`; exit 1 с диффом. Допуск только для
явно перечисленных числовых путей (`--tolerance 'score.avg=0.01'`), остальное — точное равенство;
массивы сравниваются по стабильному id, если он есть. Совместить с предикатами `gameState`
у `pix3_game_run` (`bridge-tools.ts`) — один язык путей.

### D2. Сетка

Списочные значения флагов `pix3 play`: `--seed 1..50`, `--config` (несколько или файл),
`--bot-args`, `--size 390x844@3,…`, `--locale ru,en`, `--storage`, плюс `--parallel N`. Каждая
комбинация — отдельный браузерный контекст и свежая загрузка; ошибка каждой комбинации
сохраняется отдельно. Вывод: таблица по каждой комбинации **и** агрегат (min/median/max/p90 по
числовым полям, доли исходов по строковым), `--json`. `--check-determinism` — каждая комбинация
дважды.

- **Бот-хост в Node:** вынести хост из `editor-core` в модуль, общий для страницы и
  `HeadlessGame` (`BotWorld` уже переносим); в Node — канал `direct-action`, сетка по нему идёт
  через `pix3 smoke` с теми же флагами (быстро). Chrome остаётся для `physical-input` и картинок.
  Вынесенный модуль обязан проходить `check-dist`.
- Кит (`pix3-verify`): рецепт «баланс по сетке» — числа из сетки помечаются `[modelled]`, из живой
  игры — `[measured]`.

### D3. Бот: щипок

`bot.pinch(center, scale, frames)` (`bot.background` — в A1).

## Этап G. Галерея экранов (S, поверх D2)

Не отдельная команда. Файл `design/tests/screens.ts` (кладёт кит, рядом с `design/tests/bots`):
список `{ name, overrides: RunOverrides, scene?, policy? }`, каждое состояние ставится напрямую
(config, storage, команды), политика при необходимости делает `bot.screenshot`. `pix3 play
--screens [--only name] --locale all --size …` → по картинке на состояние × локаль × размер,
сводный лист (как у `pix3 render`) и `screens.json`. Кит: рецепт «посмотреть экраны после изменения
UI», правило пиктограмм. Шаблоны не меняются.

## Этап F. Паритет локалей (S)

В `cli/src/validate/resource-files.ts`, таблицы — JSON: `W_LOCALE_KEY_MISSING` (ключ default-локали
отсутствует в другой), `W_LOCALE_PLURAL_OTHER` (plural без `other`), `W_LOCALE_UNTRANSLATED`
(значение совпадает с default и длиннее 3 символов, или в нём буквы Unicode-письма default-локали,
которого нет у целевой). Белый список — служебный ключ в JSON-таблице; согласовать с
`E/W_LOCALE_JSON`, чтобы он не считался ошибкой. Литералы мимо `tr()` не ловим. Эвристику
`UNTRANSLATED` проверить на локалях обоих джем-проектов до включения.

**Сделано (2026-11-21).** `checkLocaleParity` (`cli/src/validate/resource-files.ts`, только
whole-project, как остальные проверки таблиц). Белый список — `"$meta": { "sameAsDefault": [...] }`:
`$meta` и так служебный, не-список ключей → `W_LOCALE_JSON`; редактор теперь сохраняет все ключи
`$meta`, которые не правит (раньше терял всё, кроме `locale`/`name`/`direction`). Множественное
число сравнивается по формам, которые `Intl.PluralRules` целевой локали даёт на 0–1000 (`ru` —
`few`/`many`, `ja` — только `other`, `many` у `es`/`fr`/`it`/`pt` только для миллионов — не требуется);
`PLURAL_OTHER` молчит, если есть голый `<key>` (его `trPlural` берёт следующим).
**Проверка эвристики (только чтение):** в catstd таблиц локалей нет (литералы в коде); Pixel Drop —
8 JS-словарей, сплющены в JSON во временном проекте. Исходник `ru` → 0 `KEY_MISSING`, 4
`PLURAL_OTHER` (настоящие: в `ru` нет `.other`), 21 `UNTRANSLATED` = 3 ключа бренда «PIXEL PASS» × 7
локалей (белый список). С `en` за default: «то же значение > 3 символов», как в плане, давало
35–76 срабатываний на латинскую локаль, почти все — одно слово, одинаковое в обоих языках (Taxi,
Radio, Hammer, Tornado). **Отклонение:** копия считается, только если в ней ≥ 2 слов (и > 3 букв без
`{param}`; та же локаль-язык — `en-GB` против `en` — не сравнивается); осталось 2–6 на локаль:
бренд, «CLOUD: OFFLINE», «Wild West» (настоящие) и «Floppy Disk» в `it` (заимствование). Правило
письменности: срабатывает, только если в тексте нет ни одной буквы своего письма («Pixel Pass
сезона завершён» в `ru` — нет срабатывания); ложных — 0. 574 `KEY_MISSING` в `ru` при `en`-default —
соглашение Pixel Drop (имена контента — ключи на русском, в `ru` их нет), не ошибка эвристики.

## Этап E. Арт-конвейер (M)

### E1. `pix3 slice`

`pix3 slice <sheet.png> --grid CxR | --blobs [--key auto|#rrggbb] [--out dir] [--anim <slug>]`:
сетка или связные компоненты по альфе/ключу фона, порядок чтения строками, слияние осколков,
удаление ореола; `--anim` — `.pix3anim` (или вход для `character-compile`). PNG — свой модуль
`cli/src/image/png.ts` на `node:zlib` (8-bit RGBA/RGB/палитра; interlace — понятная ошибка), без
новых зависимостей. Набор проверочных листов: несколько реальных листов Codex (Skyways, джем-игры)
как фикстуры тестов cli.

### E2. Пиксельные предупреждения в `validate` (после E1, на тех же фикстурах)

`W_SPRITE_NO_ALPHA`, `W_FRAME_CLIPPED`, `W_FRAME_BLEED`; кэш по mtime+size в `.pix3/cache/`;
`--no-pixels`. Включать только когда эвристики проходят набор фикстур без ложных срабатываний.

## Этап H. Кит (S, по ходу)

Рецепт `pix3-mobile` (по `catstd/.claude/skills/mobile-webview`): A1, A2, A4, «мёртвый»
AudioContext на iOS, чеклист Capacitor-оболочки (`__pix3SetInsets`, `__pix3Back`, адаптеры A3/A4,
`platform`), бюджеты памяти текстур. Каждый этап обновляет кит сам; H — итоговая сверка.

---

## Порядок и зависимости

1. Параллельно: **A1** (с потолком `dt`), **A2**, **F** (cli, другой пакет).
2. **A3** → **A4**, **A5**.
3. **B1** (нужна пауза `ad` из A1), **B2**.
4. **D1** (golden — не зависит от B2; события подключаются, когда B2 есть).
5. **C** (нужны A1, A3, B1) — сначала Node.
6. **D2** (+ вынос бот-хоста), **D3**, затем **G**.
7. **E1** → **E2**.
8. **H** — итоговая сверка кита.

## В TODO (не в этом плане)

- Тир качества `scene.quality`: нет телеметрии слабых устройств, проба первых кадров шумит
  (прогрев шейдеров), `maxPixelRatio` задаётся при создании рендерера. Пока достаточно
  переопределения `runtimeQuality` через `RunOverrides`.
- Дисциплина документации игры (`verify-docs`, `codemap-audit`) и `pix3 kit --with …` — по запросу
  владельца.
- Запись промо-видео (`pix3 play --record` как видео), серверные часы.

## Вне объёма

Механики, солверы и контент джем-игр; вендорские SDK (Nakama, Amplitude, RH legal); сборка под
сторы (codemagic, `ios/`, `android/`); uikit-lab; автопилоты (это бот-политики).

## Решения ревью (ревизия 1 → 2)

1. Фиксированный шаг: `--seed` трогает только `SeededRandom`. Фиксированный шаг есть в smoke /
   `HeadlessGame` (manual 1/60), `pix3 play --bot` (fixed 1/60, 4 тика на кадр), `pix3_game_run`
   (manual); живой игрок и `play` без бота — realtime. → C пишет режим времени и `dt` тиков.
2. Бот в Node: ядро переносимо → D2 выносит хост, Node с `direct-action`, Chrome для
   физического ввода и картинок.
3. Имя: `playable` не трогаем, новый модуль `platform`.
4. Тир качества → TODO.
5. G и H → кит; стартеры остаются пустыми; `verify-docs` → TODO.
