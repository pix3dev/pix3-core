import { AssetLoader } from '@pix3/runtime';
import { inject, injectable, ServiceContainer } from '@/fw/di';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import {
  LocalizationEditorService,
  localeOfPath,
} from '@/services/localization/LocalizationEditorService';
import { SceneMergeService } from '@/services/project/SceneMergeService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { isSceneFilePath, toProjectPath } from '@/services/project/disk/project-paths';
import { optionalService } from '@/services/project/disk/optional-service';
import { ProjectService } from '@/services/project/ProjectService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { appState } from '@/state';

/** Image files a node can draw (sprite, skin, frame, Spine page, 3D map). */
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/i;

/**
 * What a settled batch of external changes does to the open editor — the one consumer of
 * `ExternalChangeService` (stabilisation, own-write filter, parse check, play hold):
 *
 * - an open scene whose file changed goes to `SceneMergeService` (plan §C.3): clean → reload,
 *   dirty → key-level merge with a notice of the dropped keys, either way "the agent overwrote
 *   your edit" is detected;
 * - a changed prefab refreshes its instances in every other open scene and re-derives their
 *   baselines (the override base moved);
 * - `pix3project.yaml` is re-read (and the viewport re-filters its 2D textures);
 * - a `locales/<id>.json` goes to `LocalizationEditorService` (its key-level merge, W20);
 * - an image drops the shared `AssetLoader`'s decoded copy and the viewport repaints every node
 *   drawn from it (`ViewportRendererService.invalidateTexture`) — an agent regenerating a sprite
 *   shows up without a reload. Like everything here, held during play and applied on stop.
 */
@injectable()
export class ExternalReloadService {
  @inject(ExternalChangeService)
  private readonly externalChanges!: ExternalChangeService;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(ProjectService)
  private readonly projects!: ProjectService;

  @inject(SceneMergeService)
  private readonly merges!: SceneMergeService;

  @inject(LocalizationEditorService)
  private readonly localization!: LocalizationEditorService;

  @inject(AssetLoader)
  private readonly assetLoader!: AssetLoader;

  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.externalChanges.onExternalBatch(paths => this.apply(paths));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Apply one batch; returns the paths whose reload failed (they stay pending and retry). */
  async apply(paths: readonly string[]): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    const changed = new Set(paths.map(path => toProjectPath(path)));
    // The viewport, when one is mounted.
    const viewport = () => optionalService(ServiceContainer.getInstance(), ViewportRendererService);
    if (changed.has('pix3project.yaml')) {
      await this.projects.reloadProjectManifest();
      // A changed `textureFiltering` re-filters the 2D textures already on screen.
      viewport()?.reapply2DTextureFiltering();
    }
    for (const path of [...changed].filter(path => IMAGE_FILE.test(path))) {
      const resource = `res://${path}`;
      // The viewport evicts too; this covers a page without one (the next play reads fresh bytes).
      this.assetLoader.evictTexture(resource);
      viewport()?.invalidateTexture(resource);
    }
    const locales = [...changed].filter(path => localeOfPath(path) !== null);
    for (const path of locales) await this.localization.applyExternal(path);
    if (locales.length > 0) viewport()?.refreshLocalizedLabels();
    const prefabsChanged = [...changed].filter(isSceneFilePath);
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      const path = toProjectPath(descriptor.filePath);
      if (changed.has(path)) {
        try {
          await this.merges.applyExternal(descriptor);
        } catch (error) {
          console.error(
            '[ExternalReloadService] Applying the external version failed',
            path,
            error
          );
          failed.push(path);
        }
        continue;
      }
      for (const prefab of prefabsChanged) {
        const refreshed = await this.dispatcher.execute(
          new RefreshPrefabInstancesCommand({
            sceneId: descriptor.id,
            changedPrefabPath: `res://${prefab}`,
          })
        );
        if (refreshed) await this.merges.rebaseOnPrefabChange(descriptor);
      }
    }
    return { failed };
  }
}
