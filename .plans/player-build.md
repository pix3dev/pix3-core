# Player and build in the plugin (P1)

Date: 2026-10-09. Derived from `../pix3/.plans/pix3-core.md` §B.0 (hooks), §B.5 (player), §B.6
(build) and the P1 row «Минимальный build» of §G.2. Those stay authoritative; where this file
disagrees it says so (AGENTS.md rule 13). The 1.x sources ported: `runtime/src/main.ts` +
`register-project-scripts.ts` (player), `ProjectBuildService.collectAssetPaths` /
`scanMentionedNames` (scan), `strippable-runtime-modules.ts` + `buildStrippedModuleSource`
(strip), `PlayableHtmlBuildService.renderHtmlDocument` (page), DeepCore's
`classicScriptCompatibilityPlugin` (classic script).

`VP` = `packages/vite-plugin`, `RT` = `packages/runtime/src`, `CLI` = `packages/cli/src`.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| P1 | **The player is a second TypeScript root, `VP/player/`** (`@pix3/vite-plugin/player` → `dist/player/index.js`), not a file under `VP/src/`. `player/tsconfig.json` type-checks it against `RT` (bundler resolution, `paths`); `player/tsconfig.build.json` emits it alone with `noCheck` + `isolatedDeclarations`. | `VP/src` is Node ESM (`nodenext`): importing the runtime's extensionless sources from it does not type-check, and `rootDir` refuses an emit that drags `RT` into the program. |
| P2 | The plugin resolves `@pix3/vite-plugin/player` itself (`resolveId` → the file in this package, `.ts` under vitest, `dist/player/index.js` otherwise). | A workspace link, pnpm, or a project without the package in its own `node_modules` all reach the same file; `fs.allow` already covers the package. |
| P3 | Player modules are `virtual:pix3/{scene-manifest,embedded-assets,project-scripts,spine,postprocessing,network}` (`VP/src/build/player-modules.ts`), the 1.x `virtual:runtime-*` names dropped. Dev: manifest read from `pix3project.yaml` on each load (invalidated on its change), `embeddedAssets = {}`, `ResourceManager('/<resRoot>/')`, spine through the existing lazy `virtual:pix3/spine-loader`, `postprocessing` through the runtime's own `import()`, the real `NetworkService`. Build: all from the scan, `ResourceManager('./')`. | §B.5. One namespace for everything the plugin generates; dev needs no scan. |
| P4 | `window.__PIX3_PLAYER__ = {status, frames, errors, scene, runner}`; `frames` counts the runner's loop by wrapping `setFrameScheduler` around `requestAnimationFrame`. Window `error`/`unhandledrejection` land in `errors`. | §B.5; the artifact check reads it. |
| P5 | **Scan = every text source** outside `node_modules`, `dist`, `build`, `.pix3`, … (`VP/src/build/scan.ts`, `listProjectFiles`): scenes, prefabs, `.pix3anim`, every `.ts/.js` (not `.spec/.test/.d.ts`), `.json` (not `package-lock.json`), `.yaml`, `.html`, `.css`, `.atlas`. `res://` references, directory expansion, interpolated prefixes, atlas pages, declared (or discovered) locale tables and their sprites, manifest fonts, the packed atlas — as 1.x, minus `export.{prune,include,exclude}Globs` (P2). Assets are `res://`-relative under `resRoot`. | §B.6 item 1 («все текстовые исходники … и `src/**`»). |
| P6 | Strip table ported verbatim plus one row: `nodes/2D/ColorRect2D` gained a lazy value importer, `nodes/2D/UI/UIControl2D` (`instanceof ColorRect2D` in `findPointerTarget` — false against the stub, which is right when no scene places one). The import-graph spec (`strippable-runtime-modules.spec.ts`) found it; it guards the table against `RT` from the plugin now. | CLAUDE.md «Playable export size»: the spec is the point. |
| P7 | Strip is a `load`-hook replacement of `<runtime src>/<modulePath>.ts` by `buildStrippedModuleSource` of the real source; the runtime's `src/` is `dirname(realpath(resolve('@pix3/runtime')))`. On by default; off when a project dependency declares `@pix3/runtime` in `dependencies`/`peerDependencies` (`strip-decision.ts`, own `@pix3/*` excluded), `strip: false` off, `strip: true` forced. Applies to html and zip alike. | §B.6 item 2, the P1 rule. Importer protection beyond the table's `importers`/`lazyValueImporters` fixpoint and N11 is P2. |
| P8 | **`postprocessing` is stubbed by a separate `enforce: 'pre'` plugin** (`pix3:postprocessing-stub`) in an html build whose scan sees no `PostProcess` and whose strip is on. | Vite's own `vite:resolve` runs before a normal plugin's `resolveId`, so the core plugin never saw the bare specifier; the real library (320 KiB) was inlined by rolldown. Measured, then fixed. |
| P9 | html = `vite-plugin-singlefile` 2.3.3 with `useRecommendedBuildConfig: false`; the core `config` hook sets the equivalent itself and picks `codeSplitting: false` (rolldown) or `inlineDynamicImports: true` (rollup) by `this.meta.rolldownVersion`, plus `base: './'`, `assetsInlineLimit`, `cssCodeSplit: false`, `assetsDir: ''`, `modulePreload: false`. Then `pix3:classic-script` (post) rewrites the html chunk: no `type="module"`/`crossorigin`, the script at the end of `<body>`, `import.meta.url` → `document.baseURI`, **`import.meta.resolve` → `undefined`**, any other `import.meta` → `({})`. | §B.0 (`rolldownVersion`), §B.6 item 5. Vite 8's preload helper probes `import.meta.resolve`, which a classic script cannot even parse — DeepCore's port only knew `import.meta.url`. |
| P10 | zip = the plain Vite build (code-split, module script) + the assets emitted beside `index.html` under their `res://` paths (`emitFile` in `generateBundle`) → `dist/<projectName>.zip` by `fflate` in `closeBundle`. No classic rewrite. | §B.6 «zip — без встраивания». |
| P11 | `.pix3/build.json` (`VP/src/build/record.ts`: format, path, bytes, sha256, entry, assets, stripped, warnings) is written by the build at `closeBundle` and is the answer of `POST /__pix3/api/build`. | The dev server spawns `process.execPath node_modules/vite/bin/vite.js build` and must not parse Vite's output. |
| P12 | `POST /__pix3/api/build {format?, compress?, entryScene?}` (`VP/src/build/run-build.ts`): flush through the barrier (15 s; `409 E_EDITOR_UNSYNCED`), one build at a time (`409 build_in_progress`), child env `PIX3_NO_SYNC=1` + `PIX3_BUILD_FORMAT`/`PIX3_ENTRY_SCENE`/`PIX3_BUILD_COMPRESS`, stdout/stderr lines as `pix3:build {phase: flush|start|output|done|failed}` frames to every tab; `400 build_disabled` under `build: false`. Client: `host.build.run()` + `host.build.onProgress()`; editor: Run > Build Playable (`BuildGameCommand`, notice in the host banner). | §B.6 «Из UI». The env override lets the editor ask for a zip from an html-configured project. |
| P13 | Before any build reads the disk: `flushEditorBeforeBuild` (`VP/src/build/editor-flush.ts`) in `buildStart`, and `syncEditor` (`CLI/editor-sync.ts`) in `pix3 check` / `pix3 smoke` — `.pix3/dev.json` → `GET hello` (2 s) → `POST flush` (15 s). Dead server = fine; a live editor that cannot flush = `E_EDITOR_UNSYNCED` (build fails; check diagnostic; smoke failure, exit 2). `--no-sync` / `PIX3_NO_SYNC=1` skip it. Two copies on purpose (the CLI does not depend on the plugin). | §B.6 «npm run build, pix3 check, pix3 smoke». `POST /flush` already existed (barrier step 0). |
| P14 | `pix3()` now returns `Plugin[]` (`[postprocessing-stub, core, single-file, classic-script]`); the three build plugins carry `apply`. `build: false` returns `[core]` only. | Vite flattens nested arrays; `plugins: [pix3()]` keeps working. |
| P15 | The runtime's player templates (`RT/main.ts`, `register-project-scripts.ts`, `generated/`, `virtual-modules.d.ts`) are deleted; `RT/tsconfig.json` and `eslint.config.js` lose their excludes. | They moved (CLAUDE.md topology said so); keeping dead copies invites drift. Runtime change kept to deletions. |
| P16 | `compress` is accepted and warned about, not implemented; `report.json`, scenes-as-documents, WebP, full N11 handling: P2 as the brief says. `GLTFLoader` (three addons, ~100 KiB) and `yaml` ship in every build — the 1.x gltf stub is not ported (P2). | Scope. |

