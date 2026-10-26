---
name: pix3-verify
description: How to check a Pix3 change — `pix3 check` / `pix3 validate` / `pix3 smoke` / `pix3 tree`, the diagnostic codes, what the editor does with a file you wrote (key-level merge, no merge-log), and how to report what was and was not verified. Running the game in the open editor is `pix3-editor`. Use after every batch of edits to .pix3scene or scripts/*.ts, and before telling the user a change is done.
---

<!-- Pix3 agent kit {{version}} -->
# Verify a change

Leave files that load and type-check, run the game when the editor is open (`pix3-editor`),
and tell the human exactly what to press and what they should see.

## 1. `pix3 check` after every batch

```bash
pix3 check            # validate (both levels) + tsc over the scripts + versions
pix3 check --json     # the same, machine-readable
pix3 validate [paths] [--json]   # scenes/prefabs only, no type-check
pix3 smoke scenes/main.pix3scene # then: run the game headless for 120 frames, report what threw
pix3 tree [scene]                # outline of a scene (or of the project) instead of reading it
```

If `pix3` is not on your PATH: `npx pix3 check` (the project's own `@pix3/cli`), or the pinned `npx -y @pix3/cli@{{version}} check`.

Exit code 1 = at least one **error**. Fix every error before reporting; warnings (off-screen
nodes, zero size, unused assets, out-of-range values) are for judgement.

`--json` answers `{ ok, errorCount, warningCount, files, diagnostics, notes, typecheck,
kit, … }`:

- `files` — every scene validated and every script type-checked, as
  `[{ "file": "scenes/main.pix3scene", "sha256": "…" }]` (the key is `file`, not `path`) — the
  **sha256 of its raw bytes**. These are the hashes `pix3_sync`'s `expect` takes.
- `diagnostics` — one list: `{ severity, code, file, line?, nodeId?, path?, message, fix? }`.
- `typecheck` — `{ ok, errors, tsconfig, mode, files, typescript, skipped }`; tsc errors are
  `E_TYPE` diagnostics in the list above; `skipped` says why tsc did not run at all.
- `kit` — `{ version, cliVersion, upToDate }`: `pix3 kit --update` when it is stale.

The first `check` on a machine may install TypeScript once into `~/.pix3/typescript/` (it
prints the `npm install` it runs; `--offline` refuses and prints the command instead).

**A project with its own `package.json` needs `npm install` before `pix3 check` can
type-check.** Such a project has its own `tsconfig.json` and type-checks against its own
`node_modules`; without them `check` reports one `E_DEPENDENCIES_MISSING` (fix: `npm install`)
and skips tsc — the scenes are still validated. Run `npm install` once, then `check` again.

Codes and what they usually mean:

| Code | Usual cause / fix |
| --- | --- |
| `E_YAML` | Bad indentation, unquoted `#colour`, a `:` inside an unquoted string |
| `E_UNKNOWN_NODE_TYPE` | Typo in the node type — use the suggested name |
| `E_UNKNOWN_COMPONENT` | `user:X` with no exported `class X extends Script` that has `static getPropertySchema()` in `scripts/`; or a `core:` name that does not exist |
| `E_UNKNOWN_PROPERTY` | Key not read for that node / component — check `pix3-nodes`; a flat `horizontalAlign` belongs in `layout:` |
| `E_PROPERTY_TYPE` | `"10"` for a number, a colour without quotes, an enum value not in the list |
| `E_MISSING_RESOURCE` | `res://` path typo, or the asset was never written (an `AnimatedSprite3D` `frames` entry too, `res://` or not) |
| `E_MISSING_PREFAB`, `E_PREFAB_*`, `E_DUPLICATE_ID` | Fix the `instance:` path; a prefab file needs exactly one root; ids are unique |
| `E_EMOJI_AS_ART` | A `label`/`text` that is only emoji — use a sprite or `ColorRect2D` |
| `E_SVG_INVALID`, `E_SVG_NO_SIZE`, `W_SVG_VIEWBOX_ONLY` | An `.svg` sprite without `xmlns` or without `width`/`height` in px — see the SVG template in `pix3-nodes` |
| `W_SVG_EXTERNAL_REF` | An `.svg` that links a file, URL or font — it will draw without it; inline it |
| `E_MISSING_FRAME`, `E_ANIM_JSON` | A `.pix3anim` names a frame (or a spritesheet) that does not exist, or is not a JSON object — fix the path or the file; its `.svg` frames get the `E_SVG_*` checks, reported on the `.pix3anim` |
| `E_LOCALE_*`, `W_LOCALE_*` | A locale table (`locales/<id>.json`) that is missing, not JSON, or has a non-string value (keys are flat: `"menu.play": "Play"`, never nested) — `E_` for the default or fallback locale (every `labelKey` would show its key), `W_` for another declared locale (its texts fall back) |
| `E_LOCALE_KEY`, `E_LOCALE_SCRIPT_KEY` | A `labelKey`, or a key a script passes as a literal to `tr('…')` / `setTextKey('…')` / `trPlural('…')`, that the default locale (and the fallback) has no text for — the game would show the key; add it to `strings` of the default table and the others (`trPlural` needs `<key>.other`, or `<key>`). A key the script computes is not checked |
| `E_LOCALE_SPRITE_KEY`, `W_LOCALE_SPRITE_KEY` | A `textureKey`, a `Button2D` `stateTextureKeys` entry or a `trSprite('…')` key with no `sprites` entry in the default (or fallback) table — `E_` for a `Sprite2D` with no `texture` of its own (it draws nothing), `W_` otherwise (its own texture shows in every locale; `trSprite` returns null) |
| `E_MISSING_LOCALE_SPRITE` | An image a table's `sprites` names does not exist — in any locale, since its keyed nodes draw nothing there; its `.svg` images get the `E_SVG_*` checks, reported on the table |
| `E_TYPE` | A TypeScript error in a script (`TS2339: Property … does not exist …`) |
| `E_TYPECHECK_UNAVAILABLE` | TypeScript could not be installed — run the printed command |
| `E_DEPENDENCIES_MISSING` | A project with its own `tsconfig.json` and no `node_modules` — `npm install`; tsc was skipped |
| `E_EDITOR_UNSYNCED` | The open editor could not write its unsaved scenes before the check (a drag in progress, a tab that does not answer) — `pix3_sync` from the bridge, or `--no-sync` to read the disk as it is |
| `E_RUNTIME_VERSION` | The project installs another `@pix3/runtime` than the one this `pix3` checks and runs scenes with — call the project's own CLI (`npx pix3 check`), or `npm install` the runtime at the CLI's version; `pix3 smoke` refuses to run with the same code |
| `W_PIX3_VERSION_MISMATCH` | Another installed `@pix3/*` package (`cli`, `vite-plugin`, `editor-core`) is not the CLI's version — `npm install` it at that version |
| `W_RUNTIME_NOT_INSTALLED` | A project with its own `tsconfig.json` type-checks against its own `node_modules/@pix3/runtime`, and there is none — `npm install` |
| `W_KIT_OUTDATED` | This kit is older than the CLI — `pix3 kit --update` |

`pix3 validate --help` and `pix3 check --help` list every code. Level 2 of validate compiles
and loads your scripts to check the properties of `user:` components; with `--no-hydrate` (or
when scripts cannot be loaded) those are **not** checked — say so if your change depends on them.

**A compile error hides level 2.** With `E_SCRIPT_COMPILE` in the list, every scene with `user:`
components is skipped at level 2 — `check` says `SKIPPED: N scene(s) …` and the summary line
reads `0 scene file(s) loaded …, N NOT loaded`. Their config/property errors are *missing*, not
passed: fix the compile error, run `check` again, and only then read the rest.

### `pix3 smoke` — when no editor is connected

`pix3 smoke <scene>` (after a green `check`) runs that scene in Node: your scripts compiled, the
scene loaded by the real loader, `--frames N` steps of 1/60 s (default 120). **Name the scene you
changed** — the game is `pix3 smoke scenes/main.pix3scene`. Input is empty, so a menu never
presses PLAY: smoking the menu (the build's entry scene) proves nothing about the game. The
game's own intents can be driven: `--command start-game@1 --command restart@300` dispatches
those `scene.commands` before frames 1 and 300, args as JSON after a space
(`--command 'swap@30 {"x":2,"y":3}'`; an unknown name is `W_SMOKE_COMMAND`) — the handler runs,
not the button. `W_SMOKE_UNTEXTURED` is a visible sprite whose texture never
loaded (a white quad on screen). With no
scene, smoke runs several, one line each and exit 1 if any fails: the top-level scenes your
uncommitted changes reach (git: the scene, a prefab or overlay it instances, a `user:` script it
attaches), else — no git, nothing changed, or a change it cannot trace — every top-level scene,
`scenes/main.pix3scene` first (`--changed` / `--all` force either; `--json` then answers
`{ ok, selection, reason, runs: [one report per scene] }`). Exit 1 lists every
`E_SMOKE_SCRIPT` (a hook threw: script, node, frame — 0 = `onAttach`/`onStart` — and a stack
pointing at your `.ts` line), `E_SMOKE_CONSOLE_ERROR`, `E_SMOKE_UNHANDLED` (a rejected promise
nobody awaited), `E_SMOKE_DOM` (a browser API the headless run lacks — `domAccess` names it; a
browser-only feature, not necessarily a bug: say so). `W_SMOKE_MISSING_RESOURCE` is a `res://`
typo. Exit 2 = it could not run (`E_SMOKE_NO_SCENE`: pass the scene; `E_SMOKE_TIMEOUT`: a loop
that never ends; `E_RUNTIME_VERSION`: run the project's own `npx pix3 smoke`). Nothing is
drawn, heard or tapped: a green smoke run proves the game starts and runs without throwing, not
that it plays — report it as exactly that, and tell the human what to press and what they should
see (section 4). With the editor open, `pix3_game_run` (section 3) is the stronger check.

**No editor open: the fallback, in this order** — `pix3 check` (green), then
`pix3 smoke <the scene you changed>` (green), then ask the human to press Play in that scene,
naming what to press and what they should see.

## 2. What the editor does with a file you wrote

The human edits the same files in the editor, which follows the disk: a scene you write is
reloaded in the editor within a second, with the editor's own unsaved edits merged key by key
(a key you changed wins; a key the designer changed and you did not stays theirs; a node you
deleted is gone). The designer is told when one of their unsaved values was replaced, and the
replaced version is kept in the editor's History — nothing is written back over your file and
there is no merge-log for you to read.

Your protection is the other direction: `pix3_sync` before you read and with `expect` after you
write (`pix3-editor` → "The loop").

## 3. Run the game in the editor

`.claude/skills/pix3-editor/SKILL.md` is the whole procedure: `pix3 check --json` for the hashes,
`pix3_sync` with `expect`, `pix3_play` restart, `pix3_game_run` with predicates, `pix3_errors`,
a screenshot; taps with chrome-devtools-mcp's `click_at` at the `screen` point `pix3_scene`
gives.

## 4. Report honestly

A file that passes `check` loads and compiles. It is not a game that works. End the turn
with:

- what you changed (files), and whether `pix3 check` was green;
- whether you ran it (the `pix3_sync` answer, the `pix3_game_run` verdict or what you clicked and
  read back) — or **what the human should do to see it**:
  "press Play in `scenes/main.pix3scene`, tap the gold stars — the combo label top-right should
  count x2, x3";
- what you could not verify (feel, audibility, small shakes, anything the bridge cannot see);
- placeholders you left — art (`ColorRect2D`, tinted PNGs, hand-written SVGs) and sound. A sound
  you made with `pix3 sfx` is a real `.wav`, not a placeholder in the file sense, but say it is a
  synthesised stand-in and that you could not listen to it.

If the human reports an error from the editor, ask for the exact text (the editor's console
or the load error shown on the scene), fix the first one, and check again.

## 5. When it does not work

**Small steps.** Never write a whole scene plus a long script before the first run: when a run
fails there should be exactly one new thing in it to suspect. Run (`pix3 check`, then the game)
after each step that can play.

Faults that compile clean and then misbehave — a component that threw and froze, an assigned
`position`, `getComponent` with a string, a wrong-way move, a button nobody connected — are
`pix3-scripts` → "Traps"; read `pix3_errors` (or `E_SMOKE_SCRIPT`) first.

**Stuck?** Two fixes that did not change the symptom mean the model of the bug is wrong: stop
editing, re-read the code that should explain it (not from memory), add a `console.log` where the
behaviour forks and read it back (`pix3_errors` lists console errors; `pix3 smoke --json` carries the
logs), and if it still does not add up, tell the human the exact error text, the file and line,
and what you tried.

## Known gaps

- `pix3_sync` confirms the open scenes and the executed scripts; a prefab or asset the game
  loads lazily during play is only read when play (re)starts.
- `.pix3/kit-manifest.json` (how `pix3 kit --update` knows which files are still the kit's) is
  committed (the starter's `.gitignore` re-includes it); in a project whose `.gitignore` drops
  all of `.pix3/`, a fresh clone counts every kit file as edited and skips it.
