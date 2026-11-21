/**
 * What a run recording hears and what a replay feeds back (`core/RunTape.ts`): the inputs that come
 * from OUTSIDE the game, one by one, at the tick they reach it. Types only — the runner, the input
 * layer and the command registry speak this without importing the recorder.
 */

import type { AdRunOutcome } from './platform-host';

/** One DOM pointer event; `x` / `y` are fractions of the canvas (0..1, outside when dragged off). */
export interface RunPointerInput {
  readonly kind: 'pointer';
  readonly type: 'down' | 'move' | 'up' | 'cancel';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly pointerType: string;
  readonly button: number;
  readonly buttons: number;
}

export interface RunKeyInput {
  readonly kind: 'key';
  readonly type: 'down' | 'up';
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
}

export interface RunWheelInput {
  readonly kind: 'wheel';
  readonly dx: number;
  readonly dy: number;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Input the DOM delivers to `InputService`. */
export type RunDomInput = RunPointerInput | RunKeyInput | RunWheelInput;

/**
 * Every external input: the DOM's, a command dispatched from outside the game
 * (`commands.dispatchExternal` — a test, a bot's direct action, the bridge), and the environment —
 * a trip to the background (`awayMs`), a focus loss, a canvas resize (CSS px), how an ad show ended.
 */
export type RunInput =
  | RunDomInput
  | { readonly kind: 'command'; readonly name: string; readonly args?: Record<string, unknown> }
  | { readonly kind: 'background'; readonly awayMs: number }
  | { readonly kind: 'blur' }
  | { readonly kind: 'resize'; readonly width: number; readonly height: number }
  | { readonly kind: 'ad'; readonly outcome: AdRunOutcome };

/** The runner's side of a recording or a replay (`SceneRunner.setRunTap`). */
export interface RunTap {
  /** A tick starts (before its input frame); `frameStart` = the first tick of its driver frame. */
  beforeTick(dt: number, frameStart: boolean): void;
  /** The tick and whatever ran inside it (frame listeners: a bot) are done. */
  afterTick(): void;
  /** An external input arrived (see {@link RunInput}). */
  input(input: RunInput): void;
  /** A scene (`path`) was built and is about to run its first tick. */
  sceneStarted(path: string | null): void;
}
