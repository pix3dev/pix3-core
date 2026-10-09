import { inject, injectable, ServiceContainer } from '@/fw/di';
import { hostFailureOf, type HostFsFrame, type HostManifestEntry } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import { appState } from '@/state';

import type { FileDescriptor } from './file-descriptor';
import { ReadOnlyTabError, SceneWriteConflictError } from './write-errors';

export type { FileDescriptor } from './file-descriptor';
export type StorageBackendKind = 'host';

/**
 * The project's files for the editor (plan §F.1 `ProjectStorageService` → ~250), over
 * `EditorHost.files`. Paths are project paths (`res://` optional); `HostService` maps them to the
 * plugin's wire paths. Listings come from the plugin's manifest, cached and patched by `pix3:fs`
 * frames; every write is conditional on the hash this editor last saw (`If-Match`).
 */
@injectable()
export class ProjectStorageService {
  @inject(HostService)
  private readonly hostService!: HostService;

  /** Wire path → manifest entry; null until first needed. */
  private manifest: Map<string, HostManifestEntry> | null = null;
  private manifestLoad: Promise<void> | null = null;
  /** Wire path → sha256 of the bytes this editor last read or wrote. */
  private readonly knownHashes = new Map<string, string>();
  private unsubscribeFs: (() => void) | null = null;
  /** Open {@link batchMutations} scopes; while > 0 listing refresh signals are coalesced. */
  private mutationBatchDepth = 0;
  private batchedDirectories: string[] = [];

  getBackend(): StorageBackendKind {
    return 'host';
  }

  private get files() {
    return this.hostService.host.files;
  }

  private wire(path: string): string {
    return this.hostService.wirePath(path);
  }

  normalizeResourcePath(path: string): string {
    return HostService.normalize(path);
  }

  // --- Manifest ------------------------------------------------------------------------------

  private async ensureManifest(): Promise<Map<string, HostManifestEntry>> {
    if (!this.unsubscribeFs) {
      this.unsubscribeFs = this.hostService.host.events.onFs(frame => this.applyFrame(frame));
    }
    if (this.manifest) return this.manifest;
    this.manifestLoad ??= this.refreshManifest();
    await this.manifestLoad;
    return this.manifest ?? new Map();
  }

  async refreshManifest(): Promise<void> {
    const { files } = await this.files.manifest();
    this.manifest = new Map(files.map(entry => [entry.path, entry]));
    this.manifestLoad = null;
  }

  /** Patch the cached manifest from a `pix3:fs` frame and signal the asset browser. */
  applyFrame(frame: HostFsFrame): void {
    const manifest = this.manifest;
    const directories: string[] = [];
    for (const event of frame.events) {
      const parent = (path: string): string => {
        const slash = path.lastIndexOf('/');
        return slash < 0 ? '.' : path.slice(0, slash);
      };
      if (event.op === 'delete' || event.op === 'rename') {
        const gone = event.op === 'rename' ? (event.from ?? '') : event.path;
        if (manifest) {
          for (const key of [...manifest.keys()]) {
            if (key === gone || key.startsWith(`${gone}/`)) manifest.delete(key);
          }
        }
        this.knownHashes.delete(gone);
        directories.push(parent(gone));
      }
      if (event.op !== 'delete') {
        manifest?.set(event.path, {
          path: event.path,
          kind: event.kind,
          size: manifest.get(event.path)?.size ?? 0,
          mtime: Date.now(),
          ...(event.sha256 ? { sha256: event.sha256 } : {}),
        });
        directories.push(parent(event.path));
      }
    }
    const projectDirs = directories
      .map(dir => (dir === '.' ? '.' : this.hostService.projectPath(dir)))
      .filter((dir): dir is string => dir !== null && !dir.startsWith('.pix3'));
    if (projectDirs.length > 0) this.signalDirectories(projectDirs);
  }

  // --- Reads ---------------------------------------------------------------------------------

