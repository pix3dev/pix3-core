import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';

import { GestureTracker } from './gestures';
import type { InputPointerFrameEvent } from './InputService';

const ev = (
  type: InputPointerFrameEvent['type'],
  x: number,
  y: number,
  pointerId = 1
): InputPointerFrameEvent => ({ type, pointerId, x, y });

/** world = input shifted, so the conversion is visibly applied. */
const scene = {
  screenToWorld2D: (p: { x: number; y: number }) => new Vector2(p.x - 100, 100 - p.y),
};

describe('GestureTracker', () => {
  it('a short press is a tap at its down point (in world units)', () => {
    const g = new GestureTracker();
    expect(g.update([ev('down', 110, 90)], scene, 0)).toEqual([]);
    const out = g.update([ev('up', 113, 92)], scene, 120);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'tap', pointerId: 1 });
    expect(out[0].type === 'tap' && [out[0].at.x, out[0].at.y]).toEqual([10, 10]);
  });

  it('a drag is one swipe, reported when it crosses the threshold, never also a tap', () => {
    const g = new GestureTracker({ swipeMinPx: 20 });
    g.update([ev('down', 100, 100)], scene, 0);
    expect(g.update([ev('move', 110, 100)], scene, 16)).toEqual([]);
    const crossed = g.update([ev('move', 125, 104)], scene, 32);
    expect(crossed).toMatchObject([{ type: 'swipe', direction: 'right' }]);
    expect(g.update([ev('move', 160, 100), ev('up', 160, 100)], scene, 48)).toEqual([]);
  });

  it('direction follows the screen: a finger moving up the screen is `up`', () => {
    const g = new GestureTracker();
    expect(g.update([ev('down', 100, 200), ev('move', 98, 150)], scene, 0)).toMatchObject([
      { direction: 'up' },
    ]);
  });

  it('a cancel is never a tap; a too-long press is not a tap; fingers are separate', () => {
    const g = new GestureTracker({ maxTapMs: 300 });
    g.update([ev('down', 0, 0, 1), ev('down', 50, 50, 2)], null, 0);
    expect(g.update([ev('cancel', 0, 0, 1)], null, 10)).toEqual([]);
    // Held for 24 frames at 60 fps (update runs every frame): long by the clock and by frames.
    for (let frame = 2; frame < 24; frame += 1) g.update([], null, frame * 16);
    expect(g.update([ev('up', 50, 50, 2)], null, 400)).toEqual([]);
    g.update([ev('down', 5, 5, 3)], null, 500);
    expect(g.update([ev('up', 5, 5, 3)], null, 520)).toMatchObject([{ type: 'tap', pointerId: 3 }]);
  });

  it('on a slow frame rate a press of a few frames is still a tap (core-tests/game8)', () => {
    // A headless page at ~6 fps: a bot's tap, down then up three frames later, is 510 ms by the
    // clock — past maxTapMs — but no finger can tap faster than the frames it lands in.
    const g = new GestureTracker();
    g.update([ev('down', 5, 5)], null, 0);
    g.update([], null, 170);
    g.update([], null, 340);
    expect(g.update([ev('up', 5, 5)], null, 510)).toMatchObject([{ type: 'tap' }]);
    // Four frames and past the clock: a hold.
    g.update([ev('down', 5, 5)], null, 1000);
    for (const t of [1170, 1340, 1510]) g.update([], null, t);
    expect(g.update([ev('up', 5, 5)], null, 1680)).toEqual([]);
    // maxTapFrames: 0 is the clock alone.
    const strict = new GestureTracker({ maxTapFrames: 0 });
    strict.update([ev('down', 5, 5)], null, 0);
    expect(strict.update([ev('up', 5, 5)], null, 510)).toEqual([]);
  });

  it('thresholds are CSS px at any device pixel ratio (core-tests/game9)', () => {
    // A DPR-3 phone: 30 input units of travel are 10 CSS px — a wobble, not a swipe.
    const at3 = (type: InputPointerFrameEvent['type'], x: number) => ({
      ...ev(type, x, 0),
      unitsPerCssPx: 3,
    });
    const g = new GestureTracker();
    g.update([at3('down', 0)], null, 0);
    expect(g.update([at3('move', 30)], null, 16)).toEqual([]);
    expect(g.update([at3('up', 30)], null, 32)).toMatchObject([{ type: 'tap' }]);
    // 75 units = 25 CSS px: a swipe.
    g.update([at3('down', 0)], null, 100);
    expect(g.update([at3('move', 75)], null, 116)).toMatchObject([{ type: 'swipe' }]);
  });
});
