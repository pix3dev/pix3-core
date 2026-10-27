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
    expect(g.update([ev('up', 50, 50, 2)], null, 400)).toEqual([]);
    g.update([ev('down', 5, 5, 3)], null, 500);
    expect(g.update([ev('up', 5, 5, 3)], null, 520)).toMatchObject([{ type: 'tap', pointerId: 3 }]);
  });
});
