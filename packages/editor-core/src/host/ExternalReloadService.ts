import { inject, injectable } from '@/fw/di';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { SceneMergeService } from '@/services/project/SceneMergeService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { ProjectService } from '@/services/project/ProjectService';
import { appState } from '@/state';

/**
 * What a settled batch of external changes does to the open editor — the one consumer of
 * `ExternalChangeService` (stabilisation, own-write filter, parse check, play hold):
 *
 * - an open scene whose file changed goes to `SceneMergeService` (plan §C.3): clean → reload,
 *   dirty → key-level merge with a notice of the dropped keys, either way "the agent overwrote
 *   your edit" is detected;
 * - a changed prefab refreshes its instances in every other open scene and re-derives their
 *   baselines (the override base moved);
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

  @inject(SceneMergeService)
  private readonly merges!: SceneMergeService;

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
