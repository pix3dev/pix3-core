/**
 * RotateBehavior (`core:Rotate`) — spins a 3D node continuously about one of its own axes:
 * `y` (the default: a turntable, a weather vane) or `x` / `z` (a mill's sails, a pulley wheel,
 * a gear on a wall) at `rotationSpeed` radians per second.
 */

import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { Node3D } from '../nodes/Node3D';

type RotateAxis = 'x' | 'y' | 'z';

export class RotateBehavior extends Script {
  private rotationSpeed = 1.0; // radians per second

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      rotationSpeed: this.rotationSpeed,
      axis: 'y',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'RotateBehavior',
      properties: [
        {
          name: 'rotationSpeed',
          type: 'number',
          ui: {
            label: 'Rotation Speed',
            description: 'Speed of rotation in radians per second',
            group: 'Component',
            min: 0,
            max: 10,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as RotateBehavior).getRotationSpeed(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as RotateBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.setRotationSpeed(parsed);
          },
        },
        {
          name: 'axis',
          type: 'select',
          ui: {
            label: 'Axis',
            description:
              "The node's own axis to spin about (y: a turntable; x or z: a wheel on edge)",
            group: 'Component',
            options: ['x', 'y', 'z'],
          },
          getValue: (component: unknown) => (component as RotateBehavior).getAxis(),
          setValue: (component: unknown, value: unknown) => {
            if (value === 'x' || value === 'y' || value === 'z')
              (component as RotateBehavior).config.axis = value;
          },
        },
      ],
      groups: {
        Component: {
          label: 'Component Parameters',
          description: 'Configuration for rotation component',
          expanded: true,
        },
      },
    };
  }

  onAttach(): void {
    this.setRotationSpeed(this.getRotationSpeed());
  }

  onUpdate(dt: number): void {
    if (!this.node || !(this.node instanceof Node3D)) {
      return;
    }

    const angle = this.rotationSpeed * dt;
    const axis = this.getAxis();
    // y keeps the Euler step it always had; x and z turn about the node's own axis, so a wheel
    // yawed to face any way still spins on edge.
    if (axis === 'y') this.node.rotation.y += angle;
    else if (axis === 'x') this.node.rotateX(angle);
    else this.node.rotateZ(angle);
  }

  private getAxis(): RotateAxis {
    const axis = this.config.axis;
    return axis === 'x' || axis === 'z' ? axis : 'y';
  }

  private getRotationSpeed(): number {
    const raw = this.config.rotationSpeed;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
  }

  private setRotationSpeed(value: number): void {
    this.rotationSpeed = value;
    this.config.rotationSpeed = value;
  }
}
