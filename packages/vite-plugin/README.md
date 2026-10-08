# @pix3/vite-plugin

`pix3({ resRoot = '.', editor = true, build = 'html' | 'zip' | false, compress = false, allowRemote = false })` — serves the Pix3 editor at `/__pix3/` on the project's Vite dev server, with the file API (`/__pix3/api/*`), the sync barrier, `virtual:pix3/*` modules, and (later) the playable build. Design: plan `pix3/.plans/pix3-core.md` §B.

Done (P1, dev side):

- editor page at `/__pix3/` as raw HTML (variant B: no `/@vite/client`), own WebSocket `/__pix3/ws`;
- file API ported from `packages/cli/src/serve/` without token/lease: `file` GET/HEAD/PUT with sha256 ETag, `If-Match` → 412, `manifest`, `hash`, `mkdir|delete|move`, `X-Mutation-Id` replay, `hello`;
- write guard: Host check, loopback peers unless `allowRemote`, `X-Pix3: 1` + own `Origin` for mutations and the socket;
- writer hand-over `handover/claim` under the write mutex, `409 writer_superseded`;
- `pix3:fs` events (two scans 300 ms apart, `author: editor|external`);
- sync barrier `POST /__pix3/api/sync` (rescan → hard-invalidate roots → `environment.reloadModule` → page ack with executed-content stamps), `POST /__pix3/api/flush`;
- `virtual:pix3/{editor-host,editor-scripts,bot-policies,spine-loader}`; `.pix3/dev.json`; version gate;
- the page client is the editor's `EditorHost` (`src/client/`, conformance in `host-contract.spec.ts`); `/__pix3/editor.css` and `optimizeDeps.include` come from the installed `@pix3/editor-core/dist`.

Not yet: player (`./player`, `virtual:runtime-*`, scene manifest), build, changeset/journal, the image-generation key proxy.

Specs: `src/plugin.spec.ts` (real Vite on a free port, fake tab over the socket).
