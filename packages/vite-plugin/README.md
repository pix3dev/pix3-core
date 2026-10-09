# @pix3/vite-plugin

`pix3({ resRoot = '.', editor = true, build = 'html' | 'zip' | false, compress = false, allowRemote = false })` — serves the Pix3 editor at `/__pix3/` on the project's Vite dev server, with the file API (`/__pix3/api/*`), the sync barrier, `virtual:pix3/*` modules, and (later) the playable build. Design: plan `pix3/.plans/pix3-core.md` §B.

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

Not yet: player (`./player`, `virtual:runtime-*`, scene manifest), build, the image-generation key proxy.

Specs: `src/plugin.spec.ts`, `src/files/changeset.spec.ts`, `src/files/history.spec.ts` (real Vite on a free port, fake tab over the socket; crash/recovery cases drive `ProjectFiles` directly with its `faults` hook).
