import { isResourceGraphPath } from '@/core/asset-categories';
import { inject, injectable, ServiceContainer } from '@/fw/di';
import { HostService } from '@/host/HostService';
import { appState, type AssetBrowserViewMode } from '@/state';
import {
  groupedDirectoryExpansionKey,
  splitGroupedDirectoryExpansionKey,
} from '@/core/asset-categories';
import type { FileDescriptor } from '@/services/project/file-descriptor';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { sha256 } from '@/services/project/external-merge/hash';
import { parse, stringify } from 'yaml';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ref } from 'valtio/vanilla';
import {
  createDefaultProjectManifest,
  createProjectId,
  getProjectId,
  normalizeProjectManifest,
  withProjectId,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import {
  SceneManager,
  loadProjectFonts,
  setProjectAODefault,
  setProjectTextureFiltering,
  type SceneGraph,
} from '@pix3/runtime';

const PROJECT_MANIFEST_PATH = 'pix3project.yaml';
const ASSET_BROWSER_STORAGE_PREFIX = 'pix3.assetBrowser:v1:';

export interface AssetBrowserPersistedState {
  expandedPaths: string[];
  selectedPath: string | null;
  viewMode: AssetBrowserViewMode;
  groupedExpandedKeys: string[];
  /** Assets content-pane thumbnail tile size in px. */
  thumbnailSize?: number;
  /** Assets content-pane layout: thumbnail grid or details list. */
  contentView?: 'grid' | 'list';
  /** Width in px of the unified Assets panel's folder-tree pane (Phase 4). */
  treePaneWidth?: number;
  /**
   * Render managed sprite folders (one `.pix3anim` + its frames) as a single
   * sprite card instead of a folder. Defaults to true.
   */
  collapseSpriteFolders?: boolean;
}

/**
 * The open project (plan §F.1 `ProjectService` → ~1 100, boot from `host.info`): there is exactly
 * one, the dev server's, opened by {@link ProjectService.openHostProject} when the editor mounts.
 * Owns the manifest (`pix3project.yaml`), the asset browser's per-project UI state, and the
 * path rewrites that keep scenes and the manifest pointing at moved files.
 */
@injectable()
export class ProjectService {
  static readonly STARTUP_SCENE_PATH = 'scenes/main.pix3scene';
  static readonly STARTUP_SCENE_RESOURCE_PATH = `res://${ProjectService.STARTUP_SCENE_PATH}`;

  @inject(HostService)
  private readonly hostService!: HostService;

  private get storage(): ProjectStorageService {
    return ServiceContainer.getInstance().getService<ProjectStorageService>(
      ServiceContainer.getInstance().getOrCreateToken(ProjectStorageService)
    );
  }

  /**
   * sha256 of the `pix3project.yaml` bytes the editor last read or wrote (null: none read). The
   * sync barrier re-reads the manifest when the disk holds another one.
   */
  private loadedManifestHash: string | null = null;

  /**
   * Open the dev server's project: read (and id-backfill) the manifest, publish it to `appState`.
   * The entry scene is `defaultExportScenePath` (plan text says `entryScene`; the manifest key is
   * `defaultExportScenePath` — `.plans/editor-core-port.md` §8.1), else `scenes/main.pix3scene`.
   */
  async openHostProject(): Promise<void> {
    const info = this.hostService.info;
    appState.project.status = 'opening';
    appState.project.backend = 'host';
    appState.project.projectName = info.projectName;
    appState.project.localAbsolutePath = info.root;
    appState.project.errorMessage = null;
    try {
      const manifest = await this.loadManifestOnOpen();
      appState.project.id = getProjectId(manifest) ?? (await sha256(info.root));
      appState.project.manifest = manifest;
      const persisted = this.loadAssetBrowserState();
      if (persisted) {
        appState.project.assetBrowserExpandedPaths = persisted.expandedPaths;
        appState.project.assetBrowserSelectedPath = persisted.selectedPath;
        appState.project.assetBrowserViewMode = persisted.viewMode;
        appState.project.assetBrowserGroupedExpandedKeys = persisted.groupedExpandedKeys;
        appState.project.assetsThumbnailSize = persisted.thumbnailSize ?? 104;
        appState.project.assetsContentView = persisted.contentView ?? 'grid';
      }
      appState.project.lastOpenedScenePath = this.entryScenePath(manifest);
      appState.project.status = 'ready';
    } catch (error) {
      appState.project.status = 'error';
      appState.project.errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** `res://` path of the scene the editor opens first. */
  entryScenePath(manifest: ProjectManifest | null = appState.project.manifest): string {
    const path = manifest?.defaultExportScenePath || ProjectService.STARTUP_SCENE_PATH;
    return `res://${path.replace(/^res:\/\//i, '')}`;
  }

  saveAssetBrowserState(patch: Partial<AssetBrowserPersistedState>): void {
    const projectId = appState.project.id;
    if (!projectId) return;

    try {
      const key = `${ASSET_BROWSER_STORAGE_PREFIX}${projectId}`;
      const current = this.loadAssetBrowserState();
      const state = {
        expandedPaths: patch.expandedPaths ?? current?.expandedPaths ?? [],
        selectedPath:
          patch.selectedPath !== undefined ? patch.selectedPath : (current?.selectedPath ?? null),
        viewMode: patch.viewMode ?? current?.viewMode ?? 'folders',
        groupedExpandedKeys: patch.groupedExpandedKeys ?? current?.groupedExpandedKeys ?? [],
        thumbnailSize: patch.thumbnailSize ?? current?.thumbnailSize ?? 104,
        contentView: patch.contentView ?? current?.contentView ?? 'grid',
        treePaneWidth: patch.treePaneWidth ?? current?.treePaneWidth,
        collapseSpriteFolders:
          patch.collapseSpriteFolders ?? current?.collapseSpriteFolders ?? true,
        savedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Loads asset browser state from localStorage. Returns null if no state is
   * saved for the current project; legacy records get defaults for new fields.
   */
  loadAssetBrowserState(): AssetBrowserPersistedState | null {
    const projectId = appState.project.id;
    if (!projectId) return null;

    try {
      const key = `${ASSET_BROWSER_STORAGE_PREFIX}${projectId}`;
      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      return {
        expandedPaths: Array.isArray(parsed.expandedPaths) ? parsed.expandedPaths : [],
        selectedPath: typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null,
        viewMode: parsed.viewMode === 'by-type' ? 'by-type' : 'folders',
        groupedExpandedKeys: Array.isArray(parsed.groupedExpandedKeys)
          ? parsed.groupedExpandedKeys.filter(
              (entry: unknown): entry is string => typeof entry === 'string'
            )
          : [],
        thumbnailSize:
          typeof parsed.thumbnailSize === 'number' && Number.isFinite(parsed.thumbnailSize)
            ? parsed.thumbnailSize
            : 104,
        contentView: parsed.contentView === 'list' ? 'list' : 'grid',
        treePaneWidth:
          typeof parsed.treePaneWidth === 'number' && Number.isFinite(parsed.treePaneWidth)
            ? parsed.treePaneWidth
            : undefined,
        collapseSpriteFolders:
          typeof parsed.collapseSpriteFolders === 'boolean' ? parsed.collapseSpriteFolders : true,
      };
    } catch {
      return null;
    }
  }

  async listProjectRoot(): Promise<FileDescriptor[]> {
    try {
      return await this.storage.listDirectory('.');
    } catch {
      return [];
    }
  }

  async createDirectory(path: string): Promise<void> {
    await this.storage.createDirectory(path);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.storage.writeTextFile(path, contents);
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.storage.writeBinaryFile(path, data);
  }

  async deleteEntry(path: string): Promise<void> {
    await this.storage.deleteEntry(path);
  }

  listDirectory(path = '.'): Promise<FileDescriptor[]> {
    return this.storage.listDirectory(path);
  }

  async moveItem(sourcePath: string, targetPath: string): Promise<void> {
    const normalizedSourcePath = this.normalizeProjectPath(sourcePath);
    const normalizedTargetPath = this.normalizeProjectPath(targetPath);

    if (
      !normalizedSourcePath ||
      normalizedSourcePath === '.' ||
      !normalizedTargetPath ||
      normalizedTargetPath === '.'
    ) {
      throw new Error('Invalid source or target path');
    }

    if (normalizedSourcePath === normalizedTargetPath) {
      return;
    }

    const sourceEntry = await this.getProjectEntry(normalizedSourcePath);
    if (!sourceEntry) {
      throw new Error(`Source entry not found: ${sourcePath}`);
    }

    if (
      sourceEntry.kind === 'directory' &&
      normalizedTargetPath.startsWith(`${normalizedSourcePath}/`)
    ) {
      throw new Error('Cannot move a directory into itself.');
    }

    try {
      await this.storage.moveEntry(normalizedSourcePath, normalizedTargetPath);
      await this.updateProjectReferencesAfterMove(
        normalizedSourcePath,
        normalizedTargetPath,
        sourceEntry.kind
      );
    } catch (error) {
      console.error('[ProjectService] Error moving item:', error);
      throw error;
    }
  }

  async loadProjectManifest(): Promise<ProjectManifest> {
    try {
      // Ask the listing first: a project without a manifest is normal, and a blind read would be
      // a 404 in the browser console on every open.
      if (!(await this.storage.fileExists(PROJECT_MANIFEST_PATH))) {
        throw new Error('no manifest');
      }
      const yaml = await this.storage.readTextFile(PROJECT_MANIFEST_PATH);
      this.loadedManifestHash = await this.manifestHashOf(yaml);
      const parsed = parse(yaml);
      const manifest = normalizeProjectManifest(parsed);
      // Push the project-tier AO default so scenes set to `inherit` resolve it.
      setProjectAODefault(manifest.ambientOcclusion);
      // Push the 2D texture filtering mode so texture loads pick it up.
      setProjectTextureFiltering(manifest.textureFiltering);
      // Register the project's web fonts with the document. The editor draws its own canvas
      // text for the viewport proxies, so without this a label in a project family reads in a
      // system substitute in the editor while the game (which loads them in `SceneRunner`)
      // draws it correctly — the two would disagree on the same scene.
      void loadProjectFonts(manifest.fonts, {
        readBlob: (resourcePath: string) =>
          this.storage.readBlob(resourcePath.replace(/^res:\/\//, '')),
      }).then(report => {
        if (report.failed.length > 0) {
          console.warn(
            `[ProjectService] ${report.failed.length} project font(s) could not be registered.`
          );
        }
      });
      return manifest;
    } catch {
      this.loadedManifestHash = null;
      const fallback = createDefaultProjectManifest();
      setProjectAODefault(fallback.ambientOcclusion);
      setProjectTextureFiltering(fallback.textureFiltering);
      return fallback;
    }
  }

  /**
   * The manifest of a local/browser project being opened, with `metadata.projectId` backfilled.
   *
   * Projects created before the editor minted ids (or by hand) have none; the first open writes one
   * — once, since the next open finds it. Only an existing `pix3project.yaml` is touched: a folder
   * without one is not silently turned into a project here. Best-effort: a read-only folder still
   * opens, just without a stable id this session.
   */
  private async loadManifestOnOpen(): Promise<ProjectManifest> {
    const manifest = await this.loadProjectManifest();
    if (getProjectId(manifest) !== null) {
      return manifest;
    }
    if (!(await this.storage.fileExists(PROJECT_MANIFEST_PATH))) {
      return manifest;
    }
    const withId = withProjectId(manifest, createProjectId());
    try {
      await this.saveProjectManifest(withId);
      return normalizeProjectManifest(withId);
    } catch (error) {
      console.warn('[ProjectService] Could not backfill metadata.projectId', error);
      return manifest;
    }
  }

  async saveProjectManifest(manifest: ProjectManifest): Promise<void> {
    const normalized = normalizeProjectManifest(manifest);
    const payload = {
      version: normalized.version,
      defaultExportScenePath: normalized.defaultExportScenePath,
      viewportBaseSize: {
        width: normalized.viewportBaseSize.width,
        height: normalized.viewportBaseSize.height,
      },
      ambientOcclusion: normalized.ambientOcclusion,
      textureFiltering: normalized.textureFiltering,
      projectType: normalized.projectType,
      targetPlatform: normalized.targetPlatform,
      quality: {
        antialias: normalized.quality.antialias,
        shadows: normalized.quality.shadows,
        maxPixelRatio: normalized.quality.maxPixelRatio,
      },
      // Only emit the block when localization is configured (absent ⇒ inert).
      ...(normalized.localization
        ? {
            localization: {
              defaultLocale: normalized.localization.defaultLocale,
              ...(normalized.localization.fallbackLocale
                ? { fallbackLocale: normalized.localization.fallbackLocale }
                : {}),
              locales: [...normalized.localization.locales],
            },
          }
        : {}),
      // Only emit the block when the project actually ships fonts.
      ...(normalized.fonts && normalized.fonts.length > 0
        ? {
            fonts: normalized.fonts.map(face => ({
              family: face.family,
              path: face.path,
              weight: face.weight,
              style: face.style,
              ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
            })),
          }
        : {}),
      metadata: normalized.metadata ?? {},
      autoloads: normalized.autoloads.map(entry => ({
        scriptPath: entry.scriptPath,
        singleton: entry.singleton,
        enabled: entry.enabled,
      })),
    };
    const yaml = stringify(payload, { indent: 2 });
    await this.storage.writeTextFile(PROJECT_MANIFEST_PATH, yaml);
    this.loadedManifestHash = await this.manifestHashOf(yaml);
    appState.project.manifest = normalized;
  }

  /** sha256 of the manifest bytes the editor last read or wrote (see `loadedManifestHash`). */
  getLoadedManifestHash(): string | null {
    return this.loadedManifestHash;
  }

  /** Re-read `pix3project.yaml` into `appState.project.manifest` (it changed on disk). */
  async reloadProjectManifest(): Promise<void> {
    appState.project.manifest = await this.loadProjectManifest();
  }

  /** The workspace ETag of the exchange that just happened (the exact bytes), else the text's hash. */
  private async manifestHashOf(yaml: string): Promise<string | null> {
    try {
      return this.storage.getKnownContentHash?.(PROJECT_MANIFEST_PATH) ?? (await sha256(yaml));
    } catch {
      return null;
    }
  }

  private async updateProjectReferencesAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const projectFiles = await this.listAllProjectFiles('.');
    await this.rewriteSceneFilesAfterMove(projectFiles, sourcePath, targetPath, movedKind);
    await this.updateProjectManifestAfterMove(sourcePath, targetPath, movedKind);
    await this.updateOpenScenesAfterMove(sourcePath, targetPath, movedKind);
    this.updateProjectStatePathsAfterMove(sourcePath, targetPath, movedKind);

    const editorTabService = ServiceContainer.getInstance().getService<EditorTabService>(
      ServiceContainer.getInstance().getOrCreateToken(EditorTabService)
    );
    editorTabService.remapSceneTabs(resourcePath =>
      this.remapResourcePath(resourcePath, sourcePath, targetPath, movedKind)
    );

    appState.project.lastModifiedDirectoryPath = '.';
    appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
  }

  private async rewriteSceneFilesAfterMove(
    projectFiles: FileDescriptor[],
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    // Every resource whose text lists `res://` paths — scenes, prefabs AND `.pix3anim`
    // flipbooks (one table with publish/export/insert: `RESOURCE_GRAPH_EXTENSIONS`).
    // Scanning only `.pix3scene` left a moved frame folder dangling from its flipbook.
    const sceneFiles = projectFiles.filter(
      entry => entry.kind === 'file' && isResourceGraphPath(entry.path)
    );

    for (const sceneFile of sceneFiles) {
      const contents = await this.storage.readTextFile(sceneFile.path);
      const nextContents = this.rewriteResourceReferencesInText(
        contents,
        sourcePath,
        targetPath,
        movedKind
      );

      if (nextContents !== contents) {
        await this.storage.writeTextFile(sceneFile.path, nextContents);
      }
    }
  }

  private async updateProjectManifestAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const manifest = await this.loadProjectManifest();
    const nextMetadata = this.rewriteUnknownValuePaths(manifest.metadata ?? {}, value =>
      this.remapResourcePath(value, sourcePath, targetPath, movedKind)
    ) as ProjectManifest['metadata'];

    let didChange = nextMetadata !== (manifest.metadata ?? {});
    const nextDefaultExportScenePath =
      this.remapProjectPath(manifest.defaultExportScenePath, sourcePath, targetPath, movedKind) ??
      manifest.defaultExportScenePath;
    if (nextDefaultExportScenePath !== manifest.defaultExportScenePath) {
      didChange = true;
    }
    const nextAutoloads = manifest.autoloads.map(entry => {
      const nextScriptPath =
        this.remapProjectPath(entry.scriptPath, sourcePath, targetPath, movedKind) ??
        entry.scriptPath;
      if (nextScriptPath !== entry.scriptPath) {
        didChange = true;
      }

      return {
        ...entry,
        scriptPath: nextScriptPath,
      };
    });

    if (!didChange) {
      return;
    }

    await this.saveProjectManifest({
      ...manifest,
      defaultExportScenePath: nextDefaultExportScenePath,
      metadata: nextMetadata,
      autoloads: nextAutoloads,
    });
  }

  private async updateOpenScenesAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const sceneManager = ServiceContainer.getInstance().getService<SceneManager>(
      ServiceContainer.getInstance().getOrCreateToken(SceneManager)
    );

    const nextDescriptors: typeof appState.scenes.descriptors = {};
    const nextHierarchies: typeof appState.scenes.hierarchies = {};
    const nextEditorCameraStates: typeof appState.scenes.editorCameraStates = {};
    const nextNavigation2DCameraStates: typeof appState.scenes.navigation2DCameraStates = {};
    let nextActiveSceneId = appState.scenes.activeSceneId;

    for (const [sceneId, descriptor] of Object.entries(appState.scenes.descriptors)) {
      const nextFilePath =
        this.remapResourcePath(descriptor.filePath, sourcePath, targetPath, movedKind) ??
        descriptor.filePath;
      const nextSceneId = this.deriveSceneIdFromResource(nextFilePath);
      const graph = sceneManager.getSceneGraph(sceneId);
      const updatedGraph = graph
        ? await this.rewriteSceneGraphPaths(
            graph,
            descriptor.filePath,
            nextFilePath,
            sourcePath,
            targetPath,
            movedKind
          )
        : null;

      let nextLastModifiedTime = descriptor.lastModifiedTime ?? null;

      try {
        nextLastModifiedTime = nextFilePath.startsWith('res://')
          ? await this.storage.getLastModified(nextFilePath)
          : null;
      } catch (error) {
        console.debug('[ProjectService] Failed to refresh scene handle after move', {
          nextFilePath,
          error,
        });
      }

      nextDescriptors[nextSceneId] = {
        ...descriptor,
        id: nextSceneId,
        filePath: nextFilePath,
        lastModifiedTime: nextLastModifiedTime,
      };

      const hierarchy = appState.scenes.hierarchies[sceneId];
      if (updatedGraph) {
        nextHierarchies[nextSceneId] = {
          version: updatedGraph.version ?? null,
          description: updatedGraph.description ?? null,
          rootNodes: ref(updatedGraph.rootNodes),
          metadata: updatedGraph.metadata ?? {},
        };
        sceneManager.setActiveSceneGraph(nextSceneId, updatedGraph);
      } else if (hierarchy) {
        nextHierarchies[nextSceneId] = hierarchy;
        const existingGraph = sceneManager.getSceneGraph(sceneId);
        if (existingGraph && nextSceneId !== sceneId) {
          sceneManager.setActiveSceneGraph(nextSceneId, existingGraph);
        }
      }

      if (appState.scenes.editorCameraStates[sceneId]) {
        nextEditorCameraStates[nextSceneId] = appState.scenes.editorCameraStates[sceneId];
      }

      if (appState.scenes.navigation2DCameraStates[sceneId]) {
        nextNavigation2DCameraStates[nextSceneId] =
          appState.scenes.navigation2DCameraStates[sceneId];
      }

      if (nextActiveSceneId === sceneId) {
        nextActiveSceneId = nextSceneId;
      }

      if (nextSceneId !== sceneId) {
        sceneManager.removeSceneGraph(sceneId);
      }
    }

    appState.scenes.descriptors = nextDescriptors;
    appState.scenes.hierarchies = nextHierarchies;
    appState.scenes.editorCameraStates = nextEditorCameraStates;
    appState.scenes.navigation2DCameraStates = nextNavigation2DCameraStates;
    appState.scenes.activeSceneId = nextActiveSceneId;

    if (nextActiveSceneId && nextDescriptors[nextActiveSceneId]) {
      const activeGraph = sceneManager.getSceneGraph(nextActiveSceneId);
      if (activeGraph) {
        SceneStateUpdater.updateHierarchyState(appState, nextActiveSceneId, activeGraph);
      }
      return;
    }

    const activeDescriptor = Object.values(nextDescriptors).find(
      descriptor => descriptor.filePath === appState.project.lastOpenedScenePath
    );
    if (activeDescriptor) {
      appState.scenes.activeSceneId = activeDescriptor.id;
      const activeGraph = sceneManager.getSceneGraph(activeDescriptor.id);
      if (activeGraph) {
        SceneStateUpdater.updateHierarchyState(appState, activeDescriptor.id, activeGraph);
      }
    }
  }

  private updateProjectStatePathsAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): void {
    appState.project.lastOpenedScenePath =
      this.remapResourcePath(
        appState.project.lastOpenedScenePath,
        sourcePath,
        targetPath,
        movedKind
      ) ?? appState.project.lastOpenedScenePath;

    appState.scenes.pendingScenePaths = appState.scenes.pendingScenePaths.map(
      filePath => this.remapResourcePath(filePath, sourcePath, targetPath, movedKind) ?? filePath
    );

    appState.project.assetBrowserExpandedPaths = appState.project.assetBrowserExpandedPaths.map(
      path => this.remapProjectPath(path, sourcePath, targetPath, movedKind) ?? path
    );
    appState.project.assetBrowserSelectedPath =
      this.remapProjectPath(
        appState.project.assetBrowserSelectedPath,
        sourcePath,
        targetPath,
        movedKind
      ) ?? appState.project.assetBrowserSelectedPath;

    appState.project.assetBrowserGroupedExpandedKeys =
      appState.project.assetBrowserGroupedExpandedKeys.map(key => {
        const parsed = splitGroupedDirectoryExpansionKey(key);
        if (!parsed) return key;
        const remapped = this.remapProjectPath(parsed.path, sourcePath, targetPath, movedKind);
        return remapped ? groupedDirectoryExpansionKey(parsed.categoryId, remapped) : key;
      });

    this.saveAssetBrowserState({
      expandedPaths: appState.project.assetBrowserExpandedPaths,
      selectedPath: appState.project.assetBrowserSelectedPath,
      groupedExpandedKeys: appState.project.assetBrowserGroupedExpandedKeys,
    });
  }

  private async rewriteSceneGraphPaths(
    graph: SceneGraph,
    currentFilePath: string,
    nextFilePath: string,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<SceneGraph> {
    const sceneManager = ServiceContainer.getInstance().getService<SceneManager>(
      ServiceContainer.getInstance().getOrCreateToken(SceneManager)
    );
    const serialized = sceneManager.serializeScene(graph);
    const nextSerialized = this.rewriteResourceReferencesInText(
      serialized,
      sourcePath,
      targetPath,
      movedKind
    );

    if (nextSerialized === serialized && nextFilePath === currentFilePath) {
      return graph;
    }

    return await sceneManager.parseScene(nextSerialized, { filePath: nextFilePath });
  }

  private rewriteUnknownValuePaths(
    value: unknown,
    rewrite: (value: string) => string | null
  ): unknown {
    if (typeof value === 'string') {
      return rewrite(value) ?? value;
    }

    if (Array.isArray(value)) {
      let didChange = false;
      const nextArray = value.map(item => {
        const nextItem = this.rewriteUnknownValuePaths(item, rewrite);
        didChange = didChange || nextItem !== item;
        return nextItem;
      });
      return didChange ? nextArray : value;
    }

    if (value && typeof value === 'object') {
      let didChange = false;
      const nextRecord: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value)) {
        const nextValue = this.rewriteUnknownValuePaths(entryValue, rewrite);
        nextRecord[key] = nextValue;
        didChange = didChange || nextValue !== entryValue;
      }
      return didChange ? nextRecord : value;
    }

    return value;
  }

  private rewriteResourceReferencesInText(
    contents: string,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string {
    const sourceResourcePath = this.toResourcePath(sourcePath);
    const targetResourcePath = this.toResourcePath(targetPath);
    const escapedSourceResourcePath = this.escapeRegExp(sourceResourcePath);

    let nextContents = contents;
    if (movedKind === 'directory') {
      nextContents = nextContents.replace(
        new RegExp(`${escapedSourceResourcePath}/`, 'g'),
        `${targetResourcePath}/`
      );
    }

    return nextContents.replace(
      new RegExp(`${escapedSourceResourcePath}(?=$|[^A-Za-z0-9._\\-/])`, 'g'),
      targetResourcePath
    );
  }

  private remapResourcePath(
    resourcePath: string | null | undefined,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string | null {
    if (!resourcePath || !resourcePath.startsWith('res://')) {
      return null;
    }

    const projectPath = this.normalizeProjectPath(resourcePath);
    const remappedPath = this.remapProjectPath(projectPath, sourcePath, targetPath, movedKind);
    return remappedPath ? this.toResourcePath(remappedPath) : null;
  }

  private remapProjectPath(
    projectPath: string | null | undefined,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string | null {
    if (!projectPath) {
      return null;
    }

    const normalizedPath = this.normalizeProjectPath(projectPath);
    if (normalizedPath === sourcePath) {
      return targetPath;
    }

    if (movedKind === 'directory' && normalizedPath.startsWith(`${sourcePath}/`)) {
      return `${targetPath}${normalizedPath.slice(sourcePath.length)}`;
    }

    return null;
  }

  private async listAllProjectFiles(path: string): Promise<FileDescriptor[]> {
    const entries = await this.storage.listDirectory(path);
    const result: FileDescriptor[] = [];

    for (const entry of entries) {
      result.push(entry);
      if (entry.kind === 'directory') {
        const children = await this.listAllProjectFiles(entry.path);
        result.push(...children);
      }
    }

    return result;
  }

  private async getProjectEntry(path: string): Promise<FileDescriptor | null> {
    const parentPath = this.getParentProjectPath(path);
    const entryName = path.split('/').pop();
    if (!entryName) {
      return null;
    }

    const entries = await this.storage.listDirectory(parentPath);
    return entries.find(entry => entry.name === entryName) ?? null;
  }

  private getParentProjectPath(path: string): string {
    const segments = this.normalizeProjectPath(path).split('/').filter(Boolean);
    if (segments.length <= 1) {
      return '.';
    }
    return segments.slice(0, -1).join('/');
  }

  private normalizeProjectPath(path: string): string {
    if (!path || path === '.') {
      return '.';
    }

    return (
      path
        .replace(/^res:\/\//i, '')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\\+/g, '/') || '.'
    );
  }

  private toResourcePath(path: string): string {
    const normalizedPath = this.normalizeProjectPath(path);
    return normalizedPath === '.' ? 'res://' : `res://${normalizedPath}`;
  }

  private deriveSceneIdFromResource(resourcePath: string): string {
    const withoutScheme = resourcePath
      .replace(/^res:\/\//i, '')
      .replace(/^templ:\/\//i, '')
      .replace(/^collab:\/\//i, '');
    const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
    const normalized = withoutExtension
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return normalized || 'scene';
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  public dispose(): void {
    // ProjectService holds no subscriptions or event listeners
  }

  async openStartupScene(): Promise<void> {
    const editorTabService = ServiceContainer.getInstance().getService(
      ServiceContainer.getInstance().getOrCreateToken(
        (await import('@/services/editor/EditorTabService')).EditorTabService
      )
    ) as import('@/services/editor/EditorTabService').EditorTabService;

    appState.scenes.pendingScenePaths = [ProjectService.STARTUP_SCENE_RESOURCE_PATH];
    appState.project.lastOpenedScenePath = ProjectService.STARTUP_SCENE_RESOURCE_PATH;
    await editorTabService.focusOrOpenScene(ProjectService.STARTUP_SCENE_RESOURCE_PATH);
  }

  /**
   * Drop every per-project document: loaded scenes, open tabs, selection, camera memory.
   *
   * Scene ids are derived from the scene's PATH, so two different projects both have a
   * `scenes-main`. Leaving the previous project's descriptors in place made the next project
   * "already have" that scene and reuse the stale graph — a pinball generated on top of a snake
   * opened the snake's board, with the right recipe docs on disk and the wrong game on screen.
   */
  clearOpenDocumentState(): void {
    // A game cannot keep playing into a project whose scenes just went away. Left on, `isPlaying`
    // makes the play session re-attach the runtime to the NEXT project's stage the moment its host
    // registers — with no active scene yet, which is the "Cannot start the game: no active scene is
    // open." the Flow prompt path showed on its first frame — and then blocks that project's own
    // launch with "Game is already running". Shell routing, not an editing action, hence a direct
    // write like everything else this method resets.
    appState.ui.isPlaying = false;
    appState.ui.playModeStatus = 'stopped';
    appState.scenes.activeSceneId = null;
    appState.scenes.descriptors = {};
    appState.scenes.hierarchies = {};
    appState.scenes.loadState = 'idle';
    appState.scenes.loadError = null;
    appState.scenes.lastLoadedAt = null;
    appState.scenes.pendingScenePaths = [];
    appState.scenes.nodeDataChangeSignal = 0;
    appState.scenes.editorCameraStates = {};
    appState.scenes.navigation2DCameraStates = {};
    appState.scenes.previewCameraNodeIds = {};
    appState.tabs.tabs = [];
    appState.tabs.activeTabId = null;
    appState.selection.nodeIds = [];
    appState.selection.primaryNodeId = null;
    appState.selection.hoveredNodeId = null;
  }
}

export const resolveProjectService = (): ProjectService => {
  return ServiceContainer.getInstance().getService(
    ServiceContainer.getInstance().getOrCreateToken(ProjectService)
  ) as ProjectService;
};
