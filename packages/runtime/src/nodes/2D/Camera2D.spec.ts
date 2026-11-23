import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';

import { Node2D } from '../Node2D';
import { Camera2D, findActiveCamera2D } from './Camera2D';
import type { SceneService } from '../../core/SceneService';

function makeRoot(): Node2D {
  return new Node2D({ id: 'root', name: 'Root' });
}

const VIEW = { width: 800, height: 600 };

describe('Camera2D.solve — follow', () => {
  it('snaps to target + offset with zero damping', () => {
    const root = makeRoot();
    const target = new Node2D({ id: 'target', name: 'Target' });
    target.position.set(5, 2, 0);
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      followTargetId: 'target',
      followDamping: 0,
      followOffset: { x: 0, y: 1 },
    });
    root.add(target, cam);

    cam.solve(1);

    const pos = cam.getWorldPosition(new Vector3());
    expect(pos.x).toBeCloseTo(5);
    expect(pos.y).toBeCloseTo(3); // 2 + offset 1
  });

  it('eases toward the target over time with damping', () => {
    const root = makeRoot();
    const target = new Node2D({ id: 'target', name: 'Target' });
    target.position.set(10, 0, 0);
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      followTargetId: 'target',
      followDamping: 8,
    });
    root.add(target, cam);

    cam.solve(1 / 60);
    const x = cam.getWorldPosition(new Vector3()).x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(10);
  });

  it('leaves position untouched when there is no follow target', () => {
    const root = makeRoot();
    const cam = new Camera2D({ id: 'cam', name: 'Cam' });
    cam.position.set(3, 4, 0);
    root.add(cam);

    cam.solve(1);

    const pos = cam.getWorldPosition(new Vector3());
    expect(pos.x).toBeCloseTo(3);
    expect(pos.y).toBeCloseTo(4);
  });

  it('does not follow while the target stays inside the deadzone', () => {
    const root = makeRoot();
    const target = new Node2D({ id: 'target', name: 'Target' });
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      followTargetId: 'target',
      followDamping: 0,
      deadzone: { x: 2, y: 2 },
    });
    root.add(target, cam);

    target.position.set(1.5, 0, 0);
    cam.solve(1);
    expect(cam.getWorldPosition(new Vector3()).x).toBeCloseTo(0);

    target.position.set(5, 0, 0);
    cam.solve(1);
    expect(cam.getWorldPosition(new Vector3()).x).toBeCloseTo(3); // 5 - deadzone 2
  });
});

describe('Camera2D.computeView — offset / zoom / limits', () => {
  it('returns position + offset and zoom with limits off', () => {
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      offset: { x: 2, y: 1 },
      zoom: 2,
    });
    cam.position.set(10, 5, 0);

    const view = cam.computeView(VIEW);
    expect(view.x).toBeCloseTo(12);
    expect(view.y).toBeCloseTo(6);
    expect(view.zoom).toBeCloseTo(2);
  });

  it('clamps the center so the view edge never crosses the limits box', () => {
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      limitsEnabled: true,
      limitsCenter: { x: 0, y: 0 },
      limitsSize: { x: 1000, y: 1000 },
    });
    cam.position.set(1000, 0, 0);

    // half view = 400x300 at zoom 1 → free travel = 100 x, 200 y.
    const view = cam.computeView(VIEW);
    expect(view.x).toBeCloseTo(100);
    expect(view.y).toBeCloseTo(0);
  });

  it('tightens the clamp when zoomed out', () => {
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      zoom: 0.5,
      limitsEnabled: true,
      limitsCenter: { x: 0, y: 0 },
      limitsSize: { x: 1000, y: 1000 },
    });
    cam.position.set(1000, 0, 0);

    // half view at zoom 0.5 = 800 wide → free x = max(0, 500-800) = 0 → pinned.
    const view = cam.computeView(VIEW);
    expect(view.x).toBeCloseTo(0);
  });

  it('pins the center to limitsCenter when the box is smaller than the view', () => {
    const cam = new Camera2D({
      id: 'cam',
      name: 'Cam',
      limitsEnabled: true,
      limitsCenter: { x: 50, y: -20 },
      limitsSize: { x: 100, y: 100 },
    });
    cam.position.set(999, 999, 0);

    const view = cam.computeView(VIEW);
    expect(view.x).toBeCloseTo(50);
    expect(view.y).toBeCloseTo(-20);
  });
});

