# 3D Asset Generator: журнал заданий модели и панель

**Решение владельца (2026-11-16).** Генератор 3D-моделей — это сам кодинг-агент (Claude Code,
Codex), как и в img2threejs: там модель тоже строит агент, а проект даёт порядок работы, проверки
и измерения. В Pix3 мы не переносим img2threejs целиком (Python, PBR, на выходе фабрика
`createModel(THREE)`) и не возвращаем LLM в редактор (A27, essential-restructure §B: LABS — только
как глагол CLI). Берём три вещи:

1. **Журнал задания** в CLI: `pix3 model …` и `pix3 render --job` — стадии, листы рендера,
   метрики, замечания человека. Всё в файлах, без dev-сервера и вкладки.
2. **Дисциплину стадий** в духе `forge/next.py`: стадию нельзя пропустить без явного `--force`
   с причиной, а замечание человека нельзя не заметить.
3. **Панель «3D Asset Generator»** (Window): процесс на экране и правки человека — комментарий
   к проходу, пометки на превью, вердикт «принято / нужны правки».

Измерения уже есть в `pix3 render --reference` (Skyways `v4-model-quality.md`, Stage B, в рабочем
дереве незакоммиченным; поля — `packages/runtime/src/nodes/3D/model-look.ts`) — здесь только
используются.

Вне объёма: кнопка Generate и автономный цикл в редакторе, `SculptSpec` и locked passes, 3D-превью
внутри панели (есть вьюпорт и «Open target»), нейросетевой image→3D, персонажи,
`pix3 model comment` из терминала (позже).

## Файлы задания

`.pix3/model-jobs/` (шаблон уже игнорирует `.pix3/*` в git; задания локальные).

```
.pix3/model-jobs/.lock                      ← межпроцессная блокировка CLI (open 'wx')
.pix3/model-jobs/index.json                 ← CLI; производный: пересобирается из job.json
.pix3/model-jobs/<id>/job.json              ← CLI
.pix3/model-jobs/<id>/reference.<ext>       ← копия референса (CLI)
.pix3/model-jobs/<id>/passes/<NN>-<stage>/sheet.png, report.json   ← CLI, неизменяемые
.pix3/model-jobs/<id>/feedback.jsonl        ← только панель (дописывание с If-Match)
.pix3/model-jobs/<id>/feedback/<fid>.png    ← панель: лист прохода с нарисованными пометками
```

**Запись CLI.** Каждая короткая операция read-modify-write (`job.json` + `index.json`) идёт под
одной блокировкой каталога `.lock` (`open(…, 'wx')`, повтор до 10 с; в файле pid и время;
блокировка старше 30 с с мёртвым pid снимается). Chrome рендерит вне блокировки. Порядок
публикации прохода: неизменяемые `sheet.png` + `report.json` → `job.json` → `index.json`
(tmp + rename каждый). `index.json` — производный каталог: при любом расхождении CLI пересобирает
его из `*/job.json`. Упавший рендер прохода не пишет.

**Запись панели.** `fid` создаётся один раз на отправку и переживает повторы. Порядок:
`feedback/<fid>.png` (`createOnly`; `exists` при повторе = успех) → строка в `feedback.jsonl`
(чтение с ETag, проверка, что `fid` ещё нет, запись с `If-Match` этого ETag, первая запись —
`createOnly`; при `base_mismatch` — перечитать и повторить). Потеря права записи: черновик
остаётся, повторы прекращаются.

