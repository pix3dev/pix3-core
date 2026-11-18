import { inject, injectable } from '@/fw/di';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { appState } from '@/state';

import type { HookReply, SyncInfo } from './EditorHost';
import { ExternalReloadService } from './ExternalReloadService';

/**
 * The editor's half of the sync barrier (plan §B.3 step 4): the plugin re-imported the script
 * roots and asks this tab to take in everything the rescan found changed. The game runs on its
 * own page (plan play-in-page D4), so nothing here waits for it.
 */
@injectable()
export class SyncApplyService {
  @inject(ProjectScriptLoaderService)
  private readonly scripts!: ProjectScriptLoaderService;

  @inject(ExternalReloadService)
  private readonly reloads!: ExternalReloadService;

  @inject(ExternalChangeService)
  private readonly externalChanges!: ExternalChangeService;

  async apply(info: SyncInfo): Promise<HookReply> {
    const changedPaths = Object.keys(info.changed);
    const mark = this.externalChanges.reportMark();
    this.scripts.registerRoots(info.roots);
    // The answer means the editor runs the files on disk: live components included.
    await this.scripts.componentsSettled();
    // What the rescan found plus what a `pix3:fs` frame reported before the plugin asked: the
    // watcher broadcasts a settled write on its own, so a sync that comes after that frame finds
    // nothing changed — yet the frame's entry must not outlive the sync.
    const applied = [
      ...new Set([
        ...changedPaths.map(path => toProjectPath(path)),
        ...this.externalChanges.reportedUpTo(mark),
      ]),
    ];
    const { failed } = await this.reloads.apply(applied);
    this.externalChanges.acknowledge(
      applied.filter(path => !failed.includes(path)),
      mark
    );
    return failed.length > 0
      ? { ok: false, reason: 'reload_failed', paths: failed }
      : { ok: true, staleScenes: [...appState.project.host.staleScenes] };
  }
}
