import { Vector2 } from 'three';

import type { InputPointerFrameEvent } from './InputService';

/**
 * Taps and swipes out of `input.pointerEvents` — the bookkeeping every board, card or menu game
 * re-wrote per script (a match-3 swap, a swipe-to-move, a tap that must not fire after a drag).
 *
 * ```ts
 * private readonly gestures = new GestureTracker();
 *
 * onUpdate(): void {
 *   for (const g of this.gestures.update(this.input?.pointerEvents ?? [], this.scene)) {
 *     if (g.type === 'swipe') this.trySwap(g.from, g.direction);
 *     else this.select(g.at);
 *   }
 * }
 * ```
 *
 * Per finger (`pointerId`): a press that ends within {@link GestureOptions.tapSlopPx} and
 * {@link GestureOptions.maxTapMs} is a **tap**; one that travels farther is a **swipe** — reported
 * the moment it crosses {@link GestureOptions.swipeMinPx} (so a swap happens under the finger, not
 * on release), once per press. A `'cancel'` drops the press: it is never a tap. Thresholds are in
 * CSS px — what a finger travels — and are converted with each event's `unitsPerCssPx` (pointer
 * events are in canvas backing pixels: three per CSS px on a DPR-3 phone, where unconverted
 * thresholds shrank to a third — core-tests/game9); positions come back in 2D world units through
 * `scene.screenToWorld2D` (raw input units without a scene).
 */

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface TapGesture {
  readonly type: 'tap';
  readonly pointerId: number;
  /** Where the finger went down, in 2D world units. */
  readonly at: Vector2;
}

export interface SwipeGesture {
  readonly type: 'swipe';
  readonly pointerId: number;
  /** The dominant axis of the travel; world Y is up, so `up` is a finger moving up the screen. */
  readonly direction: SwipeDirection;
  /** Where the finger went down / is when the swipe is reported, in 2D world units. */
  readonly from: Vector2;
  readonly to: Vector2;
}

export type Gesture = TapGesture | SwipeGesture;

export interface GestureOptions {
  /** Travel (CSS px) at which a press becomes a swipe. Default 24. */
  readonly swipeMinPx?: number;
  /** Travel (CSS px) a tap may wobble. Default 12. */
  readonly tapSlopPx?: number;
  /** Longest press that still counts as a tap, ms. Default 500. */
  readonly maxTapMs?: number;
  /**
   * A press released within this many `update` calls (frames) is a tap whatever the clock says.
   * Default 3. On a slow frame rate even a quick tap spans whole frames — at 6 fps three of them
   * are 500 ms — which is how a bot's three-tick tap stopped being a tap on a headless page
   * (core-tests/game8).
   */
  readonly maxTapFrames?: number;
  /**
   * Skip a press a UI control claimed (`input.isPointerOverUI` while it was down): a tap on a
   * button over the board is the button's, not a tap on the board as well (core-tests/game14).
   * Default true; needs `update`'s `scene` (`this.scene`).
   */
  readonly ignoreUI?: boolean;
}

/** What {@link GestureTracker.update} needs from `this.scene` (only the conversion). */
interface WorldConverter {
  screenToWorld2D(point: { x: number; y: number }, target?: Vector2): Vector2 | null;
  /** The scene's input, to ask whether a UI control holds a finger. */
  getInputService?(): { isPointerOverUI(pointerId: number): boolean } | null;
}

interface Press {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  /** Input units per CSS px when the finger went down. */
  readonly scale: number;
  /** The `update` call the press arrived in. */
  readonly frame: number;
  swiped: boolean;
  /** The swipe was handed out (once per press). */
  reported?: boolean;
  /** A UI control held this finger at some frame of the press. */
  ui: boolean;
}

export class GestureTracker {
  private readonly presses = new Map<number, Press>();
  private readonly swipeMinPx: number;
  private readonly tapSlopPx: number;
  private readonly maxTapMs: number;
  private readonly maxTapFrames: number;
  private readonly ignoreUI: boolean;
  /** `update` calls so far: the tracker's frame count. */
  private frame = 0;

  constructor(options: GestureOptions = {}) {
    this.swipeMinPx = Math.max(1, options.swipeMinPx ?? 24);
    this.tapSlopPx = Math.max(0, options.tapSlopPx ?? 12);
    this.maxTapMs = Math.max(1, options.maxTapMs ?? 500);
    this.maxTapFrames = Math.max(0, options.maxTapFrames ?? 3);
    this.ignoreUI = options.ignoreUI !== false;
  }

  /** Feed this frame's pointer events; returns the gestures they completed, in order. */
  update(
    events: readonly InputPointerFrameEvent[],
    scene?: WorldConverter | null,
    now: number = performance.now()
  ): Gesture[] {
    this.frame += 1;
    const out: Gesture[] = [];
    const world = (x: number, y: number): Vector2 =>
      scene?.screenToWorld2D({ x, y }) ?? new Vector2(x, y);
    const input = this.ignoreUI ? (scene?.getInputService?.() ?? null) : null;
    const claimed = (pointerId: number): boolean => input?.isPointerOverUI(pointerId) === true;
    // A control registers the finger in its own tick, maybe a frame after the press arrived:
    // every frame a press is held, ask again.
    for (const [pointerId, held] of this.presses) if (claimed(pointerId)) held.ui = true;
    for (const event of events) {
      if (event.type === 'down') {
        this.presses.set(event.pointerId, {
          x: event.x,
          y: event.y,
          at: now,
          scale: event.unitsPerCssPx && event.unitsPerCssPx > 0 ? event.unitsPerCssPx : 1,
          frame: this.frame,
          swiped: false,
          ui: claimed(event.pointerId),
        });
        continue;
      }
      const press = this.presses.get(event.pointerId);
      if (!press) continue;
      if (event.type === 'cancel') {
        this.presses.delete(event.pointerId);
        continue;
      }
      const dx = event.x - press.x;
      const dy = event.y - press.y;
      // In CSS px, so a threshold means the same at any device pixel ratio.
      const travel = Math.hypot(dx, dy) / press.scale;
      if (claimed(event.pointerId)) press.ui = true;
      if (!press.swiped && travel >= this.swipeMinPx) {
        press.swiped = true;
      }
      // A press a control holds is the control's drag (a slider), not the board's swipe.
      if (press.swiped && !press.reported && !press.ui) {
        press.reported = true;
        out.push({
          type: 'swipe',
          pointerId: event.pointerId,
          // Input y grows downward; world y up — a finger moving up the screen is `up`.
          direction:
            Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
          from: world(press.x, press.y),
          to: world(event.x, event.y),
        });
      }
      if (event.type === 'up') {
        this.presses.delete(event.pointerId);
        const quick =
          now - press.at <= this.maxTapMs || this.frame - press.frame <= this.maxTapFrames;
        if (!press.swiped && !press.ui && travel <= this.tapSlopPx && quick) {
          out.push({ type: 'tap', pointerId: event.pointerId, at: world(press.x, press.y) });
        }
      }
    }
    return out;
  }

  /** Forget every press in flight (a scene change, an overlay that takes the board away). */
  reset(): void {
    this.presses.clear();
  }
}