```jsonc
// job.json, v1 (все поля проверяются при чтении на обеих сторонах; пути — только внутри задания)
{ "v": 1, "id": "tower", "title": "Tower", "status": "running|done|failed",
  "target": "res://scenes/prefabs/tower.pix3scene", "node": null,
  "reference": "reference.png", "referenceSha256": "…", "referenceBackground": null,
  "views": "iso,front,right,top", "size": 512,
  "stages": ["blockout", "structure", "form", "material", "bake"],   // уникальные slug
  "createdAt": "…", "updatedAt": "…", "result": null,               // done/failed: причина
  "wait": null,        // { "pid": 123, "since": "…", "expiresAt": "…" } — ждёт замечаний
  "feedback": { "f-…": { "deliveredAt": "…", "addressedBy": 4 } },   // см. ниже
  "passes": [ { "seq": 3, "stage": "form", "at": "…", "note": "заметка агента",
      "forced": null,                                                // причина обхода порядка
      "params": { "target": "res://…", "node": null, "views": "iso,front", "size": 512,
                  "referenceSha256": "…" },                          // фактические условия
      "sheet": { "file": "passes/03-form/sheet.png", "views": ["reference", "iso", "front"],
                 "tile": 512, "cols": 3 },                           // раскладка из model-sheet.ts
      "report": "passes/03-form/report.json",
      "metrics": { "luminanceP50": 0.33, "nearBlack": 0.02, "saturationMedian": 0.41,
                   "silhouetteIoU": 0.71, "saturationRatio": null, "triangles": 1840,
                   "drawCalls": 1, "notCompared": null } } ] }       // все поля необязательны
```

Имена метрик — те же, что в `model-look.ts` (`look.luminance.p50`, `look.nearBlack`,
`look.saturation.median`, `reference.comparison.silhouetteIoU`, `saturationRatio`), без
пересчёта; если маска или сравнение вернули `error`, это `notCompared: "<причина>"`, а не ноль.
Панель показывает изменение к предыдущему проходу только при одинаковых `params`.

```jsonc
// feedback.jsonl — одна строка на замечание, неизменяемая
{ "v": 1, "id": "f-<ms>-<rand>", "at": "…", "pass": 3, "text": "крыша слишком плоская",
  "verdict": "accept|changes|null",
  "marks": [ { "view": "front", "shape": "rect", "rect": [x, y, w, h] },   // 0..1 от листа
             { "view": "iso", "shape": "point", "point": [x, y] },
             { "view": "iso", "shape": "path", "path": [[x, y], …] } ],
  "image": "feedback/f-….png" }                                           // если есть marks
```

**Доставка и учёт замечаний** (агент не может доказать, что «прочитал»): `pix3 model feedback`
выдаёт недоставленные и пишет `deliveredAt`; следующий успешный `render --job` пишет
`addressedBy: <seq>` всем доставленным и ещё не учтённым. Панель показывает «доставлено агенту» /
«учтено в проходе N».

## Этап 1 — CLI, kit и одна правка плагина

Код: `packages/cli/src/model/` (новый: `types.ts` с валидатором, `store.ts` — блокировка и
запись, `command.ts`), правки `packages/cli/src/render/command.ts`, `src/index.ts`,
`src/usage.ts`; `packages/vite-plugin/src/files/project-files.ts`.

1. `pix3 model new <id> --target <scene|prefab> [--node <id>] [--reference <img>
   [--reference-background <hex>]] [--title …] [--stages a,b,c] [--views …] [--size N]` —
   id slug `[a-z0-9-]{1,64}`; занятый id — ошибка; цель нормализуется в `res://` и должна
   существовать; референс копируется, его sha256 записывается.
2. `pix3 render --job <id> --stage <name> [--note "…"] [--force "<причина>"]` — позиционный
   аргумент необязателен; сцена, узел, референс, фон, виды, размер — из задания (явные флаги
   побеждают и попадают в `params`); `--out` с `--job` — ошибка. **Переходы:** первый проход —
   первая стадия; дальше та же стадия (новая итерация) или следующая по порядку, если у текущей
   уже есть проход; иначе отказ с текстом, какой стадии не хватает; `--force "<причина>"`
   обходит и сохраняет причину в `passes[].forced`. Запись прохода — функция без Chrome (под
   specs). Вывод кончается строкой `N new feedback — pix3 model feedback <id>`, если есть
   недоставленное.
3. `pix3 model feedback <id> [--wait] [--timeout <s>] [--json]` — недоставленные замечания
   (проход, вердикт, текст, пометки словами «front: rect вверху справа», путь к картинке с
   пометками: «Read it»), отметка `deliveredAt` только выданным. `--wait`: пишет `wait`
   (свой pid, `expiresAt`), опрашивает `feedback.jsonl` раз в секунду; в `finally` и по SIGINT
   снимает только свой `wait`; таймаут (по умолчанию 540 с) — exit 0, «no feedback yet», в
   `--json` `timedOut: true`.