## 1. Milestones

| M | Content | Acceptance |
|---|---|---|
| PB-M1 | Strip table + stub + import-graph spec in the plugin | spec green against `RT` (found the `UIControl2D` importer) |
| PB-M2 | Scan, manifest reader, strip decision, classic rewrite | `scan.spec.ts`: mentions, exclusions, closure, resRoot, fonts/locales/atlas, entry resolution, decideStrip, classic rewrite |
| PB-M3 | Player (`VP/player/`), virtual modules, plugin wiring (config/buildStart/load/generateBundle/closeBundle), zip, record | `build.spec.ts`: real `vite build` of the fixture — html (classic, embedded, stubs, stub kept where mentioned, `strip: false`), entry scene (option/env/manifest), zip contents, `PIX3_BUILD_FORMAT`, `build: false` untouched |
| PB-M4 | Route + client + editor command; CLI sync | `build-route.spec.ts`: spawned child build, frames, 409s, 400s; `check.spec`/`smoke.spec`: `E_EDITOR_UNSYNCED`, `--no-sync`, stale `dev.json` |
| PB-M5 | Artifact check in headless Chrome on a real template | `vite preview`, `file://`, `<iframe sandbox="allow-scripts">`: `__PIX3_PLAYER__.status === 'running'`, `frames` counting, no errors |

