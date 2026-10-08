import { inject, injectable } from '@/fw/di';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { appState } from '@/state';

import type { HookReply, SyncInfo } from './EditorHost';
import { ExternalReloadService } from './ExternalReloadService';

/**
 * The editor's half of the sync barrier (plan §B.3 step 4): the plugin re-imported the script
 * roots and asks this tab to take in everything the rescan found changed.
 *
 * While play runs, nothing is applied — external changes wait for play to stop — and the answer
 * says whose session it is, so the agent knows whether it may restart it.
 */
@injectable()
export class SyncApplyService {
  @inject(ProjectScriptLoaderService)
  private readonly scripts!: ProjectScriptLoaderService;

  @inject(ExternalReloadService)
  private readonly reloads!: ExternalReloadService;

  async apply(info: SyncInfo): Promise<HookReply> {
    const changedPaths = Object.keys(info.changed);
    if (appState.ui.isPlaying) {
      return {
        ok: false,
        reason: 'stale',
        playing: appState.ui.playOwner ?? 'designer',
        pending: changedPaths,
      };
    }
    this.scripts.registerRoots(info.roots);
    const { failed } = await this.reloads.apply(changedPaths);
    return failed.length > 0
      ? { ok: false, reason: 'reload_failed', paths: failed }
      : { ok: true, staleScenes: [...appState.project.host.staleScenes] };
  }
}
