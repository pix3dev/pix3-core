import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { PlayTarget } from '@/state/AppState';

export const PLAY_TARGET_STORAGE_KEY = 'pix3.playTarget:v1';

const PLAY_TARGETS: readonly PlayTarget[] = ['tab', 'window', 'browser', 'debug'];

export const isPlayTarget = (value: unknown): value is PlayTarget =>
  PLAY_TARGETS.includes(value as PlayTarget);

/** The play target this browser picked last, or null. */
export const loadPlayTarget = (): PlayTarget | null => {
  try {
    const stored = localStorage.getItem(PLAY_TARGET_STORAGE_KEY);
    return isPlayTarget(stored) ? stored : null;
  } catch {
    return null;
  }
};

export interface SetPlayTargetOperationParams {
  target: PlayTarget;
}

/**
 * Remember where the toolbar's Play runs the game, and persist it per browser.
 *
 * Commit-less, like `SetPlayPausedOperation`: picking a run mode is a preference, not an edit to
 * the project, and an undo that quietly moved Play to another window would explain itself nowhere.
 */
export class SetPlayTargetOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.set-play-target',
    title: 'Set Play Target',
    description: 'Choose where the toolbar Play runs the game',
    tags: ['scene', 'play-mode', 'ui'],
  };

  constructor(private readonly params: SetPlayTargetOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    if (context.snapshot.ui.playTarget === this.params.target) {
      return { didMutate: false };
    }
    context.state.ui.playTarget = this.params.target;
    try {
      localStorage.setItem(PLAY_TARGET_STORAGE_KEY, this.params.target);
    } catch {
      // A preference that does not survive a reload is still the preference for this session.
    }
    return { didMutate: true };
  }
}