  async listDirectory(path = '.'): Promise<FileDescriptor[]> {
    const manifest = await this.ensureManifest();
    const dir = this.wire(path);
    const entries: FileDescriptor[] = [];
    for (const entry of manifest.values()) {
      const relative =
        dir === '.'
          ? entry.path
          : entry.path.startsWith(`${dir}/`)
            ? entry.path.slice(dir.length + 1)
            : null;
      if (!relative || relative.includes('/')) continue;
      const projectPath = this.hostService.projectPath(entry.path);
      if (projectPath === null) continue;
      entries.push({
        name: relative,
        kind: entry.kind === 'dir' ? 'directory' : 'file',
        path: projectPath,
        size: entry.kind === 'file' ? entry.size : null,
      });
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readTextFile(path: string): Promise<string> {
    const read = await this.files.read(this.wire(path));
    if (!read) throw new Error(`File not found: ${HostService.normalize(path)}`);
    this.knownHashes.set(this.wire(path), read.sha256);
    return new TextDecoder().decode(read.bytes);
  }

  async readBlob(path: string): Promise<Blob> {
    const read = await this.files.read(this.wire(path));
    if (!read) throw new Error(`File not found: ${HostService.normalize(path)}`);
    this.knownHashes.set(this.wire(path), read.sha256);
    return new Blob([read.bytes as BlobPart]);
  }

  /** Whether a FILE exists at `path` (directories answer false). */
  async fileExists(path: string): Promise<boolean> {
    return (await this.ensureManifest()).get(this.wire(path))?.kind === 'file';
  }

  async getLastModified(path: string): Promise<number | null> {
    return (await this.ensureManifest()).get(this.wire(path))?.mtime ?? null;
  }

  /** sha256 of the bytes this editor last read or wrote at `path`, or null. */
  getKnownContentHash(path: string): string | null {
    return this.knownHashes.get(this.wire(path)) ?? null;
  }

  /**
   * sha256 of `path` in the cached manifest (the disk as of the last scan plus pushed frames).
   * `undefined` before the manifest loaded or when it carries no hash; `null` when there is no file.
   */
  getManifestContentHash(path: string): string | null | undefined {
    if (!this.manifest) return undefined;
    const entry = this.manifest.get(this.wire(path));
    if (!entry || entry.kind !== 'file') return null;
    return entry.sha256 ?? undefined;
  }

  /** sha256 → project paths (sorted) of every file in the manifest, `.pix3/` excluded. */
  async getContentHashIndex(): Promise<ReadonlyMap<string, readonly string[]>> {
    const index = new Map<string, string[]>();
    const entries = [...(await this.ensureManifest()).values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
    for (const entry of entries) {
      const projectPath = this.hostService.projectPath(entry.path);
      if (entry.kind !== 'file' || !entry.sha256 || !projectPath || projectPath.startsWith('.pix3'))
        continue;
      const paths = index.get(entry.sha256);
      if (paths) paths.push(projectPath);
      else index.set(entry.sha256, [projectPath]);
    }
    return index;
  }

  // --- Writes --------------------------------------------------------------------------------

  /**
   * `options.baseHash`: the `If-Match` base instead of the last hash this editor saw — a scene save
   * passes the version it accepted into its graph. `options.unconditional`: no base at all, only
   * for files the editor owns outright.
   */
  /** Resolves to the sha256 of the bytes written (the plugin's hash of what is on disk now). */
  async writeTextFile(
    path: string,
    contents: string,
    options: { readonly unconditional?: boolean; readonly baseHash?: string } = {}
  ): Promise<string> {
    return this.write(path, contents, options);
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.write(path, new Uint8Array(data), {});
  }

  private async write(
    path: string,
    data: Uint8Array | string,
    options: { readonly unconditional?: boolean; readonly baseHash?: string }
  ): Promise<string> {
    const wirePath = this.wire(path);
    const base = options.unconditional
      ? undefined
      : (options.baseHash ?? this.knownHashes.get(wirePath));
    let sha: string;
    try {
      const result = await this.files.write(wirePath, data, base ? { ifMatch: base } : {});
      sha = result.sha256;
      this.knownHashes.set(wirePath, sha);
    } catch (error) {
      throw this.translate(wirePath, error);
    }
    this.signalDirectories([this.parentOf(HostService.normalize(path))]);
    return sha;
  }

  async deleteEntry(path: string): Promise<void> {
    const wirePath = this.wire(path);
    try {
      await this.files.delete(wirePath, { recursive: true });
    } catch (error) {
      throw this.translate(wirePath, error);
    }
    this.knownHashes.delete(wirePath);
    const normalized = HostService.normalize(path);
    this.signalDirectories([this.parentOf(normalized), normalized]);
  }

  async createDirectory(path: string): Promise<void> {
    try {
      await this.files.mkdir(this.wire(path));
    } catch (error) {
      throw this.translate(this.wire(path), error);
    }
    const normalized = HostService.normalize(path);
    this.signalDirectories([this.parentOf(normalized), normalized]);
  }

  async moveEntry(sourcePath: string, targetPath: string): Promise<void> {
    const from = this.wire(sourcePath);
    const to = this.wire(targetPath);
    if (from === to) return;
    try {
      await this.files.move(from, to);
    } catch (error) {
      throw this.translate(from, error);
    }
    const known = this.knownHashes.get(from);
    this.knownHashes.delete(from);
    if (known) this.knownHashes.set(to, known);
    this.signalDirectories([
      this.parentOf(HostService.normalize(sourcePath)),
      this.parentOf(HostService.normalize(targetPath)),
    ]);
  }

  /**
   * Run `fn` with asset-listing refresh signals coalesced: every write still lands immediately,
   * but the asset browser refreshes once when the outermost batch settles.
   */
  async batchMutations<T>(fn: () => Promise<T>): Promise<T> {
    this.mutationBatchDepth += 1;
    try {
      return await fn();
    } finally {
      this.mutationBatchDepth -= 1;
      if (this.mutationBatchDepth === 0 && this.batchedDirectories.length > 0) {
        const directories = this.batchedDirectories;
        this.batchedDirectories = [];
        this.signalDirectories(directories);
      }
    }
  }

  dispose(): void {
    this.unsubscribeFs?.();
    this.unsubscribeFs = null;
  }

  // --- Helpers -------------------------------------------------------------------------------

  private translate(wirePath: string, error: unknown): Error {
    const failure = hostFailureOf(error);
    if (failure?.code === 'base_mismatch' || failure?.code === 'exists') {
      return new SceneWriteConflictError(wirePath, failure);
    }
    if (failure?.code === 'writer_superseded') return new ReadOnlyTabError();
    return error instanceof Error ? error : new Error(String(error));
  }

  private signalDirectories(directories: readonly string[]): void {
    if (directories.length > 0 && directories.every(dir => dir.startsWith('.pix3'))) return;
    if (this.mutationBatchDepth > 0) {
      this.batchedDirectories.push(...directories);
      return;
    }
    const unique = [...new Set(directories)];
    appState.project.lastModifiedDirectoryPath = unique.length === 1 ? unique[0] : '.';
    appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
  }

  private parentOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '.' : path.slice(0, slash);
  }
}

export const resolveProjectStorageService = (): ProjectStorageService =>
  ServiceContainer.getInstance().getService<ProjectStorageService>(
    ServiceContainer.getInstance().getOrCreateToken(ProjectStorageService)
  );
