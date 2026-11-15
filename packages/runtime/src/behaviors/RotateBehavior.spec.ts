import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Node3D } from '../nodes/Node3D';
import { RotateBehavior } from './RotateBehavior';

function spin(config: Record<string, unknown>, yaw = 0): Node3D {
  const node = new Node3D({ id: 'wheel', name: 'wheel' });
  node.rotation.y = yaw;
  const behavior = new RotateBehavior('rotate', 'core:Rotate');
  behavior.node = node;
  Object.assign(behavior.config, config);
  behavior.onAttach();
  behavior.onUpdate(0.5);
  return node;
}

describe('RotateBehavior', () => {
  it('turns about Y by default, rotationSpeed radians a second', () => {
    const node = spin({ rotationSpeed: 2 });
    expect(node.rotation.y).toBeCloseTo(1);
    expect(node.rotation.x).toBeCloseTo(0);
  });

  it('turns about its own Z with axis: z, even when the node is yawed', () => {
    const node = spin({ rotationSpeed: Math.PI, axis: 'z' }, Math.PI / 2);
    // Half a second at π rad/s: a quarter turn about the node's own Z (which the yaw pointed along world X).
    const axisZ = new Vector3(0, 0, 1).applyQuaternion(node.quaternion);
    expect(axisZ.x).toBeCloseTo(1);
    const up = new Vector3(0, 1, 0).applyQuaternion(node.quaternion);
    expect(Math.abs(up.y)).toBeLessThan(1e-6);
  });

  it('falls back to Y on an unknown axis', () => {
    const node = spin({ rotationSpeed: 2, axis: 'w' });
    expect(node.rotation.y).toBeCloseTo(1);
  });
});
