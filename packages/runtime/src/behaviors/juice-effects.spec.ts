import { describe, expect, it } from 'vitest';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { Node3D } from '../nodes/Node3D';
import { ShakeBehavior } from './ShakeBehavior';
import { PunchScaleBehavior } from './PunchScaleBehavior';
import { PopInBehavior } from './PopInBehavior';

function makeNode(): NodeBase {
  return new NodeBase({ id: 'n', type: 'Node', name: 'Node' });
}

describe('ShakeBehavior', () => {
  it('displaces the node while active and restores exactly when finished', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 10, frequency: 20, duration: 0.2, decay: 1 });

    shake.onUpdate(0.05);
    const displaced = Math.abs(node.position.x) + Math.abs(node.position.y);
    expect(displaced).toBeGreaterThan(0);
    expect(Math.abs(node.position.x)).toBeLessThanOrEqual(10); // within amplitude

    // Advance past the duration → offset removed, back to origin.
    shake.onUpdate(0.2);
    expect(node.position.x).toBeCloseTo(0, 6);
    expect(node.position.y).toBeCloseTo(0, 6);
  });

  it('is additive: it re-centers on whatever else moved the node and leaves no residue', () => {
    const node = makeNode();
    node.position.set(100, 0, 0);
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 5, frequency: 30, duration: 0.2, decay: 1 });

    shake.onUpdate(0.05);
    expect(node.position.x).toBeGreaterThan(95);
    expect(node.position.x).toBeLessThan(105);

    // Simulate another writer (e.g. a mover) advancing the node by a delta
    // between frames — shake removes its prior offset first, so it re-centers
    // on the new base rather than accumulating.
    node.position.x += 100;
    shake.onUpdate(0.05);
    expect(node.position.x).toBeGreaterThan(195);
    expect(node.position.x).toBeLessThan(205);

    // Finish: the offset is subtracted, leaving the moved base intact.
    shake.onUpdate(0.2);
    expect(node.position.x).toBeCloseTo(200, 6);
  });

  it('stop() restores the position immediately', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 8, duration: 0, frequency: 20 }); // duration 0 → runs until stopped
    shake.onUpdate(0.016);
    expect(Math.abs(node.position.x) + Math.abs(node.position.y)).toBeGreaterThan(0);
    shake.stop();
    expect(node.position.x).toBeCloseTo(0, 6);
    expect(node.position.y).toBeCloseTo(0, 6);
  });

  it('triggers on a node signal when configured', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.config.triggerEvent = 'hit';
    shake.config.amplitude = 6;
    shake.config.frequency = 20;
    shake.config.duration = 0.3;
    shake.onStart(); // binds the trigger

    shake.onUpdate(0.05);
    expect(node.position.x).toBe(0); // not triggered yet

    node.emit('hit');
    shake.onUpdate(0.05);
    expect(Math.abs(node.position.x) + Math.abs(node.position.y)).toBeGreaterThan(0);

    shake.onDetach();
  });
});

describe('ShakeBehavior: the strongest shake wins', () => {
  it('ignores a request weaker than the shake playing now, and leaves the config alone', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 20, frequency: 20, duration: 1, decay: 1 });
    shake.onUpdate(0.1); // strength now 20 × 0.9 = 18

    shake.play({ amplitude: 6, duration: 0.2 });
    expect(shake.config.amplitude).toBe(8); // options never reach the config
    expect(shake.config.duration).toBe(0.35);
    shake.onUpdate(0.5);
    expect(node.position.length()).toBeGreaterThan(0); // the strong one still plays at 0.6 s

    // Its tail (20 × 0.1 = 2 at 0.9 s) no longer blocks the next blow.
    shake.onUpdate(0.3);
    shake.play({ amplitude: 6, duration: 0.2 });
    expect(shake.config.amplitude).toBe(8); // the options were for that shake only
    shake.onUpdate(0.25);
    expect(node.position.length()).toBe(0); // the new 0.2 s shake ran out, not the old 1 s one
  });

  it('an equal request restarts it (a signal re-trigger keeps working)', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 8, duration: 0.2, decay: 0 });
    shake.onUpdate(0.15);
    shake.trigger();
    shake.onUpdate(0.15); // 0.3 s since the first start, 0.15 s since the restart
    expect(node.position.length()).toBeGreaterThan(0);
  });
});

