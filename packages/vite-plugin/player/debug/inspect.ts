import { getNodePropertySchema, getPropertyDisplayValue, NodeBase } from '@pix3/runtime';
import * as THREE from 'three';

import { DEBUG_HELPER_FLAG } from './tree';

/**
 * One live object in detail (`__PIX3_PLAYER__.debug.node(id)`, the Scene tab's detail pane) and
 * the highlight box drawn around it in the running game. Dev only, unlike `tree.ts`: it uses
 * three.js and the runtime's property schema, which the page already loaded.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Transform {
  readonly position: Vec3;
  readonly rotationDeg: Vec3;
  readonly scale: Vec3;
}

export interface LiveMaterial {
  readonly type: string;
  readonly color?: string;
  readonly opacity?: number;
  readonly transparent?: boolean;
  readonly map: boolean;
  readonly side?: string;
}

export interface LiveObjectDetail {
  readonly id: string;
  readonly nodeId: string | null;
  readonly type: string;
  readonly name: string;
  readonly visible: boolean;
  readonly renderOrder: number;
  readonly layers: readonly number[];
  readonly instances: number | null;
  readonly childCount: number;
  readonly world: Transform;
  readonly local: Transform;
  readonly geometry: {
    readonly type: string;
    readonly vertices: number | null;
    readonly params: Record<string, string>;
  } | null;
  readonly materials: readonly LiveMaterial[];
  /** Scalars of `userData` (`_private` keys left out), objects by their class name. */
  readonly userData: Record<string, string>;
  /** A node's script components, by type (`core:spin`, `user:Foo`). */
  readonly components: readonly string[];
  /** A node's inspector properties as the inspector shows them (the live values). */
  readonly properties: Record<string, string>;
}

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const vec = (v: Vec3): Vec3 => ({ x: round(v.x, 3), y: round(v.y, 3), z: round(v.z, 3) });
const degrees = (e: THREE.Euler): Vec3 => {
  const d = 180 / Math.PI;
  return { x: round(e.x * d, 1), y: round(e.y * d, 1), z: round(e.z * d, 1) };
};

const describeValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return String(value);
};

const SIDES: Record<number, string> = {
  [THREE.FrontSide]: 'Front',
  [THREE.BackSide]: 'Back',
  [THREE.DoubleSide]: 'Double',
};

const materialOf = (material: THREE.Material): LiveMaterial => {
  const m = material as THREE.Material & { color?: THREE.Color; map?: unknown };
  return {
    type: m.type,
    ...(m.color instanceof THREE.Color ? { color: `#${m.color.getHexString()}` } : {}),
    ...(m.opacity !== 1 ? { opacity: round(m.opacity, 2) } : {}),
    ...(m.transparent ? { transparent: true } : {}),
    map: !!m.map,
    ...(SIDES[m.side] ? { side: SIDES[m.side] } : {}),
  };
};

const nodeFields = (
  object: THREE.Object3D
): Pick<LiveObjectDetail, 'components' | 'properties'> => {
  if (!(object instanceof NodeBase)) return { components: [], properties: {} };
  const properties: Record<string, string> = {};
  for (const property of getNodePropertySchema(object).properties) {
    try {
      properties[property.name] = getPropertyDisplayValue(object, property);
    } catch (error) {
      properties[property.name] = `(${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return { components: object.components.map(component => component.type), properties };
};

/** The detail of a live object, read now. */
export const liveObjectDetail = (object: THREE.Object3D): LiveObjectDetail => {
  object.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(position, quaternion, scale);
  const mesh = object as Partial<THREE.Mesh> & THREE.Object3D;
  const geometry = mesh.geometry as
    | (THREE.BufferGeometry & { parameters?: Record<string, unknown> })
    | undefined;
  const material = mesh.material;
  const userData: Record<string, string> = {};
  for (const [key, value] of Object.entries(object.userData ?? {})) {
    if (!key.startsWith('_')) userData[key] = describeValue(value);
  }
  const instanced = object as Partial<THREE.InstancedMesh>;
  const layers: number[] = [];
  for (let i = 0; i < 32; i += 1) if (object.layers.isEnabled(i)) layers.push(i);
  return {
    id: object.uuid,
    nodeId: object instanceof NodeBase ? object.nodeId : null,
    type: object.type || 'Object3D',
    name: object.name,
    visible: object.visible,
    renderOrder: object.renderOrder,
    layers,
    instances: instanced.isInstancedMesh ? (instanced.count ?? null) : null,
    childCount: object.children.length,
    world: {
      position: vec(position),
      rotationDeg: degrees(new THREE.Euler().setFromQuaternion(quaternion)),
      scale: vec(scale),
    },
    local: {
      position: vec(object.position),
      rotationDeg: degrees(object.rotation),
      scale: vec(object.scale),
    },
    geometry: geometry?.isBufferGeometry
      ? {
          type: geometry.type,
          vertices: geometry.attributes.position?.count ?? null,
          params: Object.fromEntries(
            Object.entries(geometry.parameters ?? {})
              .filter(([, value]) => typeof value !== 'object')
              .map(([key, value]) => [key, String(value)])
          ),
        }
      : null,
    materials: material ? (Array.isArray(material) ? material : [material]).map(materialOf) : [],
    userData,
    ...nodeFields(object),
  };
};

/** The editor's accent (#ffcf33), as the overlay's title. */
const HIGHLIGHT_COLOR = 0xffcf33;
/** Half a unit around an object with no extent (a camera, an empty group, a pool at rest). */
const MARKER_SIZE = 0.5;

/**
 * A box around one live object, drawn into the running scene on that object's layers: a 3D
 * object gets a box in the 3D pass, a 2D node a frame in the 2D pass. It follows the object on
 * {@link update}; it is flagged so the tree leaves it out.
 */
export class LiveHighlight {
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private helper: THREE.Box3Helper | null = null;

  /** Fit the box to `target` and hang it under `root` (the live scene). */
  update(target: THREE.Object3D, root: THREE.Object3D): void {
    target.updateWorldMatrix(true, false);
    this.box.setFromObject(target);
    this.box.getSize(this.size);
    if (this.box.isEmpty() || Math.max(this.size.x, this.size.y, this.size.z) < 1e-3) {
      const origin = target.getWorldPosition(new THREE.Vector3());
      this.box.setFromCenterAndSize(origin, this.size.setScalar(MARKER_SIZE));
    }
    if (!this.helper) {
      this.helper = new THREE.Box3Helper(this.box, HIGHLIGHT_COLOR);
      const material = this.helper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      this.helper.renderOrder = 100_000;
      this.helper.userData[DEBUG_HELPER_FLAG] = true;
      this.helper.raycast = () => {};
    }
    this.helper.layers.mask = target.layers.mask;
    if (this.helper.parent !== root) root.add(this.helper);
  }

  clear(): void {
    if (!this.helper) return;
    this.helper.removeFromParent();
    this.helper.geometry.dispose();
    (this.helper.material as THREE.Material).dispose();
    this.helper = null;
  }
}
