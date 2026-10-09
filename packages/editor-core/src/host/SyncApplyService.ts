import { inject, injectable } from '@/fw/di';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { appState } from '@/state';

import type { HookReply, SyncInfo } from './EditorHost';
import { ExternalReloadService } from './ExternalReloadService';

/**
 * The editor's half of the sync barrier (plan §B.3 step 4): the plugin re-imported the script
 * roots and asks this tab to take in everything the rescan found changed.
 *
 * While play runs, nothing is applied — external changes wait for play to stop — and the answer
 * says whose session it is, so the agent knows whether it may restart it. A sync during play with
 * nothing to apply (the rescan found no change and nothing is held for play — after a restart
 * took the deferred version in) is `ok`: the game runs the files as they are on disk.
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
    if (appState.ui.isPlaying) {
      const playing = appState.ui.playOwner ?? 'designer';
      const pending = [...new Set([...changedPaths, ...this.externalChanges.getPendingPaths()])];
      if (pending.length > 0) return { ok: false, reason: 'stale', playing, pending };
      return { ok: true, playing, staleScenes: [...appState.project.host.staleScenes] };
    }
    this.scripts.registerRoots(info.roots);
    const { failed } = await this.reloads.apply(changedPaths);
    return failed.length > 0
      ? { ok: false, reason: 'reload_failed', paths: failed }
      : { ok: true, staleScenes: [...appState.project.host.staleScenes] };
  }
}