describe('ShakeBehavior: direction', () => {
  it('shakes along one axis only, from the options or the config', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    const angle = Math.PI / 6;
    shake.play({ amplitude: 10, frequency: 13, duration: 1, direction: angle });
    for (let i = 0; i < 5; i++) {
      shake.onUpdate(0.07);
      const { x, y } = node.position;
      expect(Math.hypot(x, y)).toBeGreaterThan(0);
      expect(Math.abs(x * Math.sin(angle) - y * Math.cos(angle))).toBeLessThan(1e-9);
    }
    shake.stop();
    expect(shake.config.direction).toBeUndefined(); // for that request only

    shake.config.direction = Math.PI / 2;
    shake.trigger();
    shake.onUpdate(0.07);
    expect(node.position.x).toBeCloseTo(0, 9);
    expect(Math.abs(node.position.y)).toBeGreaterThan(0);
  });

  it('`direction` is a config key of core:Shake; clearing it means every direction', () => {
    const schema = ShakeBehavior.getPropertySchema();
    const direction = schema.properties.find(p => p.name === 'direction')!;
    const shake = new ShakeBehavior('shake', 'core:Shake');
    direction.setValue(shake, 1.2);
    expect(direction.getValue(shake)).toBe(1.2);
    direction.setValue(shake, '');
    expect('direction' in shake.config).toBe(false);
    expect(direction.getValue(shake)).toBeNull();
  });
});

describe('PunchScaleBehavior', () => {
  it('pops the scale up immediately and settles back to the resting scale', () => {
    const node = makeNode();
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ amount: 0.5, duration: 0.2, vibrato: 1 });

    punch.onUpdate(0.001);
    expect(node.scale.x).toBeGreaterThan(1); // instant pop

    punch.onUpdate(0.2);
    expect(node.scale.x).toBeCloseTo(1, 6);
    expect(node.scale.y).toBeCloseTo(1, 6);
  });

  it('restores a non-uniform authored scale', () => {
    const node = makeNode();
    node.scale.set(2, 3, 1);
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ amount: 0.4, duration: 0.15, vibrato: 2 });

    punch.onUpdate(0.05);
    // scaled uniformly around the authored ratio
    expect(node.scale.y / node.scale.x).toBeCloseTo(3 / 2, 5);

    punch.onUpdate(0.15);
    expect(node.scale.x).toBeCloseTo(2, 6);
    expect(node.scale.y).toBeCloseTo(3, 6);
    expect(node.scale.z).toBeCloseTo(1, 6);
  });
});

