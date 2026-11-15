import { keyForCode } from '@/services/game-test/key-for-code';

/**
 * Synthetic player input for the gameplay harness: where it is dispatched (a sink) and,
 * for input stamped with frames, when (a feeder driven by the frame loop).
 *
 * Shared by the monkey, the bot world (`game-bot-world.ts`) and the negative control's
 * gesture. Two decisions shape it.
 *
 * **Frames, not milliseconds.** A frame-stamped event is dispatched *between* ticks —
 * after frame N-1 has run and before frame N does. That is the delivery
 * `GameInputService.run()` structurally cannot provide: it paces steps with wall-clock
 * `setTimeout`, and in `'manual'` time mode no tick happens while those timers run, so a
 * key hold would deliver keydown and keyup with zero frames in between.
 *
 * **Pointer coordinates are fractions of the canvas box, not client pixels.** `nx`/`ny`
 * in 0..1 survive a canvas that moved or resized (a docked panel changed width).
 */

export interface FrameKeyEvent {
  /** The frame this event is delivered before. */
  frame: number;
  kind: 'key';
  phase: 'down' | 'up';
  /** `KeyboardEvent.code`, e.g. `'ArrowLeft'`. */
  code: string;
}

export interface FramePointerEvent {
  frame: number;
  kind: 'pointer';
  phase: 'down' | 'move' | 'up';
  /** X in 0..1 of the canvas box. */
  nx: number;
  /** Y in 0..1 of the canvas box. */
  ny: number;
  pointerId?: number;
}

export type FrameInputEvent = FrameKeyEvent | FramePointerEvent;

/**
 * Which device a synthetic press comes from: `pointerType` (default `'mouse'`) and the button that
 * started it (default 0, the left one / a finger). A game may bind the mouse differently from a
 * finger (right-drag pans, left-click acts), so a bot has to be able to be either.
 */
export interface PointerDevice {
  pointerType?: 'mouse' | 'touch' | 'pen';
  button?: 0 | 1 | 2;
}

/** `PointerEvent.buttons` bit of a `button` (0 → 1, 1 → 4 (middle), 2 → 2 (right)). */
const BUTTONS_BIT = [1, 4, 2] as const;

/**
 * Where synthetic events go. The live implementation dispatches the same DOM events
 * `GameInputService` does — keys on the editor window (the runtime's `InputService`
 * registers there even when the game renders in a popout), pointers on the game canvas —
 * so the harness travels the real player path and not a private back door into the input
 * service.
 */
export interface InputSink {
  key(phase: 'down' | 'up', code: string): void;
  pointer(
    phase: 'down' | 'move' | 'up',
    nx: number,
    ny: number,
    pointerId?: number,
    device?: PointerDevice
  ): void;
}

/** Pointer id used by synthetic pointers (matches GameInputService's). */
const SYNTHETIC_POINTER_ID = 1;

export class DomInputSink implements InputSink {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly windowRef: Window
  ) {}

  key(phase: 'down' | 'up', code: string): void {
    const type = phase === 'down' ? 'keydown' : 'keyup';
    this.windowRef.dispatchEvent(
      new KeyboardEvent(type, { code, key: keyForCode(code), bubbles: true, cancelable: true })
    );
  }

  pointer(
    phase: 'down' | 'move' | 'up',
    nx: number,
    ny: number,
    pointerId?: number,
    device?: PointerDevice
  ): void {
    const rect = this.canvas.getBoundingClientRect();
    const type = phase === 'down' ? 'pointerdown' : phase === 'up' ? 'pointerup' : 'pointermove';
    const button = device?.button ?? 0;
    const init = {
      pointerId: pointerId ?? SYNTHETIC_POINTER_ID,
      pointerType: device?.pointerType ?? 'mouse',
      isPrimary: true,
      clientX: rect.left + nx * rect.width,
      clientY: rect.top + ny * rect.height,
      button,
      buttons: phase === 'up' ? 0 : BUTTONS_BIT[button],
      bubbles: true,
      cancelable: true,
    };
    // happy-dom (specs) has no PointerEvent constructor carrying pointer fields —
    // same fallback GameInputService uses.
    if (typeof PointerEvent === 'function') {
      this.canvas.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [prop, value] of Object.entries(init)) {
      Object.defineProperty(event, prop, { value });
    }
    this.canvas.dispatchEvent(event);
  }
}

export interface FrameInputFeeder {
  /** Dispatch everything stamped with `frame`, immediately before that frame runs. */
  before(frame: number): void;
}

/**
 * Groups frame-stamped events by frame and hands them to the sink between ticks.
 *
 * The loop calls `before(N)` (its `beforeFrame` seam) after frame N-1 has completed and
 * before it steps frame N, so an event stamped N is delivered in that gap — the game polls
 * it on frame N. No wall-clock timer is involved anywhere, which is precisely why it works
 * in `'manual'` mode where `GameInputService.run()` cannot.
 */
export function makeFrameInputFeeder(
  events: readonly FrameInputEvent[],
  sink: InputSink
): FrameInputFeeder {
  const byFrame = new Map<number, FrameInputEvent[]>();
  for (const event of events) {
    const bucket = byFrame.get(event.frame);
    if (bucket) bucket.push(event);
    else byFrame.set(event.frame, [event]);
  }
  return {
    before(frame: number): void {
      for (const event of byFrame.get(frame) ?? []) {
        if (event.kind === 'key') sink.key(event.phase, event.code);
        else sink.pointer(event.phase, event.nx, event.ny, event.pointerId);
      }
    },
  };
}
