/**
 * The running session as the `platform` module sees it, without the runner importing that module
 * (it is strippable): the runner registers itself here when a scene starts and says when a scene
 * ends; `platform` pauses it for an ad and drops a show whose scene went away.
 */

/** A test run's ad outcome (`RunOverrides.ads`, `pix3 play --ads`): what the next show does. */
export type AdRunOutcome = 'reward' | 'skip' | 'unavailable';

/** What `platform` needs of the runner. */
export interface PlatformHost {
  setPauseReason(reason: 'ad', paused: boolean): void;
  /** The next show's outcome from `RunOverrides.ads`, or null when the run does not set it. */
  takeAdRunOutcome(): AdRunOutcome | null;
}

type SceneEndListener = (host: PlatformHost) => void;

let current: PlatformHost | null = null;
const sceneEndListeners = new Set<SceneEndListener>();

/** The page's one link between the runner and `platform`. */
export const platformHost = {
  get current(): PlatformHost | null {
    return current;
  },
  /** The runner, starting a scene: it is the page's session now. */
  activate(host: PlatformHost): void {
    current = host;
  },
  /** The runner, ending its session. */
  deactivate(host: PlatformHost): void {
    if (current === host) current = null;
  },
  /** The runner, tearing a scene down (a stop or a scene change). */
  sceneEnded(host: PlatformHost): void {
    for (const listener of Array.from(sceneEndListeners)) listener(host);
  },
  onSceneEnd(listener: SceneEndListener): void {
    sceneEndListeners.add(listener);
  },
};
