import { inject, injectable, ServiceContainer } from '@/fw/di';
import { HostService } from '@/host/HostService';
import { appState, type AssetBrowserViewMode } from '@/state';
import type { FileDescriptor } from '@/services/project/file-descriptor';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { sha256 } from '@/services/project/external-merge/hash';
import { parse, stringify } from 'yaml';
import {
  createDefaultProjectManifest,
  createProjectId,
  getProjectId,
  normalizeProjectManifest,
  withProjectId,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import { loadProjectFonts, setProjectAODefault, setProjectTextureFiltering } from '@pix3/runtime';

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
 * Owns the manifest (`pix3project.yaml`) and the asset browser's per-project UI state. Files and
 * folders are created, moved and deleted by the coding agent or the IDE, never through the editor.
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

  listDirectory(path = '.'): Promise<FileDescriptor[]> {
    return this.storage.listDirectory(path);
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
