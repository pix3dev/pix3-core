# editor-core port (P1)

Date: 2026-10-08. Derived from `../pix3/.plans/pix3-core.md` §B, §C (seams only), §D.1, §F, §G.2 — those stay authoritative; where this file disagrees with them it says so (AGENTS.md rule 13). Design by the architect pass; owner defaults recorded in §8.

`EC` = `packages/editor-core/src`, `VP` = `packages/vite-plugin/src`. The untouched snapshot is `git show 35ac1c6:packages/editor-core/src/<path>`; the full 1.x editor is `../pix3` at `5442a097`.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `EditorHost` is a **types-only file in editor-core** (`EC/host/EditorHost.ts`, zero imports), exported from `EC/index.ts` and as subpath `@pix3/editor-core/host`; the plugin imports it `import type` through a tsconfig `paths` mapping to the source file. | The guest defines the port; a zero-import file keeps the plugin's type program clean; type-only edge = no runtime cycle. |
| D2 | `EditorHostConnection implements EditorHost` directly (`VP/client/index.ts` + new `VP/client/host-files.ts`); `virtual:pix3/editor-host` keeps `mountEditor(root, host)`. | The connection already owns WS, `api()`, `claim()`, `sync()`, hooks. |
| D3 | `mountEditor(el, host)` boots straight into Studio: no router, welcome, auth, home, flow, mode switch. `ProjectService.openHostProject()` replaces all `open*` paths. | Anti-scope I.2/I.3. |
| D4 | Port-phase write path = `SceneWriteService` (new) wrapping the existing `SaveSceneOperation` (coauthoring stripped, `If-Match` kept); Ctrl+S + flush-on-sync + a small idle timer (owner default, §8.6). `FlushService` later replaces `SceneWriteService` internals behind the same methods. | Load→edit→save end-to-end now; one seam for §C. |
| D5 | External changes are **frame-driven**: `pix3:fs` → `ExternalChangeService.reportFrame()` → clean scene `ReloadSceneCommand`, dirty scene = stale toast (merge is §C.3 later). `FileWatchService`, `ProjectSyncService`, `WorkspaceClient`, `WorkspaceEventsClient`, `WorkspaceSessionService` are **dropped** (disagrees with §C.5 "KEEP WorkspaceClient"). | The plugin's client is already the transport. |
| D6 | Writer claim at load **now, minimally** (`EC/host/WriterService.ts`): Web Lock `pix3:write:<projectId>` + `host.writer.claim()`; loser = read-only banner with "Take over" (`steal:true`). | The plugin already returns `409 writer_superseded`. |
| D7 | Scripts: `ProjectScriptLoaderService` → `registerRoots(roots)` over `host.scripts`; no compiler, no blob import, no rapier. Live components not re-instantiated on re-registration (1.x parity). | §B.2. |
| D8 | `GameBotHost` → `ModuleBotStore` built from `roots.botPolicies.modules`. | `virtual:pix3/bot-policies` exists. |
| D9 | Lib build: Vite lib mode, ESM, `dist/index.js` + `dist/editor.css` + `dist/assets/*` + `dist/optimize-deps.json` + `dist/THIRD_PARTY_NOTICES`. Externals: `@pix3/runtime`, `three`, `three/*`, `postprocessing`, `lit`, `lit/*`, `yaml`, `virtual:pix3/*`. Inlined: `valtio`, `golden-layout`, `feather-icons`, `reflect-metadata`. | `lit`/`yaml` are runtime dependencies; inlining duplicates them (disagrees with §A.3 "inlines lit, yaml"). |
| D10 | CSS is a **static file** linked from the raw editor page (`<link href="${base}__pix3/editor.css">`); dist JS has no CSS import. Shadow-DOM `?raw` CSS stays inlined. | Contract B; §B.0. |
| D11 | Editor images via `new URL('../../assets/x.png', import.meta.url)`, served by Vite from the editor-core package dir (in `fs.allow`), not under `/__pix3/assets/`. | Gate intent (nothing from the project's `public/`) is met (disagrees with §B.1 wording). |
| D12 | Lazy chunks: literal `import()` only, enforced by `packages/editor-core/scripts/check-dist.mjs`. Zero `@injectLazy` after the port. | Contract B. |
| D13 | `services/agent` → `services/game-test` **move** minus `AgentToolRegistry`, `create-node-registry`, `tool-batch`, `verify-rider`; `emoji-as-art.ts` → `services/scene/`. `debug-bridge.ts` rewritten now to a ~300-line v1-shaped subset, 3p registration a stub seam. | Compile needs it; avoids a second rewrite. |
| D14 | `services/export` **deleted** in the port (the plugin's build lane resurrects `ProjectBuildService.collectAssetPaths/scanMentionedNames`, `strippable-runtime-modules.ts`+spec from git for §B.6). Export UI returns in P2. | Its `?raw` globs are the 112 MB finding; nothing in P1 calls `host.build`. |
| D15 | `packages/cli/src/kit.spec.ts:241-262` reads a frozen list `packages/cli/src/kit/retired-editor-tools.ts` instead of `AgentToolRegistry.ts` as text. | Guard purpose holds; the kit rewrite (§F.5) retires it. |
| D16 | Three lanes, disjoint file sets (§7); lane A publishes the contracts (M0) before B/C start. | No merge conflicts. |

## 1. `EditorHost` contract

### 1.1 `EC/host/EditorHost.ts` (types only, no imports)

```ts
export interface EditorHost {
  readonly info: HostInfo;
  readonly files: HostFiles;
  readonly events: HostEvents;
  readonly scripts: HostScripts;
  readonly sync: HostSync;
  readonly writer: HostWriter;
  readonly build?: HostBuild;           // absent in P1
  openInEditor?(path: string, line?: number): Promise<void>; // Vite's /__open-in-editor
}

export interface HostInfo {
  readonly base: string;                 // Vite base, ends with '/'
  readonly root: string;                 // absolute project root (display only)
  readonly resRoot: string;              // where res:// points, relative to root ('.' default)
  readonly projectName: string;
  readonly tabId: string;
  readonly seq: number;
  readonly revision: string;
  readonly versions: { plugin: string; runtime: string | null; editorCore: string | null; vite: string };
}

export interface HostFileStat { readonly sha256: string; readonly size: number; readonly mtime?: number }
export interface HostWriteResult extends HostFileStat { readonly path: string; readonly seq: number }
export interface HostWriteOptions { readonly ifMatch?: string | '*'; readonly createOnly?: boolean; readonly mutationId?: string }
export type HostFileErrorCode = 'not_found' | 'base_mismatch' | 'exists' | 'writer_superseded' | 'reserved_path' | 'bad_path' | 'not_a_file' | 'forbidden' | 'network' | 'other';
export interface HostFileFailure { readonly code: HostFileErrorCode; readonly status: number; readonly currentHash?: string | null; readonly message: string }

export interface HostFiles {
  read(path: string): Promise<{ bytes: Uint8Array; sha256: string } | null>;   // null on 404
  readText(path: string): Promise<string | null>;
  head(path: string): Promise<HostFileStat | null>;
  write(path: string, data: Uint8Array | string, options?: HostWriteOptions): Promise<HostWriteResult>; // throws HostFileError
  mkdir(path: string): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
  manifest(): Promise<{ revision: string; seq: number; files: HostManifestEntry[] }>;
  hash(paths: readonly string[]): Promise<Record<string, string | null>>;
  /** Browser URL of a project file for <img>/TextureLoader: `${base}${wirePath}`. */
  url(path: string): string;
}
export interface HostManifestEntry { readonly path: string; readonly kind: 'file' | 'dir'; readonly size: number; readonly mtime: number; readonly sha256?: string }

export interface HostFsEvent { readonly op: 'create' | 'modify' | 'delete' | 'rename'; readonly path: string; readonly kind: 'file' | 'dir'; readonly sha256?: string; readonly from?: string; readonly author: 'editor' | 'external' }
export interface HostFsFrame { readonly seq: number; readonly revision: string; readonly events: readonly HostFsEvent[]; readonly writerId?: string }
export interface HostEvents {
  onFs(listener: (frame: HostFsFrame) => void): () => void;
  onConnection(listener: (state: 'open' | 'closed') => void): () => void;
}

export interface RootModule { readonly __pix3Revision: number; readonly modules: Record<string, Record<string, unknown>> }
export interface ScriptRoots { readonly editorScripts: RootModule; readonly botPolicies: RootModule }
export interface HostScripts {
  current(): ScriptRoots;
  onChange(listener: (roots: ScriptRoots) => void): () => void;
}

export type HookReply = { readonly ok: boolean; readonly reason?: string } & Record<string, unknown>;
export interface SyncInfo { readonly rev: number; readonly changed: Record<string, string | null>; readonly roots: ScriptRoots }
export interface HostSyncHandlers { flush?(timeoutMs: number): Promise<HookReply>; applySync?(info: SyncInfo): Promise<HookReply> }
export interface HostSync {
  setHandlers(handlers: HostSyncHandlers): void;
  run(options?: { expect?: Record<string, string>; timeoutMs?: number }): Promise<HookReply>;
}

export interface HostWriter {
  readonly id: string | null;
  readonly isSelf: boolean;
  claim(): Promise<{ writerId: string; seq: number; revision: string; hashes: Record<string, string> } | HostFileFailure>;
  onChange(listener: (writerId: string | null) => void): () => void;
}

export interface HostBuild { run(options: { format: 'html' | 'zip'; compress?: boolean; entryScene?: string }): Promise<{ path: string; bytes: number; sha256: string }> }
```

Wire paths are POSIX, relative to the Vite root (`VP/files/paths.ts`); `res://` mapping is the editor's job (§2.3).

### 1.2 Plugin side (lane A)

- `VP/client/index.ts`: `EditorHostConnection implements EditorHost` — `info` (from `welcome`), `files = new HostFilesClient(this)` (new `VP/client/host-files.ts`: `fetch` over `api()`; `write` sets `If-Match: "<sha>"`, `If-None-Match: *`, `X-Mutation-Id`; maps 404/412/409/403 to `HostFileFailure`), `events`, `scripts`, `sync` (`setHandlers` → existing `flush/applySync` hooks; `run` → `sync()`), `writer`, `openInEditor` (`fetch(`${base}__open-in-editor?file=…`)`).
- Welcome adds `root`, `projectName` (`basename(root)`).
- `editorPageHtml` adds `<link rel="stylesheet" href="${base}__pix3/editor.css">`; router serves `GET /__pix3/editor.css` from `<editorCoreDir>/dist/editor.css`.
- `config()`: editor-core package dir into `server.fs.allow`; `dist/optimize-deps.json` spread into `optimizeDeps.include`.
- Plugin tsconfig `paths`: `@pix3/editor-core/host` → `../editor-core/src/host/EditorHost.ts`; `peerDependencies["@pix3/editor-core"]` optional.

## 2. Boot

### 2.1 `EC/index.ts` (replaces `main.ts`)

```ts
import 'reflect-metadata';
export type * from './host/EditorHost';
export interface EditorHandle { dispose(): Promise<void> }
export async function mountEditor(el: HTMLElement, host: EditorHost): Promise<EditorHandle>
```
`EC/host/mount.ts`, in order:
1. `HostService.install(host)` (`@injectable()` singleton: `host`, `info`, `wirePath(res)`, `resPath(wire)`).
2. `registerRuntimeServices()` minus collab/cloud; `registerBuiltInScripts`; `setSpineModuleLoader(loadSpine)` with `import { loadSpine } from 'virtual:pix3/spine-loader'` (ambient type in `EC/types/virtual-pix3.d.ts`).
3. `RuntimeErrorBridgeService.initialize()`; `installDocumentTitleSync()`.
4. `ProjectScriptLoaderService.registerRoots(host.scripts.current())`; `host.scripts.onChange(r => loader.registerRoots(r))` (deferred while playing, applied on stop).
5. `await ProjectService.openHostProject()`.
6. `WriterService.claimAtLoad()`.
7. `host.sync.setHandlers({ flush: ms => sceneWrite.flushDirty(ms), applySync: info => syncApply.apply(info) })` — `EC/host/SyncApplyService.ts`: if playing → `{ok:false, reason:'stale', playing: appState.ui.playOwner, pending}`; else `registerRoots(info.roots)`, reload open **clean** scenes in `changed` (`ReloadSceneCommand`), re-read `pix3project.yaml` if changed, `{ok:true}`.
8. `host.events.onFs(frame => externalChanges.reportFrame(frame))`; `onConnection(s => appState.project.host.connection = s)`.
9. Append `<pix3-editor-shell>`; shell `firstUpdated` → `ensureStudioLayout()` → `EditorTabService.focusOrOpenScene(entryScene)`.
10. `installDebugBridge()`; return handle.

Spec `EC/host/mount.spec.ts` (F.2 guard): after `mountEditor(div, new FakeHost(...))` the container `hasService` for the listed tokens and `appState.project.status === 'ready'`.

### 2.2 `ProjectService` (1887 → ~450)

Keep: `loadProjectManifest`, `saveProjectManifest`, `getLoadedManifestHash`, `reloadProjectManifest`, asset-browser persisted state (keyed by `projectId`), `listDirectory/createDirectory/writeFile/writeBinaryFile/deleteEntry/moveItem` + the `*AfterMove` path-rewrite family, `openStartupScene`, `clearOpenDocumentState`, `STARTUP_SCENE_*`.
New: `openHostProject()` — `loadManifestOnOpen()` (keeps the `metadata.projectId` backfill), `appState.project = { id: getProjectId(manifest) ?? hash(info.root), backend: 'host', projectName: info.projectName, status: 'ready', manifest, … }`, entry scene = `manifest.defaultExportScenePath ?? 'scenes/main.pix3scene'`.
Drop: recents, IndexedDB handles, picker, browser/cloud/workspace opens, template creation, `reactivateCurrentProject`, `closeCurrentProject`, hybrid sync, collaboration refs.

### 2.3 `ProjectStorageService` (846 → ~250)

Same public surface the ~40 importers use, over `host.files`:
```ts
listDirectory(path = '.'): Promise<FileDescriptor[]>   // cached manifest, refreshed on pix3:fs frames
readTextFile(path): Promise<string>; readBlob(path): Promise<Blob>
writeTextFile(path, text, { baseHash?: string; unconditional?: boolean } = {}): Promise<void>
writeBinaryFile(path, data: ArrayBuffer): Promise<void>
deleteEntry / createDirectory / moveEntry / fileExists / getLastModified
getKnownContentHash(path): string | null
getManifestContentHash(path): string | null | undefined
normalizeResourcePath(path): string
getBackend(): 'host'
```
`FileDescriptor` moves to `EC/services/project/file-descriptor.ts`. Path mapping: `res://x` ↔ wire `${resRoot === '.' ? '' : resRoot + '/'}x`; `pix3project.yaml`, `scripts/`, `design/tests/bots/` are root-relative. `HostFileFailure{code:'base_mismatch'}` → `SceneWriteConflictError` (`EC/services/project/write-errors.ts`, replaces `WorkspaceConflictError`).

### 2.4 Write path before FlushService

- `SaveSceneOperation`: remove `FileWatchService`, `ProtectedSetService`, `RecoveryJournalService`, `ExternalChangeService`; keep `SceneDiskStateService` (known hash per path), `If-Match = known.hash`, the `nodeDataChangeSignal` cutoff. On 412 → `externalChanges.report(path)`.
- `SceneWriteService` (new): `saveScene(sceneId)`, `flushDirty(timeoutMs): Promise<HookReply>` — waits for `pointerup` if `appState.ui.gestureInProgress` (lane B sets it in the viewport drag controllers) up to `timeoutMs`, else `{ok:false, reason:'gesture_in_progress'}`; saves every dirty descriptor; `{ok:true, saved}`; idle timer (1.5 s after last operation, ≤10 s) per §C.1 table, never during a gesture. Ctrl+S calls `saveScene`.
- `ExternalChangeService` (475 → ~250): drop storage polling; keep stabilise/batch/play-hold; `reportFrame(frame)` for `author:'external'` events on open scenes/prefabs or `pix3project.yaml`; clean → `ReloadSceneCommand`, dirty → `appState.project.host.staleScenes` + toast.
- Drop: `autosave/`, `coauthoring/*` except `ExternalChangeService`/`SceneDiskStateService` if they live there, `external-merge/*` except `scene-doc.ts`, `value-equality.ts`, `hash.ts` (keep resolvers only if `scene-doc.ts` imports them), `workspace/**` except `AgentKeepaliveService.ts` → `EC/services/core/AgentKeepaliveService.ts` (~60 lines).

### 2.5 State (`EC/state/AppState.ts`)

Drop `auth`, `router`, `collaboration`, `telemetry` (verify), `ui.workspaceMode`, `ui.flow*`, `project.{directoryHandle, recentProjects, hybridSync, workspace, coauthoring, openProgress}`, `panelVisibility.profiler`. Add `project.host: { connection: 'open'|'closed'; writer: 'self'|'other'|'none'; staleScenes: string[] }`, `ui.playOwner: 'agent'|'designer'|null`, `ui.playStartedAt: number|null`, `ui.gestureInProgress: boolean`. `ProjectBackend = 'host'`.

## 3. Scripts (lane C)

`ProjectScriptLoaderService` (944 → ~180):
```ts
registerRoots(roots: ScriptRoots): { registered: string[]; skipped: { file: string; export: string; reason: string }[] }
ensureReady(): Promise<void>
getRegisteredIds(): ReadonlySet<string>
```
Body = the `isScriptCtor` walk of `packages/runtime/src/register-project-scripts.ts` + `clearRegisteredScripts` → `registerComponent` (id `user:<ExportName>`) → `sceneManager.resolvePendingComponents()` → `scriptRefreshSignal++`, `scriptsStatus='ready'`. Duplicate export names → `skipped` + warn. Drop compilation, watchers, hashes, rapier (`ScriptCreatorService` loses `syncAndBuild`).

`features/scripts/play-workspace.ts`: delete the Flow branch; keep `await scripts.ensureReady()` before `LoadSceneCommand`.

`GameBotHost` (279 → ~120): `ModuleBotStore(() => host.scripts.current().botPolicies.modules)`; keep `BotDeclarationWriter` + `pix3-test-bot-dts.ts`.

Survivors in `services/scripting`: `ProjectScriptLoaderService`, `ScriptCreatorService`, `scene-nodes-dts.ts` (+spec), `ScriptRegistry.spec.ts`. Drop `script-diagnostics-format.ts` with `CheckScriptsCommand`.

Play: `GamePlaySessionService` — remove `NetworkService` and `ProfilerSessionService`; keep popout; `playOwner='designer'` from UI start, `'agent'` from the bridge. Delete `StartOnlineGameCommand`.

## 4. Build of `dist/`

`packages/editor-core/vite.config.ts`:
```ts
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') }, dedupe: ['three'] },
  build: {
    target: 'es2022', sourcemap: true, outDir: 'dist', emptyOutDir: true, cssCodeSplit: false,
    lib: { entry: resolve(__dirname, 'src/index.ts'), formats: ['es'], fileName: () => 'index.js', cssFileName: 'editor' },
    rollupOptions: { external: [/^@pix3\/runtime(\/|$)/, /^three(\/|$)/, 'postprocessing', /^lit(\/|$)/, 'yaml', /^virtual:pix3\//],
      output: { chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
  plugins: [optimizeDepsManifest(), thirdPartyNotices()],
});
```
- `optimizeDepsManifest`: external bare subpaths seen in `resolveId` → `dist/optimize-deps.json`.
- `thirdPartyNotices`: inlined `node_modules/<pkg>` LICENSEs → `dist/THIRD_PARTY_NOTICES`.
- `scripts/check-dist.mjs`: fails on `import.meta.hot`, `/@vite/client`, a `.css` import, or a non-literal `import(` in `dist/**/*.js`; checks `dist/editor.css`; prints sizes (S7 ≤ 8 MB).
- `package.json`: `build: "vite build && node scripts/check-dist.mjs"`, `dev: "vite build --watch"`; `exports["./host"]` types via `tsc -p tsconfig.dts.json --emitDeclarationOnly`.
- `tsconfig.json`: `emitDecoratorMetadata: false` (esbuild cannot emit it; `fw/di.ts` reads no `Reflect.*`).
- Assets: `ViewportAdornments.ts:63-77` → `new URL('../../../assets/cam.png', import.meta.url).href`.
- golden-layout CSS and `./index.css` imports move to `EC/index.ts` → one `editor.css`.

Dev loop: `npm run dev -w packages/editor-core` (watch build) + `packages/editor-core/dev-project` — a committed minimal project (`index.html`, `vite.config.ts` with `pix3()`, `src/main.ts`, `pix3project.yaml`, `scenes/main.pix3scene`, `scripts/Spin.ts`). Reload the tab after a rebuild; no src-through-Vite mode (it would put Light-DOM CSS imports and `/@vite/client` into the editor chain).

Tests: root `vitest.config.ts` includes `packages/editor-core/src/**/*.spec.ts`, aliases `virtual:pix3/spine-loader` → `EC/host/testing/spine-loader-stub.ts`. `FakeHost` (`EC/host/testing/fake-host.ts`, in-memory files, sha256 via `crypto.subtle`, frames on write) replaces every `FileSystemAPIService`/`WorkspaceClient` fake. Root `lint` adds editor-core and removes the global ignore.

## 5. Delete / stub / keep

| Area | Action |
|---|---|
| `core/debug-bridge.ts` (1286) | Rewrite → `EC/host/debug-bridge.ts` ~300: `help, status, scene, node, find, selection, errors, clearErrors, sync(opts) → host.sync.run, play {start,stop,restart,pause,status}` (owner rules §B.3, `{ok:false, reason:'not_owner'}` for designer sessions), `screenshotPrepare({target})`; failures `{ok:false, reason, detail}`; `registerThirdPartyTools()` = no-op seam. Drop the rest (live DTOs stay in `agent-introspection.ts`). |
| `services/agent` → `services/game-test` | MOVE `GameTestService, GameInputService, NodeWatchRecorder, ProjectTraceStore, game-assertions, game-bot-world, game-bots, game-control, game-monkey, game-routines, game-run-protocol, game-traces, key-for-code, nondeterminism-probe, pix3-test-bot-dts, reachability-journal, renderability-note, GameBotHost` (+ specs). DROP `AgentToolRegistry`(+spec), `create-node-registry`, `tool-batch`, `verify-rider`. `emoji-as-art.ts` → `services/scene/` (update AGENTS.md path). `recipes.spec.ts` import → `services/game-test/game-routines`. |
| `kit.spec.ts:245-249` | D15: `packages/cli/src/kit/retired-editor-tools.ts` exporting `RETIRED_EDITOR_TOOL_NAMES` (from `git show 35ac1c6:packages/editor-core/src/services/agent/AgentToolRegistry.ts`). |
| image-gen | KEEP `GeminiImageProvider, OpenAIImageProvider, ImageGenTypes, AssetGenService, GenerationHistoryService, ImageEditTargetService, AiImageSettingsService (minus bg-removal), SaveGeneratedAssetDialogService, GeneratedAssetDropService, svg-render`; registry → two providers; DROP `SvgLlmImageProvider, SvgSpriteGenerator`. `image-ops.ts` → `EC/core/image-ops.ts`. OpenAI base → `${base}__pix3/api/proxy/openai/v1` (proxy is P2; until then "proxy unavailable"). Keys stay in `SecretStorageService` prefixed by projectId until the proxy (deviation from §B.1). |
| settings dialog (2455 → ~700) | Keep General, Images, About; drop agent/assistants/souls/bridge/Strophe/bg-removal. |
| status bar (985 → ~250) | Keep diagnostics, performance; drop sync/workspace/coauthoring/devBackend/agentLanes/bundleSize; add `renderHostStatus` (connection, writer, dirty count, version). |
| `ui/pix3-editor-shell.ts` (2158 → ~800 REWRITE) | Toolbar + `.layout-host` + dialog hosts (confirm, behavior/effect picker, script creator, project settings, editor settings, auto-slice, asset import, save generated asset, node type picker) + `<pix3-status-bar>` + `<pix3-host-banner>`; commands minus dropped areas; shortcuts; `ensureStudioLayout`; no router/auth/welcome/flow/collab/mode-switch/workspace overlay/uikit/export/recovery-menu/merge-banner. |
| `core/LayoutManager.ts` | Panels: sceneTree, viewport, inspector, assets, animationTimeline, logs, game, runtime, localization, generate + `history` (new `pix3-history-panel`: undo/redo list from `HistoryManager`; "Restore version" with §C.4). Drop profiler, code, background, spriteEditor, modelLab, uiKitForge, agentChat, library, animation. |
| `ui/shared` drops | `pix3-mode-switch`, `pix3-project-sync-dialog`, `pix3-recovery-menu`, `pix3-playable-export-dialog`, `pix3-playable-export-progress-dialog`, `pix3-image-annotator`, `composer-attachments`, `annotation-doc`; `pix3-workspace-banner` → rewrite as `pix3-host-banner.ts` (read-only / disconnected / "Take over"); `pix3-lightbox.ts` drops `markdown-lite` + annotator. |
| `game-tab.ts`, `logs-panel.ts`, `EditorTabService.ts` | Remove Preview/Online/AgentChat; "Fix with agent" → "Copy for agent"; remove `CodeDocumentService`/`PreviewHostService` (code tabs gone). |
| `ui/assets`, `editor-tab.ts`, `inspector-panel.ts` | Remove `LibraryInsertService` and `library-inspector`; `openInSpriteEditor` removed; `AssetFileActivationService` script activation → `host.openInEditor`; `contour-trace.ts` restored from `../pix3` `5442a097:src/ui/sprite-editor/contour-trace.ts` into `EC/core/contour-trace.ts`. |
| `services/project` | DROP `ProjectSyncService`(+spec), `agent-kit/**`; keep `TemplateService`, `template-data.ts`. |
| `services/export` | DROP all (D14). `features/project/{Build,ExportPlayableHtml,ExportPlayableZip,StartRemotePreview,NewProject,CloseProject,ConnectWorkspace,InstallAgentKit,MoveProjectToFolder,OpenProjectSync}Command`, `peek-export-warning.ts` DROP; `OpenProjectInIdeCommand` → `host.openInEditor?.()`, hidden when absent. |
| `features/editor` | Keep `OpenEditorSettings, OpenGeneratePanel, SaveActiveResource, UpdateEditorSettingsOperation`; drop `OpenAgentChat, OpenModelLab, OpenProjectHome, OpenSpriteEditor*, OpenUiKitForge, SwitchWorkspaceMode`. |
| `features/scene` | Drop `AcceptAgentVersionOperation`, `RestoreRecoveryVersionOperation` (+specs); `SaveAsScene*`/`SaveAsPrefabCommand` → `ProjectStorageService.fileExists`. |
| `core` | DROP `engine-source.ts`(+spec), `carrom-sample.spec.ts`, `multiplayer-arena-sample.spec.ts`, `agent-reference-docs.spec.ts`. KEEP `agent-introspection.ts`. `register-runtime-services.ts` collab/cloud removed. `TextureAtlasService` → `sha256Hex` from `EC/core/hash.ts`. `services/core/RouterService.ts` DROP. `OperationService` drop `CollaborationService`/`Y.UndoManager` branches. |
| `types/` | Delete `build-defines.d.ts`, `update-version-mjs.d.ts`; add `virtual-pix3.d.ts`. `version.ts` stamped by root `scripts/sync-version.mjs`. |

## 6. Specs

A spec dies with its feature; a passing spec of ported behaviour stays; specs broken by the environment go to a list (PR body / this file) and are fixed before `alpha.1`.

Delete with features: `AgentToolRegistry.spec`, `services/project/{agent-kit,autosave,coauthoring,workspace}/*.spec` and `ProjectSyncService.spec`, `external-merge/*` specs except `scene-doc`/`value-equality`, `services/export/*.spec`, `SwitchWorkspaceModeCommand.spec`, specs of dropped `features/project` commands, `features/scene/{AcceptAgentVersion,RestoreRecoveryVersion}*.spec`, `ui/shared/{pix3-mode-switch,pix3-image-annotator}.spec`, `ui/shared/pix3-status-bar.spec` (rewrite small), `core/{engine-source,carrom-sample,multiplayer-arena-sample,agent-reference-docs}.spec`, `SvgSpriteGenerator*.spec`, `services/editor/UpdateVersionBuild.spec`, `script-diagnostics-format.spec`.

Expected environment fixes: `ProjectService`/`ProjectStorageService` specs, `ProjectScriptLoaderService.spec` (rewrite around `registerRoots`), `play-workspace.spec`, `SaveSceneOperation`/`SaveAsSceneOperation` specs, `AssetsPreviewService.spec`, `asset-tree`/`grouped-asset-tree` specs, `EditorTabService.spec`, `GamePlaySessionService*.spec`, `generate-panel.spec`, `ProjectTraceStore.spec`, `LayoutManager.spec`, game-test path moves.

## 7. Work breakdown

| M | Acceptance |
|---|---|
| M0 contracts (lane A) | `EC/host/EditorHost.ts`, `HostService`, `FakeHost`, `ProjectStorageService` public signature, state trims, `SceneWriteService` skeleton; B/C start after this. |
| M1 compiles | `cd packages/editor-core && npx tsc --noEmit -p .` = 0 errors. |
| M2 builds + mounts (A) | `npm run build -w packages/editor-core` writes `dist/{index.js,editor.css,optimize-deps.json,THIRD_PARTY_NOTICES}`, `check-dist` passes; `dev-project` on `/__pix3/` shows the layout and the entry scene; no `/@vite/client`, nothing from `public/`. |
| M3 edit + save + scripts + play | Drag → inspector → Ctrl+S → `PUT` with `If-Match`, YAML on disk; external edit → clean reload / dirty toast; script edit → re-registration → new field; `POST /__pix3/api/sync` → ok with stamps; play start/stop; sync during play → `stale, playing:'designer'`; second tab → read-only banner, Take over works. |
| M4 green | `npm test`, `lint`, `type-check` include editor-core (environment list kept); `mount.spec.ts` green; README/CLAUDE status updated. |

**Lane A — host, boot, project, build, plugin**: `EC/index.ts`, `EC/host/**`, `EC/main.ts` (delete), `EC/core/{register-runtime-services,lazy-spine,debug-bridge,hash}.ts`, `EC/services/project/**`, `EC/services/core/**`, `EC/state/**`, `EC/features/project/**`, `EC/features/scene/{Save*,Load*,Reload*,Accept*,Restore*,scene-graph-swap}.ts`, `EC/types/**`, `EC/version.ts`, `packages/editor-core/{vite.config.ts,package.json,tsconfig*.json,scripts/**,dev-project/**}`, root `vitest.config.ts`, `eslint.config.js`, `package.json`, all of `VP/**`.

**Lane B — shell and UI**: `EC/ui/**`, `EC/core/LayoutManager.ts`, `EC/core/{image-ops,contour-trace}.ts`, `EC/features/editor/**`, `EC/features/window/**`, `EC/services/editor/**`, `EC/services/image-gen/**`, `EC/services/assets/**`, `EC/services/localization/**`, `EC/services/animation/**`, `EC/services/atlas/**`, `EC/services/viewport/ViewportAdornments.ts` + the `gestureInProgress` writes in the viewport drag controllers.

**Lane C — scripts, play, game-test, export removal, CLI spec**: `EC/services/scripting/**`, `EC/services/agent → EC/services/game-test/**`, `EC/services/scene/emoji-as-art.ts`, `EC/services/play/**`, `EC/features/scripts/**`, `EC/services/export/**` (delete), `EC/core/engine-source*` (delete), `EC/core/{carrom,multiplayer-arena,agent-reference-docs}.spec.ts` (delete), `packages/cli/src/kit.spec.ts` + `packages/cli/src/kit/retired-editor-tools.ts`, `packages/create-pix3/templates/recipes.spec.ts`.

Sync points: M0 before B/C; B reads `appState.project.host` (A); C injects `HostService` (A); A's `mount.ts` wires B's shell and C's loader in M2. Estimate 13.5–16 person-days (plan: 10.5–13.5 — `services/agent` is 22.2k, not 15.2k; shell/settings/status bar/storage are rewrites).

## 8. Owner questions — defaults taken (2026-10-08)

1. Entry scene key: `defaultExportScenePath` (the manifest's real key), fallback `scenes/main.pix3scene`. Plan text says `entryScene`.
2. `lit`/`yaml` external (D9), not inlined as §A.3 says.
3. `resRoot ≠ '.'`: `pix3project.yaml` and script dirs root-relative. Confirm on DeepCore migration.
4. Editor images served from the editor-core package dir, not `/__pix3/assets/` (D11).
5. `WorkspaceClient` dropped (D5) vs §C.5 KEEP.
6. Idle-timer save in `SceneWriteService` added now (1.5 s / ≤10 s, never during a gesture).
7. Image-gen keys per-project in local storage until the plugin proxy.
8. Export UI absent in alpha.1 until P2 (D14).
9. Script re-registration does not re-instantiate live components; `applySync` reloads clean scenes only when the scene file changed — revisit after M3.
10. Two tabs: minimal Web Locks now; full §C.3 hand-over with changeset-tx.
11. `kit.spec.ts` frozen tool list is a stopgap until the kit rewrite.
12. `emoji-as-art.ts` path in AGENTS.md changes.
13. happy-dom + golden-layout in `LayoutManager.spec` may need stubs.
14. `scene-nodes-dts.ts` kept; revisit if only `pix3 kit` consumes it.
15. No HMR for editor-core by design (variant B): watch build + tab reload.

## Progress

- 2026-10-08: snapshot F.1 explicit drops done (88 files). M0 done: `AppState` trimmed to the 2.x shape, `host/EditorHost.ts`, `HostService` (res ↔ wire paths), `host/testing/fake-host.ts`, `ProjectStorageService` over `host.files`, `SceneWriteService` (save, flushDirty, idle timer). Lanes B and C started.
- 2026-10-09: M1 done — editor-core compiles (0 errors), is linted and type-checked by the root scripts, and its specs run with the rest (282 files / 3322 tests green). Lane A: `ProjectService` 1887 → ~890 with `openHostProject`, write path without coauthoring (server `If-Match`), Save As by project path (`window.prompt` placeholder — a proper path dialog is debt), frame-driven external changes (`ExternalReloadService`), `WriterService` (Web Locks + claim), `SyncApplyService`, bridge v1 (`host/debug-bridge.ts`), `mountEditor`. Lane B: shell 2158 → 772, settings 2455 → 725, status bar 985 → 333, host banner, history panel, image-gen via proxy. Lane C: script loader 944 → 180 (`registerRoots`/`queueRoots`), `ModuleBotStore`, `services/game-test`, `services/export` removed, `playOwner` via `SetPlayModeOperation`. Next: M2 (dist build, plugin implements `EditorHost`, mount in a real project).
- Debt noted during M1: Save As path dialog; `OpenProjectInIdeCommand` → `host.openInEditor`; inspector guesses `scripts/<Export>.ts` for a script's source (loader could expose id → file); six specs still mock golden-layout (tslib is installed now, the mocks can go); `core/agent-introspection.clearScriptBuildErrors` unused.

