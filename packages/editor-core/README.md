# @pix3/editor-core

The Pix3 editor (Lit, Valtio, Golden Layout), shipped as prebuilt ESM and mounted by `@pix3/vite-plugin` through `mountEditor(el, host: EditorHost)`.

- **Contract:** `src/host/EditorHost.ts` (types only). The plugin's page client (`packages/vite-plugin/src/client`) implements it; a spec there checks conformance.
- **Boot:** `src/host/mount.ts` — host first, runtime services and scripts, `ProjectService.openHostProject()`, the writer claim (`WriterService`), the sync handlers (`SceneWriteService.flushDirty`, `SyncApplyService`), the bridge `window.__PIX3_DEBUG__` (`src/host/debug-bridge.ts`), then the shell `<pix3-editor>`.
- **Build:** `npm run build -w packages/editor-core` → `dist/index.js` (+ literal lazy chunks), `dist/editor.css` (linked by the plugin's editor page — no CSS import may reach the editor chain), `dist/optimize-deps.json` (every bare external; the plugin pre-bundles all of them, or Vite would re-optimize mid-session and load a second `@pix3/runtime`), `dist/THIRD_PARTY_NOTICES`. `scripts/check-dist.mjs` refuses `import.meta.hot`, `/@vite/client`, CSS imports and non-literal `import()`.
- **Dev loop:** `npm run dev -w packages/editor-core` (watch build), then reload the editor tab. There is no HMR for the editor by design (plan §B.2 variant B).
- **Tests:** specs run under the root vitest config with `FakeHost` (`src/host/testing/fake-host.ts`) in place of a dev server.

Port record and decisions: `.plans/editor-core-port.md`. The snapshot it started from is `pix3` at `5442a097`.