4. `pix3 model next <id>` — текущая стадия, разрешённые следующие, недоставленные замечания,
   последний вердикт. Подсказка.
5. `pix3 model done <id> [--failed <reason>] [--force]` — `done` отказывает, если есть
   недоставленные замечания или нет прохода последней стадии (кроме `--force`). Вердикт
   человека не обязателен: скилл говорит ждать его на ключевых стадиях, когда человек рядом.
   `pix3 model list [--json]`, `pix3 model rm <id>` (под блокировкой; отказ, если задание
   ждёт — `wait` жив).
6. **Плагин:** `performPut` не включает исключённые пути (`.pix3/…`) в `pix3:fs` и не
   копит их в `ownWrites` (сейчас событие уходит, всегда как `create`) + spec.
7. Kit: скилл `kit-src/skills/pix3-model/SKILL.md` (`name: pix3-model`, директива
   `CLI_VERSION`, лимит строк) — цикл и методика из img2threejs на `GeometryMesh` и запекании:
   классифицировать форму до выбора примитива (lathe / tube / extrude, не коробка), фаски там,
   где ловят свет и видны на игровом масштабе, цвета снимать с референса (палитра
   `--reference`), свет со стороны камеры, один дефект на итерацию с числом до/после, метрики —
   подсказки, решает картинка. Ссылки из `pix3-verify` и kit `AGENTS.md`. Новый каталог — в
   список «ships the files» в `kit.spec.ts`. Это место для Stage D плана Skyways v4.
8. `usage.ts`: один блок `pix3 model …` со всеми флагами; `--job`, `--stage`, `--note`,
   `--force` — в блоке `render` (так их находит `kit.spec.ts`).