## Progress

- 2026-10-09: PB-M1…PB-M5 done (worktree branch, local commits).
  - Fixture: an inline minimal project (`VP/src/test-support/build-fixture.ts`: Group2D + ColorRect2D + Sprite2D + Label2D + one `user:` script, 1×1 PNG), `node_modules` linked to the checkout. A full html build of it takes ~0.6 s under rolldown; the artifact is 1 463 KiB (three + runtime + `yaml` + `GLTFLoader`; `postprocessing` stubbed).
  - PB-M5 on `recipe-blank-2d` (PostProcess bloom → the static `postprocessing` path, 3 assets, 41 modules stripped, 1 485 KiB): headless Chrome 155 / SwiftShader, 10/11 checks of the script, the eleventh being the script's own wrong expectation (`location.origin` of a sandboxed `file://` frame reads `file://`, the origin is opaque all the same — re-measured from inside: `parent.document` throws). `vite preview`: 2 → 15 frames in 1 s; `file://`: 2 → 5; sandboxed iframe (in-process context under this Chrome; no OOPIF): 2 → 4; `errors: []`, no page exceptions, in all three.
  - Script: `build-check/{run,cdp}.mjs` — written in this session's scratchpad because the isolated worktree session could not write to `../pix3-core-spikes`; it belongs there (`build-check/`) and takes `--core <checkout>`.
  - `npm test`, `lint`, `type-check` clean (see the final report for the numbers).

## Deviations from the plan

- §B.6 item 2 «importer protection»: P1 ships the table's own fixpoint (`importers`, `lazyValueImporters`) and the dependency rule; `this.parse` of dependencies' named imports is P2 (as the item itself says).
- §B.6 item 5 classic rewrite: extended beyond DeepCore's (`import.meta.resolve`, generic `import.meta`), see P9.
- `postprocessing` stub needed its own pre-plugin (P8) — the 1.x alias map had no such ordering problem.
- The player's scene list is constant-folded out of a build whose entry is known (rolldown); the spec judges the entry by `.pix3/build.json`, not by grepping the bundle.

## Debt

- `compress`, `dist/<name>.report.json`, scenes-as-documents, WebP, `export.{prune,include,exclude}Globs`, gltf stub, dependency import parsing (N11) — P2.
- Zip `index.html` stays a module script: fine hosted, not from `file://` (the plan's zip is for hosting; say so in the editor when the UI offers formats).
- The dev player registers the real `NetworkService` always; the build decides by mentions.
- Vite 7 path (`inlineDynamicImports`) is written by `rolldownVersion` but not exercised — only Vite 8 is installed here.
- The browser check lives outside the repo (scratchpad → `pix3-core-spikes/build-check/`); the P1 gate wants it re-run after the plugin's `dist/` changes.
