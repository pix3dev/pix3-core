import { inject, injectable } from '@/fw/di';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { LoggingService } from '@/services/core/LoggingService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { ProjectService } from '@/services/project/ProjectService';
import { appState } from '@/state';

/**
 * What a settled batch of external changes does to the open editor (port phase,
 * `.plans/editor-core-port.md` D5; the key-level merge of plan §C.3 replaces the dirty branch):
 *
 * - an open **clean** scene reloads from disk (non-destructive: selection by id, camera kept);
 * - an open **dirty** scene is not touched: it is listed in `project.host.staleScenes` and a
 *   warning says so — the next save is refused by `If-Match` rather than overwriting the change;
 * - a changed prefab refreshes its instances in every open scene;
 * - `pix3project.yaml` is re-read.
 */
@injectable()
export class ExternalReloadService {
  @inject(ExternalChangeService)
  private readonly externalChanges!: ExternalChangeService;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(ProjectService)
  private readonly projects!: ProjectService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

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
    if (changed.has('pix3project.yaml')) {
      await this.projects.reloadProjectManifest();
    }
    const prefabsChanged = [...changed].filter(path => /\.(?:prefab|pix3scene)$/i.test(path));
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      const path = toProjectPath(descriptor.filePath);
      if (changed.has(path)) {
        if (descriptor.isDirty) {
          if (!appState.project.host.staleScenes.includes(path)) {
            appState.project.host.staleScenes = [...appState.project.host.staleScenes, path];
          }
          this.logger.warn(
            `${path} changed on disk while it has unsaved edits here — kept your version. ` +
              'Saving it will be refused until you reload it.'
          );
          continue;
        }
        try {
          await this.dispatcher.execute(
            new ReloadSceneCommand({ sceneId: descriptor.id, filePath: descriptor.filePath })
          );
          appState.project.host.staleScenes = appState.project.host.staleScenes.filter(
            stale => stale !== path
          );
        } catch (error) {
          console.error('[ExternalReloadService] Reload failed', path, error);
          failed.push(path);
        }
        continue;
      }
      for (const prefab of prefabsChanged) {
        await this.dispatcher.execute(
          new RefreshPrefabInstancesCommand({
            sceneId: descriptor.id,
            changedPrefabPath: `res://${prefab}`,
          })
        );
      }
    }
    return { failed };
  }
}
