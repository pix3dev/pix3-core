import type { RuntimeRenderer, SceneRunner } from '@pix3/runtime';
import type { BotLoaded, BotLoadFailure } from '@/services/game-test/bot-loader';
import type { ReachabilityStore } from '@/services/game-test/reachability-journal';

/**
 * The running game as the game-test code sees it (plan play-in-page S3): the runner, where input
 * goes, and the two pause levers a run pulls. No `restart` — a fresh game is a new page load
 * (D5); a host that can restart a scene in place says so through {@link GameTestHost.restartScene}.
 *
 * Two implementations: the editor's over `GamePlaySessionService` (`EditorGameTestService`, until
 * S6) and the game page's over `window.__PIX3_PLAYER__` (`page-test-host.ts`).
 */
export interface GameRuntimeHandle {
  readonly runner: SceneRunner;
  readonly renderer: RuntimeRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly windowRef: Window;
  /** Hold the game paused (or release it) on the host's behalf, so the host's own rule keeps it. */
  setPauseRequested(paused: boolean, by?: 'pix3_game_run'): void;
  /** While true the game keeps ticking when its window loses focus or is hidden. */
  setFocusPauseSuppressed(suppressed: boolean): void;
}

/**
 * Everything else the game-test code reads from where it runs. Plain functions, so the page entry
 * carries none of the editor (`@/state`, DI, project storage) and a spec fakes it in a few lines.
 */
export interface GameTestHost {
  /** A game is meant to be running (it may still be starting: {@link runtime} is then null). */
  isPlaying(): boolean;
  runtime(): GameRuntimeHandle | null;
  /** The running scene's id: the key reach proofs are filed under. */
  sceneId(): string;
  /** `pix3project.yaml` `targetPlatform`, for the renderability lint. */
  targetPlatform(): string | undefined;
  /** Runtime errors captured so far, oldest first. */
  errors(): ReadonlyArray<{ readonly source: string; readonly message: string }>;
  /** A real-time wait that a hidden page does not throttle. */
  sleep(ms: number): Promise<void>;
  /** A macrotask between two stepped frames. */
  yieldToHost(): Promise<void>;
  /** Where the reachability journal is read and written. */
  reachabilityStore(): ReachabilityStore;
  /** A stored bot policy, compiled and resolved. */
  loadBot(name: string): Promise<BotLoaded | BotLoadFailure>;
  /** Restart the scene in place before a negative control; absent where only a reload can. */
  restartScene?(): Promise<void>;
}