describe('Camera2D.shake', () => {
  it('produces a bounded additive offset that decays to zero by duration', () => {
    const cam = new Camera2D({ id: 'cam', name: 'Cam' });
    cam.shake({ amplitude: 10, frequency: 20, duration: 1, decay: 1 });

    cam.solve(0.5);
    const mid = cam.getShakeOffset(new Vector2());
    expect(Math.abs(mid.x)).toBeGreaterThan(0);
    expect(Math.abs(mid.x)).toBeLessThanOrEqual(10);
    expect(Math.abs(mid.y)).toBeLessThanOrEqual(10);

    cam.solve(0.6); // elapsed 1.1 >= duration → expired
    const end = cam.getShakeOffset(new Vector2());
    expect(end.x).toBe(0);
    expect(end.y).toBe(0);
  });

  it('is deterministic for a given elapsed time', () => {
    const a = new Camera2D({ id: 'a', name: 'A' });
    const b = new Camera2D({ id: 'b', name: 'B' });
    a.shake({ amplitude: 8, frequency: 24, duration: 2, decay: 1 });
    b.shake({ amplitude: 8, frequency: 24, duration: 2, decay: 1 });

    a.solve(0.3);
    b.solve(0.3);
    expect(a.getShakeOffset(new Vector2())).toEqual(b.getShakeOffset(new Vector2()));
  });

  it('never mutates node.position and clears on stopShake', () => {
    const cam = new Camera2D({ id: 'cam', name: 'Cam' });
    cam.position.set(3, 4, 0);
    cam.shake({ amplitude: 20, frequency: 30, duration: 1 });

    cam.solve(0.2);
    expect(cam.position.x).toBeCloseTo(3);
    expect(cam.position.y).toBeCloseTo(4);

    cam.stopShake();
    const off = cam.getShakeOffset(new Vector2());
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
  });
});

describe('Camera2D.shake — clock, strongest wins, direction', () => {
  it("advances by the runner's real delta, so it plays through a hitstop (scaled dt = 0)", () => {
    const cam = new Camera2D({ id: 'cam', name: 'Cam' });
    cam.scene = { time: { unscaledDeltaSec: 1 / 60 } } as unknown as SceneService;
    cam.shake({ amplitude: 10, frequency: 20, duration: 1, decay: 1 });
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      cam.solve(0);
      seen.add(cam.getShakeOffset(new Vector2()).x);
    }
    expect(seen.size).toBe(4);
  });

  it('ignores a weaker request and keeps its knobs', () => {
    const cam = new Camera2D({ id: 'cam', name: 'Cam', shakeAmplitude: 30 });
    cam.shake({ duration: 1, decay: 1 });
    cam.solve(0.1);
    cam.shake({ amplitude: 5, duration: 0.1 });
    expect(cam.serializeConfig()).toMatchObject({ shakeAmplitude: 30, shakeDuration: 1 });
    cam.solve(0.2); // past the weak request's 0.1 s: still the strong shake
    const off = cam.getShakeOffset(new Vector2());
    expect(off.x !== 0 || off.y !== 0).toBe(true);
  });

  it('shakes along `direction` only', () => {
    const cam = new Camera2D({ id: 'cam', name: 'Cam' });
    cam.shake({ amplitude: 10, duration: 1, direction: 0 });
    cam.solve(0.13);
    const off = cam.getShakeOffset(new Vector2());
    expect(off.y).toBeCloseTo(0, 12);
    expect(off.x).not.toBe(0);
  });
});

describe('findActiveCamera2D', () => {
  it('picks the highest-priority visible camera', () => {
    const root = makeRoot();
    const a = new Camera2D({ id: 'a', name: 'A', priority: 10 });
    const b = new Camera2D({ id: 'b', name: 'B', priority: 20 });
    root.add(a, b);
    expect(findActiveCamera2D([root])).toBe(b);
  });

  it('skips invisible cameras', () => {
    const root = makeRoot();
    const a = new Camera2D({ id: 'a', name: 'A', priority: 10 });
    const b = new Camera2D({ id: 'b', name: 'B', priority: 20 });
    b.visible = false;
    root.add(a, b);
    expect(findActiveCamera2D([root])).toBe(a);
  });

  it('breaks ties by DFS order (first wins)', () => {
    const root = makeRoot();
    const a = new Camera2D({ id: 'a', name: 'A', priority: 10 });
    const b = new Camera2D({ id: 'b', name: 'B', priority: 10 });
    root.add(a, b);
    expect(findActiveCamera2D([root])).toBe(a);
  });

  it('returns null when no camera exists', () => {
    const root = makeRoot();
    root.add(new Node2D({ id: 'x', name: 'X' }));
    expect(findActiveCamera2D([root])).toBeNull();
  });
});
