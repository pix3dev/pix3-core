import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { UIState } from '@/state/AppState';

/** Who started the running play session: the designer (UI) or an agent (debug bridge). */
export type PlayOwner = NonNullable<UIState['playOwner']>;

export interface SetPlayModeOperationParams {
  isPlaying: boolean;
  status: 'stopped' | 'playing' | 'paused';
  /**
   * Owner recorded when this operation *starts* play (`isPlaying` false → true); defaults to
   * `'designer'` (the UI path). The debug bridge passes `'agent'`. Ignored otherwise: a pause or a
   * status change keeps the session's owner, a stop clears it.
   */
  owner?: PlayOwner;
}

type PlayModeFields = Pick<UIState, 'isPlaying' | 'playModeStatus' | 'playOwner' | 'playStartedAt'>;

export class SetPlayModeOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.set-play-mode',
    title: 'Set Play Mode',
    description: 'Update global play mode status for the editor runtime',
    tags: ['scene', 'play-mode', 'ui'],
  };

  constructor(private readonly params: SetPlayModeOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot } = context;
    const previous: PlayModeFields = {
      isPlaying: snapshot.ui.isPlaying,
      playModeStatus: snapshot.ui.playModeStatus,
      playOwner: snapshot.ui.playOwner,
      playStartedAt: snapshot.ui.playStartedAt,
    };

    if (
      previous.isPlaying === this.params.isPlaying &&
      previous.playModeStatus === this.params.status
    ) {
      return { didMutate: false };
    }

    const starting = this.params.isPlaying && !previous.isPlaying;
    const next: PlayModeFields = {
      isPlaying: this.params.isPlaying,
      playModeStatus: this.params.status,
      playOwner: !this.params.isPlaying
        ? null
        : starting
          ? (this.params.owner ?? 'designer')
          : previous.playOwner,
      playStartedAt: !this.params.isPlaying ? null : starting ? Date.now() : previous.playStartedAt,
    };
    const apply = (fields: PlayModeFields): void => {
      state.ui.isPlaying = fields.isPlaying;
      state.ui.playModeStatus = fields.playModeStatus;
      state.ui.playOwner = fields.playOwner;
      state.ui.playStartedAt = fields.playStartedAt;
    };
    apply(next);

    return {
      didMutate: true,
      commit: {
        label: this.params.isPlaying ? 'Start Play Mode' : 'Stop Play Mode',
        undo: () => apply(previous),
        redo: () => apply(next),
      },
    };
  }
}
