import { inject, injectable } from '@/fw/di';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { BOT_DIRECTORY } from '@/services/game-test/game-bots';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { appState } from '@/state';

import type { HookReply, SyncInfo } from './EditorHost';
import { ExternalReloadService } from './ExternalReloadService';

/**
 * What a sync during play cannot apply. A bot policy is not part of the game: the page already
 * re-imported `virtual:pix3/bot-policies` for this sync and `GameBotHost` reads the roots on every
 * run, so the next `pix3_game_run {bot}` uses the new file without a restart.
 */
export function pendingDuringPlay(
  changedPaths: readonly string[],
  externalPending: readonly string[]
): string[] {
  const applied = (path: string): boolean => path.startsWith(`${BOT_DIRECTORY}/`);
  return [...new Set([...changedPaths, ...externalPending])].filter(path => !applied(path));
}

/**
 * The editor's half of the sync barrier (plan §B.3 step 4): the plugin re-imported the script
 * roots and asks this tab to take in everything the rescan found changed.
 *
 * While play runs, nothing is applied (bot policies aside, {@link pendingDuringPlay}) — external
 * changes wait for play to stop — and the answer
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
      const pending = pendingDuringPlay(changedPaths, this.externalChanges.getPendingPaths());
      if (pending.length > 0) return { ok: false, reason: 'stale', playing, pending };
      return { ok: true, playing, staleScenes: [...appState.project.host.staleScenes] };
    }
    const mark = this.externalChanges.reportMark();
    this.scripts.registerRoots(info.roots);
    // The answer means the editor runs the files on disk: live components included.
    await this.scripts.componentsSettled();
    // What the rescan found plus what a `pix3:fs` frame reported before the plugin asked: the
    // watcher broadcasts a settled write on its own, so a sync that comes after that frame finds
    // nothing changed — yet the frame's entry must not outlive the sync (a play started next
    // would hold it and answer `stale` for a file the editor already runs).
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
