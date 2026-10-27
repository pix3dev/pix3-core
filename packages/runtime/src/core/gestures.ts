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
 * on release), once per press. A `'cancel'` drops the press: it is never a tap. Distances are in
 * input units (CSS px of the canvas), so a threshold means the same on every screen; positions
 * come back in 2D world units through `scene.screenToWorld2D` (raw input units without a scene).
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
  /** Travel (input px) at which a press becomes a swipe. Default 24. */
  readonly swipeMinPx?: number;
  /** Travel (input px) a tap may wobble. Default 12. */
  readonly tapSlopPx?: number;
  /** Longest press that still counts as a tap, ms. Default 500. */
  readonly maxTapMs?: number;
}

/** What {@link GestureTracker.update} needs from `this.scene` (only the conversion). */
interface WorldConverter {
  screenToWorld2D(point: { x: number; y: number }, target?: Vector2): Vector2 | null;
}

interface Press {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  swiped: boolean;
}

export class GestureTracker {
  private readonly presses = new Map<number, Press>();
  private readonly swipeMinPx: number;
  private readonly tapSlopPx: number;
  private readonly maxTapMs: number;

  constructor(options: GestureOptions = {}) {
    this.swipeMinPx = Math.max(1, options.swipeMinPx ?? 24);
    this.tapSlopPx = Math.max(0, options.tapSlopPx ?? 12);
    this.maxTapMs = Math.max(1, options.maxTapMs ?? 500);
  }

  /** Feed this frame's pointer events; returns the gestures they completed, in order. */
  update(
    events: readonly InputPointerFrameEvent[],
    scene?: WorldConverter | null,
    now: number = performance.now()
  ): Gesture[] {
    const out: Gesture[] = [];
    const world = (x: number, y: number): Vector2 =>
      scene?.screenToWorld2D({ x, y }) ?? new Vector2(x, y);
    for (const event of events) {
      if (event.type === 'down') {
        this.presses.set(event.pointerId, { x: event.x, y: event.y, at: now, swiped: false });
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
      const travel = Math.hypot(dx, dy);
      if (!press.swiped && travel >= this.swipeMinPx) {
        press.swiped = true;
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
        if (!press.swiped && travel <= this.tapSlopPx && now - press.at <= this.maxTapMs) {
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
