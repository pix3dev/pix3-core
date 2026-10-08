/**
 * What the editor needs from whoever mounts it (plan §A.1 `mountEditor(el, host: EditorHost)`).
 *
 * Types only, no imports: `@pix3/vite-plugin` implements it (`EditorHostConnection`) and imports
 * this file `import type` through a tsconfig path, so the edge between the packages carries no
 * runtime code. Wire paths are POSIX and relative to the Vite root; `res://` mapping is the
 * editor's job (`HostService`).
 */

export interface EditorHost {
  readonly info: HostInfo;
  readonly files: HostFiles;
  readonly events: HostEvents;
  readonly scripts: HostScripts;
  readonly sync: HostSync;
  readonly writer: HostWriter;
  /** Playable build from the editor (plan §B.6); absent until the plugin ships it. */
  readonly build?: HostBuild;
  /** Open a project file in the user's code editor (Vite's `/__open-in-editor`). */
  openInEditor?(path: string, line?: number): Promise<void>;
}

export interface HostVersions {
  readonly plugin: string;
  readonly runtime: string | null;
  readonly editorCore: string | null;
  readonly vite: string;
}

export interface HostInfo {
  /** Vite `base`, always ending with `/`. */
  readonly base: string;
  /** Absolute project root on the dev server's machine (display only). */
  readonly root: string;
  /** Where `res://` points, relative to the root (`'.'` by default). */
  readonly resRoot: string;
  readonly projectName: string;
  readonly tabId: string;
  /** File-table `seq` and `revision` when this tab connected. */
  readonly seq: number;
  readonly revision: string;
  readonly versions: HostVersions;
}

export interface HostFileStat {
  readonly sha256: string;
  readonly size: number;
  readonly mtime?: number;
}

export interface HostWriteResult extends HostFileStat {
  readonly path: string;
  readonly seq: number;
}

export interface HostWriteOptions {
  /** sha256 the file must still have (`'*'` = must exist); a mismatch fails with `base_mismatch`. */
  readonly ifMatch?: string;
  /** Fail with `exists` if the file is already there. */
  readonly createOnly?: boolean;
  /** Retry key: the same id is applied at most once per dev-server session. */
  readonly mutationId?: string;
}

export type HostFileErrorCode =
  | 'not_found'
  | 'base_mismatch'
  | 'exists'
  | 'writer_superseded'
  | 'reserved_path'
  | 'bad_path'
  | 'not_a_file'
  | 'not_empty'
  | 'forbidden'
  | 'network'
  | 'other';

export interface HostFileFailure {
  readonly code: HostFileErrorCode;
  readonly status: number;
  /** The disk's sha256 when a conditional write was refused (`null` = no file). */
  readonly currentHash?: string | null;
  readonly message: string;
}

export interface HostManifestEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly size: number;
  readonly mtime: number;
  readonly sha256?: string;
}

/**
 * The project's files through the dev server. Failing calls reject with an `Error` that carries
 * a {@link HostFileFailure} as `failure` (see {@link hostFailureOf}).
 */
export interface HostFiles {
  /** Bytes and their sha256, or null when the file does not exist. */
  read(path: string): Promise<{ readonly bytes: Uint8Array; readonly sha256: string } | null>;
  readText(path: string): Promise<string | null>;
  head(path: string): Promise<HostFileStat | null>;
  write(
    path: string,
    data: Uint8Array | string,
    options?: HostWriteOptions
  ): Promise<HostWriteResult>;
  mkdir(path: string): Promise<void>;
  delete(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  move(from: string, to: string, options?: { readonly overwrite?: boolean }): Promise<void>;
  manifest(): Promise<{
    readonly revision: string;
    readonly seq: number;
    readonly files: readonly HostManifestEntry[];
  }>;
  hash(paths: readonly string[]): Promise<Record<string, string | null>>;
  /** Browser URL of a project file for `<img>`/`TextureLoader` (Vite serves the root). */
  url(path: string): string;
}

export interface HostFsEvent {
  readonly op: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly sha256?: string;
  /** Only on `rename`: where the file was. */
  readonly from?: string;
  /** `editor` when the bytes are the plugin's last write of that path. */
  readonly author: 'editor' | 'external';
}

export interface HostFsFrame {
  readonly seq: number;
  readonly revision: string;
  readonly events: readonly HostFsEvent[];
  /** The writer tab whose API write produced this batch. */
  readonly writerId?: string;
}

export type Unsubscribe = () => void;

export interface HostEvents {
  onFs(listener: (frame: HostFsFrame) => void): Unsubscribe;
  onConnection(listener: (state: 'open' | 'closed') => void): Unsubscribe;
}

export interface RootModule {
  readonly __pix3Revision: number;
  /** Glob keys (`/scripts/Foo.ts`) → module namespaces. */
  readonly modules: Record<string, Record<string, unknown>>;
}

export interface ScriptRoots {
  readonly editorScripts: RootModule;
  readonly botPolicies: RootModule;
}

export interface HostScripts {
  current(): ScriptRoots;
  /** The roots were re-imported outside a sync (a script changed on disk). */
  onChange(listener: (roots: ScriptRoots) => void): Unsubscribe;
}

export type HookReply = { readonly ok: boolean; readonly reason?: string } & Record<
  string,
  unknown
>;

export interface SyncInfo {
  readonly rev: number;
  /** `{path: sha256 | null}` the rescan found changed (`null` = deleted). */
  readonly changed: Record<string, string | null>;
  readonly roots: ScriptRoots;
}

export interface HostSyncHandlers {
  /** Write dirty scenes now; wait for pointerup up to `timeoutMs` (plan §B.3 step 0). */
  flush?(timeoutMs: number): Promise<HookReply>;
  /**
   * The roots were re-imported for a sync: register scripts, reload changed scenes. While play
   * runs, answer `{ok:false, reason:'stale', playing, pending}`.
   */
  applySync?(info: SyncInfo): Promise<HookReply>;
}

export interface HostSync {
  setHandlers(handlers: HostSyncHandlers): void;
  /** `pix3_sync` from this tab: flush, then the plugin's barrier with this tab confirming. */
  run(options?: {
    readonly expect?: Record<string, string>;
    readonly timeoutMs?: number;
  }): Promise<HookReply>;
}

export interface HostClaim {
  readonly writerId: string;
  readonly seq: number;
  readonly revision: string;
  readonly hashes: Record<string, string>;
}

export interface HostWriter {
  /** The tab currently allowed to write, or null when none has claimed. */
  readonly id: string | null;
  readonly isSelf: boolean;
  /** Become the writer (plan §C.3): the plugin answers with the disk to start from. */
  claim(): Promise<HostClaim>;
  onChange(listener: (writerId: string | null) => void): Unsubscribe;
}

export interface HostBuild {
  run(options: {
    readonly format: 'html' | 'zip';
    readonly compress?: boolean;
    readonly entryScene?: string;
  }): Promise<{ readonly path: string; readonly bytes: number; readonly sha256: string }>;
}

/** The {@link HostFileFailure} a host call rejected with, or null for any other error. */
export const hostFailureOf = (error: unknown): HostFileFailure | null => {
  if (!error || typeof error !== 'object' || !('failure' in error)) return null;
  const failure = (error as { failure: unknown }).failure;
  return failure && typeof failure === 'object' && 'code' in failure
    ? (failure as HostFileFailure)
    : null;
};
