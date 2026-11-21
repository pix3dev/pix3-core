import {
  parseRunTape,
  replayRunTape,
  RunRecorder,
  runTapeOverrides,
  type RunOverrides,
  type RunTapeReplayResult,
  type SceneRunner,
} from '@pix3/runtime';

/**
 * Dev only (`virtual:pix3/dev`'s `installRunTape`): `RunOverrides.record` / `.replay` on the game
 * page — what `pix3 play --record` / `--replay` read back through `window.__PIX3_RUN_TAPE__`.
 * Imported only when a run asks for it, so a plain page and every build go without.
 */

export interface PageRunTape {
  readonly mode: 'record' | 'replay';
  /** Record: end the recording, the file's text. */
  finish?(): string;
  /** Replay: drive the recording's ticks (once); the outcome lands in {@link result}. */
  start?(): void;
  /** Replay: the recorded tick being played. */
  tick: number;
  result: RunTapeReplayResult | null;
  /** Replay: why the file was refused. */
  errors?: readonly string[];
}

declare global {
  interface Window {
    __PIX3_RUN_TAPE__?: PageRunTape;
  }
}

/** One task turn without a timer's clamp: async work (a fetch, an ad outcome) gets to land. */
const nextTurn = (): Promise<void> =>
  new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

export const installRunTape = (runner: SceneRunner, run: RunOverrides): void => {
  if (run.replay !== undefined) {
    const parsed = parseRunTape(run.replay);
    if (!parsed.ok) {
      console.error('[pix3] Not a recording this engine replays:', parsed.errors.join('; '));
      window.__PIX3_RUN_TAPE__ = { mode: 'replay', tick: 0, result: null, errors: parsed.errors };
      return;
    }
    const { tape } = parsed;
    runner.setRunOverrides(runTapeOverrides(tape));
    // The replay steps every tick itself; each one is painted, so a picture shows that tick.
    runner.setTimeMode({
      mode: 'manual',
      fixedDeltaSec: tape.header.time.fixedDeltaSec,
      renderEveryNTicks: 1,
    });
    let started = false;
    const state: PageRunTape = {
      mode: 'replay',
      tick: 0,
      result: null,
      start: () => {
        if (started) return;
        started = true;
        replayRunTape(runner, tape, { flush: nextTurn, onTick: tick => (state.tick = tick) }).then(
          result => (state.result = result),
          (error: unknown) => {
            state.result = {
              ok: false,
              ticks: state.tick,
              end: tape.end,
              checkpoints: 0,
              divergence: null,
              stopped: `the replay threw: ${error instanceof Error ? error.message : String(error)}`,
              notes: [],
            };
          }
        );
      },
    };
    window.__PIX3_RUN_TAPE__ = state;
    return;
  }
  if (run.record) {
    const recorder = new RunRecorder(runner, run.record);
    window.__PIX3_RUN_TAPE__ = {
      mode: 'record',
      result: null,
      get tick() {
        return recorder.ticksRecorded;
      },
      finish: () => recorder.finish(),
    };
  }
};