describe('PunchScaleBehavior: squash & stretch (axis)', () => {
  const play = (node: NodeBase, axis: 'x' | 'y', amount: number): PunchScaleBehavior => {
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ amount, duration: 0.3, vibrato: 2, axis });
    return punch;
  };

  it("2D 'y': the height stretches, the width compensates, the area is kept", () => {
    const node = new Node2D({ id: 'n', name: 'n' });
    node.scale.set(2, 3, 1);
    const punch = play(node, 'y', 0.3);
    for (const dt of [0.001, 0.05, 0.05, 0.05]) {
      punch.onUpdate(dt);
      expect(node.scale.x * node.scale.y).toBeCloseTo(6, 9);
      expect(node.scale.z).toBe(1);
    }
    punch.onUpdate(0.3);
    expect(node.scale.toArray()).toEqual([2, 3, 1]);
  });

  it("3D 'x': the other two axes take 1/√f, the volume is kept", () => {
    const node = new Node3D({ id: 'n', name: 'n' });
    const punch = play(node, 'x', 0.4);
    punch.onUpdate(0.001);
    expect(node.scale.x).toBeGreaterThan(1.3);
    expect(node.scale.y).toBeCloseTo(node.scale.z, 12);
    expect(node.scale.x * node.scale.y * node.scale.z).toBeCloseTo(1, 9);
    punch.onUpdate(0.3);
    expect(node.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('a negative amount squashes first; the axis never goes below ×0.1', () => {
    const node = new Node2D({ id: 'n', name: 'n' });
    const punch = play(node, 'y', -0.25);
    punch.onUpdate(0.001);
    expect(node.scale.y).toBeLessThan(0.8);
    expect(node.scale.x).toBeGreaterThan(1.2);

    const deep = new Node2D({ id: 'd', name: 'd' });
    const crushed = play(deep, 'y', -5); // clamped to -0.9 → f = 0.1 at the start
    crushed.onUpdate(0);
    expect(deep.scale.y).toBeCloseTo(0.1, 6);
    expect(deep.scale.x).toBeCloseTo(10, 6);
  });

  it('a re-trigger mid-punch does not take the deformed scale as the rest', () => {
    const node = new Node2D({ id: 'n', name: 'n' });
    const punch = play(node, 'y', 0.3);
    punch.onUpdate(0.02);
    punch.play({ axis: 'y' });
    punch.onUpdate(0.35); // the default duration: the first call's 0.3 s is not kept
    expect(node.scale.toArray()).toEqual([1, 1, 1]);
  });
});

describe('PopInBehavior', () => {
  it('scales from zero up to the authored scale', () => {
    const node = makeNode();
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    pop.config.playOnStart = false;
    pop.onStart(); // captures base (1,1,1)
    pop.play({ from: 0, duration: 0.2, easing: 'linear' });

    // Snaps to the starting scale on trigger.
    expect(node.scale.x).toBeCloseTo(0, 6);

    pop.onUpdate(0.1); // halfway, linear → 0.5
    expect(node.scale.x).toBeCloseTo(0.5, 5);

    pop.onUpdate(0.1); // done → authored scale
    expect(node.scale.x).toBeCloseTo(1, 6);
  });

  it('auto-plays on start by default', () => {
    const node = makeNode();
    node.scale.set(2, 2, 2);
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    // playOnStart defaults to true.
    pop.onStart();
    // Snapped down to `from` (0) × authored scale.
    expect(node.scale.x).toBeCloseTo(0, 6);

    pop.onUpdate(1); // long tick → completes to authored scale
    expect(node.scale.x).toBeCloseTo(2, 6);
  });

  it('a node pre-shrunk to 0 pops up to scale 1, not to 0 (core-tests/game7)', () => {
    const node = makeNode();
    node.scale.set(0, 0, 1);
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    pop.config.playOnStart = false;
    pop.onStart();
    pop.play({ from: 0, duration: 0.2, easing: 'linear' });
    pop.onUpdate(0.1);
    expect(node.scale.x).toBeCloseTo(0.5, 5);
    pop.onUpdate(0.1);
    expect([node.scale.x, node.scale.y, node.scale.z]).toEqual([1, 1, 1]);
  });

  it('a mirrored node keeps its sign', () => {
    const node = makeNode();
    node.scale.set(-2, 2, 1);
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    pop.onStart();
    pop.onUpdate(1);
    expect([node.scale.x, node.scale.y]).toEqual([-2, 2]);
  });
});

describe('juice options are for that play only', () => {
  it('punchScale: an omitted option is the config’s, never a previous call’s', () => {
    const node = new Node2D({ id: 'n', name: 'n' });
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ axis: 'y', vibrato: 2, amount: -0.25, duration: 0.2 });
    punch.onUpdate(0.001);
    expect(node.scale.x).not.toBeCloseTo(node.scale.y, 3); // a squash
    punch.onUpdate(0.3);
    expect(punch.config).toMatchObject({ amount: 0.3, duration: 0.35, vibrato: 3 });
    expect(punch.config.axis).toBeUndefined();

    punch.play({ amount: 0.5 });
    punch.onUpdate(0.001);
    expect(node.scale.x).toBeCloseTo(node.scale.y, 12); // 'all' again, not the y-squash
    expect(node.scale.x).toBeGreaterThan(1.4);
    punch.onUpdate(0.3); // the default 0.35 s, not the 0.2 s of the first call
    expect(node.scale.x).not.toBe(1);
    punch.onUpdate(0.05);
    expect(node.scale.x).toBe(1);
  });

  it('punchScale: a signal trigger plays the authored config, an inspector edit lands mid-play', () => {
    const node = new Node2D({ id: 'n', name: 'n' });
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.config.triggerEvent = 'hit';
    punch.config.amount = 0.2;
    punch.onStart();
    punch.play({ amount: 0.8, axis: 'x' });
    punch.onUpdate(0.4);
    node.emit('hit');
    punch.onUpdate(0);
    expect(node.scale.x).toBeCloseTo(1.2, 9);
    expect(node.scale.y).toBeCloseTo(1.2, 9);

    const amount = PunchScaleBehavior.getPropertySchema().properties.find(
      p => p.name === 'amount'
    )!;
    amount.setValue(punch, 0.6);
    expect(amount.getValue(punch)).toBe(0.6);
    punch.trigger();
    punch.onUpdate(0);
    expect(node.scale.x).toBeCloseTo(1.6, 9);
    punch.onDetach();
  });

  it('punchScale: the inspector shows the config, not the play running now', () => {
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = new Node2D({ id: 'n', name: 'n' });
    punch.play({ amount: 0.9, axis: 'y' });
    const props = PunchScaleBehavior.getPropertySchema().properties;
    expect(props.find(p => p.name === 'amount')!.getValue(punch)).toBe(0.3);
    expect(props.find(p => p.name === 'axis')!.getValue(punch)).toBe('all');
  });

  it('popIn: an omitted option is the config’s, never a previous call’s', () => {
    const node = makeNode();
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    pop.config.playOnStart = false;
    pop.onStart();
    pop.play({ from: 0.5, duration: 0.2, easing: 'linear' });
    pop.onUpdate(0.2);
    expect(pop.config).toMatchObject({ from: 0, duration: 0.4, easing: 'backOut' });

    pop.play({ easing: 'linear' });
    expect(node.scale.x).toBeCloseTo(0, 9); // from 0, not 0.5
    pop.onUpdate(0.2);
    expect(node.scale.x).toBeCloseTo(0.5, 9); // half of the default 0.4 s
  });

  it('shake: an omitted option is the config’s, never a previous call’s', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 3, duration: 5, decay: 0 });
    shake.stop();
    expect(shake.config).toMatchObject({ amplitude: 8, duration: 0.35, decay: 1.5 });
    shake.play({ frequency: 30 });
    shake.onUpdate(0.4); // past the default 0.35 s: the 5 s of the first call did not stick
    expect(node.position.length()).toBe(0);
  });
});