9. Specs: аргументы; `new` (slug, res://, копия референса); запись прохода и переходы;
   `--force`; блокировка (две записи подряд из двух «процессов» не теряют изменений, мёртвая
   блокировка снимается); пересборка `index.json`; feedback: выдача/доставка/`addressedBy`,
   `--wait` с коротким таймаутом и снятием своего `wait`; `done` и `rm`; валидатор (битый JSON,
   путь `../`). `kit.spec.ts` зелёный, kit пересобран.
10. Docs: `packages/cli/README.md` → «`pix3 model`» и `--job` у «`pix3 render`»,
    `docs/pix3-specification.md` — раздел «Model jobs», строка в doc router `CLAUDE.md`.

## Этап 2 — панель

Код: `packages/editor-core/src/ui/model-jobs/` (`model-jobs-panel.ts` + `.ts.css`,
`sheet-annotator.ts`), сервис `src/services/assets/ModelJobsService.ts` (чтение, опрос, запись
замечаний), тип и валидатор формата — копия из CLI в `src/core/model-jobs-format.ts` (редактор
CLI не импортирует; общие fixtures — один и тот же пример `job.json`/`feedback.jsonl` в specs
обоих пакетов), команда `src/features/editor/OpenModelJobsPanelCommand.ts`
(`editor.open-model-jobs`, title «3D Asset Generator», `menuPath: 'window'`, `menuOrder: 311`),
регистрация в `LayoutManager.ts` по образцу `generate` (не в раскладке по умолчанию).

1. **Чтение.** Всё через `host.files.read/head` (`.pix3/` не раздаётся статикой и не попадает в
   `pix3:fs`); картинки — blob URL, освобождаются при смене. Опрос `head` по `index.json` и по
   `job.json` + `feedback.jsonl` выбранного задания раз в 1,5 с, только пока панель видна и
   вкладка не скрыта; один цикл без перекрытий, номер поколения выбора отбрасывает устаревшие
   ответы, backoff при ошибках, таймеры снимаются в `disconnectedCallback`. Удалённое задание и
   временное расхождение `index.json` с `job.json` — не ошибка.
2. **Показ.** Список заданий (статус; «ждёт вас», когда `wait` жив; «ожидание прервано», когда
   истекло). Задание: заголовок, цель, статус, «Open target»
   (`EditorTabService.openResourceTab` — проверить тип вкладки для `.prefab`). Лента проходов:
   миниатюра, стадия, метрики, изменение к предыдущему при равных `params`, «не сравнено:
   причина». Крупно лист прохода (референс — первый тайл) с A/B на предыдущий проход. Лента
   замечаний с «доставлено» / «учтено в проходе N».
3. **Правки.** Инструменты на листе: рамка, точка, от руки, отменить последнюю пометку; пометка
   получает `view` по раскладке листа. Поле текста. Кнопки Send, Accept, Needs changes. Отправка
   по правилам «Запись панели» выше. Во вкладке без права записи кнопки выключены заранее, с
   объяснением.
4. Исключение из «UI редактора не создаёт файлов»: явное действие человека, файлы в `.pix3/`
   (состояние инструмента, не ассеты, не в revision set). Записать в спецификации.
5. UI по `pix3-ui-conventions`: Lit на `ComponentBase`, Light DOM, `.ts.css`, иконки через
   `IconService`, цвета токенами, без эмодзи.
6. Specs (happy-dom, фейковый хост): список, проход, A/B, метрики «не сравнено», отправка с
   пометкой, конфликт If-Match с повтором без дубля, повтор после `exists` на PNG, вкладка без
   права записи, устаревший ответ опроса после смены задания. Команда в меню Window.
7. Docs: спецификация (раздел панели), README editor-core.

## Этап 3 — проверка вживую

Skyways: одно задание на один префаб через весь цикл, 2–3 прохода. В Chrome панель: пометка и
комментарий; проверить состоянием файлов, а не только снимком: замечание доставлено и учтено,
передача права записи другой вкладке, два параллельных CLI-вызова (`render --job` и
`feedback --wait`) не теряют изменений, `--wait` прерван — `wait` снят или истёк. Снимок панели.
Огрехи — `pix3 gap`.

## Позже

Рассылка `pix3:model-jobs` из плагина вместо опроса; GLB как артефакт прохода после bake;
сравнение двух заданий; `prune` по возрасту и сиротам PNG; `pix3 model comment` из терминала.

## Порядок и правила работы

- Этапы 1 и 2 — по одному Opus-агенту, последовательно (2 зависит от формата 1).
- После каждого этапа — clean & simplify диффа и одна попытка Codex-ревью (код вставлять в
  промпт: Codex здесь не читает файлы); если не вышло — строгое самоконтрольное ревью, сказать
  об этом прямо.
- В рабочем дереве pix3-core есть чужие незакоммиченные правки (v4 Stage A/B) и другие сессии:
  никаких `git stash/checkout/reset`, не откатывать чужое, точечные правки в общих файлах
  (`usage.ts`, `index.ts`, `render/command.ts`, `kit.spec.ts`, docs, kit).
- Без коммитов, пока владелец не попросит.
- Проверка: `npm run lint`, `npm run type-check`, `npx vitest run` по затронутым пакетам,
  `npm run knip`, сборка CLI (`prepack`-шаги), kit.

## Ревью плана (2026-11-16)

Codex и Fable. Принято: блокировка CLI и производный `index.json`; порядок публикации;
неизменяемые проходы; таблица переходов и `--force` с причиной; доставка ≠ учёт (`deliveredAt` /
`addressedBy` вместо «прочитано»); `wait` отдельно от статуса, снимается только своим
процессом; фактические `params` и сравнение только сопоставимых проходов; настоящие имена
метрик и «не сравнено»; геометрия листа и `view` у пометки; идемпотентная отправка панели;
опрос с поколением и backoff; валидаторы и общие fixtures; правка `performPut`; kit-drift
(`usage.ts`, `name`, `CLI_VERSION`, «ships the files»); `--out` с `--job` запрещён. Не принято
сейчас: отдельная команда `ack` (учёт ставит следующий проход сам), обязательный `accept`
человека на каждой стадии, общий пакет типов, `pix3 model comment` (в «Позже»).
