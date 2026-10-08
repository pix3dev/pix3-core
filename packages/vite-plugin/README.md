# @pix3/vite-plugin

`pix3({ resRoot = '.', editor = true, build = 'html' | 'zip' | false, compress = false, allowRemote = false })` — serves the Pix3 editor at `/__pix3/` on the project's Vite dev server, with the file API (`/__pix3/api/*`), the sync barrier, `virtual:pix3/*` and `virtual:runtime-*` modules, and the playable build.

Not implemented yet: this is phase P1 work (plan `pix3/.plans/pix3-core.md` §B). The routes are ported from `packages/cli/src/serve/`; the walking skeleton and the sync-barrier spike are in `pix3-core-spikes`.
