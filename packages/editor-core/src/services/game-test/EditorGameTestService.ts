import { inject, injectable } from '@/fw/di';
import { errors as capturedErrors } from '@/core/agent-introspection';
import { keepaliveSleep } from '@/services/core/background-ticker';
import { GameBotHost } from '@/services/game-test/GameBotHost';
import { GameInputService } from '@/services/game-test/GameInputService';
import { GameTestService } from '@/services/game-test/GameTestService';
import type { GameRuntimeHandle, GameTestHost } from '@/services/game-test/game-runtime-handle';
import {
  REACHABILITY_JOURNAL_PATH,
  type ReachabilityStore,
} from '@/services/game-test/reachability-journal';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { appState } from '@/state';

/**
 * The editor's game-test host (plan play-in-page S3): `GameTestService` and `GameInputService`
 * over the editor's play session (`GamePlaySessionService`), its state and its project storage.
 * The game page has its own (`page-test-host.ts`). Goes away with the editor's play mode (S6).
 */
@injectable()
export class EditorGameTestService {
  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(GameBotHost)
  private readonly botHost!: GameBotHost;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private readonly host: GameTestHost = {
    isPlaying: () => appState.ui.isPlaying,
    runtime: () => this.runtime(),
    sceneId: () => appState.scenes.activeSceneId ?? '',
    targetPlatform: () => appState.project.manifest?.targetPlatform,
    errors: () => capturedErrors(),
    // Not throttled in a hidden tab while an agent keeps the editor alive.
    sleep: keepaliveSleep,
    // A macrotask, not a microtask: a microtask queue drain never lets the host paint or deliver
    // events, so the editor would still look frozen.
    yieldToHost: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    reachabilityStore: () => new ProjectFileReachabilityStore(() => this.storage),
    loadBot: name => this.botHost.load(name),
    restartScene: () => this.playSession.restart(),
  };

  readonly input = new GameInputService(this.host);
  readonly test = new GameTestService(this.host, this.input);

  private runtime(): GameRuntimeHandle | null {
    const active = this.playSession.getActiveRuntime();
    if (!active) return null;
    return {
      ...active,
      setPauseRequested: (paused, by) => this.playSession.setPauseRequested(paused, by),
      setFocusPauseSuppressed: suppressed => this.playSession.setFocusPauseSuppressed(suppressed),
    };
  }

  /** Flush pending reach proofs — for a host that wants the journal on disk before teardown. */
  dispose(): Promise<void> {
    return this.input.dispose();
  }
}

/** The real backend: `design/tests/reachability.json` inside the open project. */
class ProjectFileReachabilityStore implements ReachabilityStore {
  constructor(private readonly storage: () => ProjectStorageService) {}

  async read(): Promise<string | null> {
    try {
      return await this.storage().readTextFile(REACHABILITY_JOURNAL_PATH);
    } catch {
      // Missing file, no project open, no permission — all "nothing proved yet" as far as the
      // journal is concerned. A hard failure here would take `game_controls` down with it.
      return null;
    }
  }

  async write(text: string): Promise<void> {
    const storage = this.storage();
    try {
      await storage.writeTextFile(REACHABILITY_JOURNAL_PATH, text);
    } catch (error) {
      // The one recoverable case: the project predates `design/tests/` (only newer templates ship
      // it). Create it once and retry; anything else is reported to the caller.
      try {
        await storage.createDirectory('design/tests');
      } catch {
        throw error;
      }
      await storage.writeTextFile(REACHABILITY_JOURNAL_PATH, text);
    }
  }
}
