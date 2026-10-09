# @pix3/vite-plugin

`pix3({ resRoot = '.', editor = true, build = 'html' | 'zip' | false, strip, entryScene, compress = false, allowRemote = false })` — serves the Pix3 editor at `/__pix3/` on the project's Vite dev server, with the file API (`/__pix3/api/*`), the sync barrier, `virtual:pix3/*` modules, the player and the playable build. Design: plan `pix3/.plans/pix3-core.md` §B; the record of the player/build port is `.plans/player-build.md`. `pix3()` returns a plugin array (`plugins: [pix3()]`).

## Player

`src/main.ts` of a project is `import { startGame } from '@pix3/vite-plugin/player'; startGame('#app');`. The player (`player/index.ts`, emitted to `dist/player/`) boots `@pix3/runtime` on the `virtual:pix3/*` modules the plugin generates: `scene-manifest` (from `pix3project.yaml`: entry scene, scene list, viewport, quality, fonts, locales), `embedded-assets` (`{}` in dev and zip, every asset as base64 in an html build), `project-scripts` (eager glob of `scripts/` and `src/scripts/`, registered as `user:<Export>`), `spine` / `postprocessing` / `network` (static imports in a build that uses them, no-ops otherwise). In dev `ResourceManager('/<resRoot>/')` fetches from the dev server; a build uses `./`. `window.__PIX3_PLAYER__ = { status, frames, errors, scene, runner }` is what a check reads.

## Build (`vite build`)

- `build: 'html'` (default): one self-contained `dist/index.html` — `vite-plugin-singlefile`, then DeepCore's classic-script rewrite (no `type="module"`, script at the end of `<body>`, no `import.meta`), so it runs from `file://` and inside a sandboxed iframe. `build: 'zip'`: the plain build with the assets beside `index.html` under their `res://` paths, archived to `dist/<projectName>.zip` (`fflate`). `build: false`: `vite build` is left alone (the player's modules still generate).
- `buildStart` scans every text source outside `node_modules`/`dist`/`.pix3` (`src/build/scan.ts`): `mentionedNames`, the asset set (every scene and prefab, `res://` references, directories, Spine atlas pages, declared locale tables and their sprites, manifest fonts, a packed atlas), and whether Spine / `postprocessing` / the network are used.
- Strip (`src/build/strippable-runtime-modules.ts`): runtime modules nothing mentions are replaced by throwing stubs in the `load` hook; `postprocessing` resolves to a stub in an html build with no `PostProcess` node. On by default, off when a project dependency depends on `@pix3/runtime` (its imports are not scanned), `strip: false` / `strip: true` override. The table is guarded by `strippable-runtime-modules.spec.ts` against the runtime's import graph.
- Before reading the disk, a build asks the dev server named by `.pix3/dev.json` to flush the editor's unsaved scenes (`POST /__pix3/api/flush`, 15 s); a live editor that cannot flush fails the build with `E_EDITOR_UNSYNCED`; `PIX3_NO_SYNC=1` skips it (as `pix3 check --no-sync` does).
- Vite 7 and 8: single-chunk output is `inlineDynamicImports` (rollup) or `codeSplitting: false` (rolldown), chosen by `this.meta.rolldownVersion`; stable hooks only.
- The result is recorded in `.pix3/build.json` (format, path, bytes, sha256, entry scene, assets, stripped modules, warnings).
- The build is run by whoever owns the terminal (`npm run build` — the coding agent, the user, CI), never from the editor: the dev server has no build route (owner decision 2026-10-10, `.plans/player-build.md`).
- Not yet (P2): `compress`, `report.json`, scenes as documents, WebP, parsing a dependency's imports (N11), the gltf stub.

Done (P1, dev side):

- editor page at `/__pix3/` as raw HTML (variant B: no `/@vite/client`), own WebSocket `/__pix3/ws`;
- file API ported from `packages/cli/src/serve/` without token/lease: `file` GET/HEAD/PUT with sha256 ETag, `If-Match` → 412, `manifest`, `hash`, `mkdir|delete|move`, `X-Mutation-Id` replay, `hello`;
- write guard: Host check, loopback peers unless `allowRemote`, `X-Pix3: 1` + own `Origin` for mutations and the socket;
- writer hand-over `handover/claim` under the write mutex, `409 writer_superseded`;
- changeset `POST /__pix3/api/changeset` (plan §C.4): several files as one transaction under the same mutex — preflight of every `If-Match`/`createOnly` (412 names the file), staging in `.pix3/tx/<id>/{new,old}/<n>` + `intent.json` with fsync, renames, one `pix3:fs` frame; a failed rename rolls back from `old/`, a crash is rolled forward (complete staging) or back at the next start;
- version journal `.pix3/history/<path>/{index.jsonl,<stamp>-<hash8>}` for `*.pix3scene`, `*.prefab`, `pix3project.yaml` (200 versions / 7 days per path, the newest always kept): authors `editor` (PUT, changeset), `external` (watcher, rescans, a start-up snapshot of what changed while no server ran), `restore`, `rejected-draft` (posted by any tab); routes `history`, `history/version`, `history/record`, `history/restore` (a restore is broadcast as `external`, so the editor follows it like an agent's change);
- `pix3:fs` events (two scans 300 ms apart, `author: editor|external`);
- sync barrier `POST /__pix3/api/sync` (rescan → hard-invalidate roots → `environment.reloadModule` → page ack with executed-content stamps), `POST /__pix3/api/flush`;
- `virtual:pix3/{editor-host,editor-scripts,bot-policies,spine-loader}`; `.pix3/dev.json`; version gate;
- the page client is the editor's `EditorHost` (`src/client/`, conformance in `host-contract.spec.ts`); `/__pix3/editor.css` and `optimizeDeps.include` come from the installed `@pix3/editor-core/dist`.

Not yet: the image-generation key proxy.

Specs: `src/plugin.spec.ts`, `src/files/changeset.spec.ts`, `src/files/history.spec.ts` (real Vite on a free port, fake tab over the socket; crash/recovery cases drive `ProjectFiles` directly with its `faults` hook); `src/build/build.spec.ts` (a real `vite build` of the inline fixture in `src/test-support/build-fixture.ts`: html, zip, `build: false`, strip, options), `src/build/scan.spec.ts`, `src/build/strippable-runtime-modules.spec.ts`.
