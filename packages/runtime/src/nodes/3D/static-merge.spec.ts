import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';

import { GeometryMesh } from './GeometryMesh';
import { Node3D } from '../Node3D';
import {
  bakeVertexLighting,
  clearMergeCache,
  mergeStatic,
  subdivideGeometry,
  sunDirectionFromCamera,
  TriangleBVH,
  unmergeStatic,
} from './static-merge';

const part = (
  id: string,
  position: [number, number, number],
  size: [number, number, number],
  color = '#808080'
) =>
  new GeometryMesh({
    id,
    name: id,
    position: new Vector3(...position),
    geometry: 'box',
    size,
    material: { type: 'lambert', color },
  });

const visibleMeshes = (root: Node3D) => {
  const out: Mesh[] = [];
  root.traverse(o => {
    let shown = true;
    for (let n: typeof o | null = o; n; n = n.parent) if (!n.visible) shown = false;
    if ((o as Mesh).isMesh && shown) out.push(o as Mesh);
  });
  return out;
};

const model = () => {
  const root = new Node3D({ id: 'root', name: 'root' });
  root.add(part('floor', [0, -0.05, 0], [2, 0.1, 2], '#ffffff'));
  root.add(part('block', [0, 0.5, 0], [0.5, 1, 0.5], '#ff0000'));
  return root;
};

describe('mergeStatic', () => {
  it('draws the static parts as one mesh and hides them; unmergeStatic restores them', () => {
    const root = model();
    const result = mergeStatic(root);
    expect(result.merged).toBe(2);
    expect(visibleMeshes(root)).toHaveLength(1);
    const color = visibleMeshes(root)[0].geometry.getAttribute('color') as BufferAttribute;
    expect(color.count).toBe(72);
    unmergeStatic(root);
    expect(visibleMeshes(root)).toHaveLength(2);
  });

  it('leaves parts under a node with a component alone', () => {
    const root = model();
    const spinner = new Node3D({ id: 'spinner', name: 'spinner' });
    spinner.add(part('sail', [0, 2, 0], [0.1, 0.5, 0.1]));
    (spinner.components as unknown[]).push({ type: 'core:Rotate' });
    root.add(spinner);
    mergeStatic(root);
    const names = visibleMeshes(root).map(m => m.name);
    expect(names).toContain('sail-Mesh');
    expect(names.filter(n => n.startsWith('merged-'))).toHaveLength(1);
  });

  it('bakes shadow and occlusion: the floor beside the block is darker than its open corner', () => {
    const root = model();
    mergeStatic(root, { bake: { sunDirection: [1, 1, 0], aoSamples: 16, subdivide: 0.1 } });
    const mesh = visibleMeshes(root)[0];
    expect(mesh.material).toBeInstanceOf(MeshBasicMaterial);
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
    const col = mesh.geometry.getAttribute('color') as BufferAttribute;
    const at = (x: number, z: number) => {
      let best = -1;
      let dist = Infinity;
      for (let i = 0; i < pos.count; i += 1) {
        if (Math.abs(pos.getY(i)) > 1e-3) continue; // the floor's top face
        const d = Math.hypot(pos.getX(i) - x, pos.getZ(i) - z);
        if (d < dist) [best, dist] = [i, d];
      }
      return col.getX(best);
    };
    // The sun comes from +x, so -x of the block is in its shadow.
    expect(at(-0.4, 0)).toBeLessThan(at(0.9, 0.9) * 0.6);
  });

  it('keeps an unlit (basic) part its own colour in a bake, graded or not: a lit window', () => {
    const own = new Color('#ff8040');
    for (const look of [{}, { exposure: 2, saturation: 0 }]) {
      const root = model();
      const lamp = new GeometryMesh({
        id: 'lamp',
        name: 'lamp',
        position: new Vector3(-0.6, 0.1, 0),
        geometry: 'box',
        size: [0.1, 0.1, 0.1],
        material: { type: 'basic', color: '#ff8040' },
      });
      root.add(lamp);
      mergeStatic(root, { bake: { aoSamples: 8, subdivide: false, ...look } });
      const mesh = visibleMeshes(root)[0];
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      const col = mesh.geometry.getAttribute('color') as BufferAttribute;
      expect(mesh.geometry.getAttribute('pix3Lit')).toBeUndefined();
      let lampVertices = 0;
      for (let i = 0; i < pos.count; i += 1) {
        if (pos.getX(i) > -0.54 || pos.getY(i) < 0.04) continue; // the lamp's vertices only
        lampVertices += 1;
        expect([col.getX(i), col.getY(i), col.getZ(i)]).toEqual(
          [own.r, own.g, own.b].map(Math.fround)
        );
      }
      expect(lampVertices).toBeGreaterThan(0);
    }
  });

  it('reuses the geometry of an earlier merge with the same cache key', () => {
    clearMergeCache();
    const first = mergeStatic(model(), { bake: { aoSamples: 4 }, cacheKey: 'k' });
    const second = mergeStatic(model(), { bake: { aoSamples: 4 }, cacheKey: 'k' });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.meshes[0].geometry).toBe(first.meshes[0].geometry);
    clearMergeCache();
  });
});

/** The baked colour buffer of {@link model} (small: no subdivision, 4 AO rays). */
const bakedColors = (bake: object = {}) => {
  const root = model();
  mergeStatic(root, {
    bake: { sunDirection: [1, 1, 0.3], aoSamples: 4, subdivide: false, ...bake },
  });
  const color = visibleMeshes(root)[0].geometry.getAttribute('color') as BufferAttribute;
  return color.array as Float32Array;
};

/** FNV-1a over the float bits: equal only when every value is bit-identical. */
const fingerprint = (values: Float32Array) => {
  let h = 0x811c9dc5;
  for (const word of new Uint32Array(values.buffer, values.byteOffset, values.length)) {
    h = Math.imul(h ^ word, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

describe('bake look controls', () => {
  it('without exposure / saturation the bake is bit-identical to the one before they existed', () => {
    const plain = bakedColors();
    expect(plain.length).toBe(216);
    expect(fingerprint(plain)).toBe('5c79692b');
    expect(Array.from(plain.slice(0, 3), v => Number(v.toFixed(5)))).toEqual([
      0.93009, 0.84952, 0.76043,
    ]);
    expect(fingerprint(bakedColors({ exposure: 1, saturation: 1 }))).toBe(fingerprint(plain));
    expect(fingerprint(bakedColors({ aoBackFaces: true }))).toBe(fingerprint(plain));
  });

  it('exposure scales and saturation spreads around luma, in linear RGB, then clips to 0..1', () => {
    const plain = bakedColors();
    const bright = bakedColors({ exposure: 1.5 });
    const grey = bakedColors({ saturation: 0 });
    const rich = bakedColors({ exposure: 1.2, saturation: 1.6 });
    const clip = (v: number) => Math.min(1, Math.max(0, v));
    for (let i = 0; i < plain.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        expect(bright[i + k]).toBeCloseTo(Math.min(1, plain[i + k] * 1.5), 5);
      }
      const luma = 0.2126 * plain[i] + 0.7152 * plain[i + 1] + 0.0722 * plain[i + 2];
      for (let k = 0; k < 3; k += 1) {
        const exposed = plain[i + k] * 1.2;
        expect(rich[i + k]).toBeCloseTo(clip(luma * 1.2 + (exposed - luma * 1.2) * 1.6), 5);
      }
      expect([grey[i], grey[i + 1], grey[i + 2]].map(v => Number(v.toFixed(5)))).toEqual(
        Array(3).fill(Number(Math.min(1, luma).toFixed(5)))
      );
    }
  });
});

describe('shared bake rays', () => {
  /** {@link model} merged, not baked: 72 non-indexed vertices, 48 distinct position + normal. */
  const unbaked = () => {
    const root = model();
    mergeStatic(root);
    return visibleMeshes(root)[0].geometry.clone();
  };
  const bake = { sunDirection: [1, 1, 0.3], aoSamples: 4, subdivide: false };

  it('casts one set of rays per position and normal: copies share, a hard edge does not', () => {
    const rays = vi.spyOn(TriangleBVH.prototype, 'occluded');
    try {
      bakeVertexLighting(unbaked(), { ...bake, shadows: false });
      // 2 boxes × 8 corners × 3 faces' normals, 4 AO rays each — not 72 vertices, not 16 corners.
      expect(rays).toHaveBeenCalledTimes(48 * 4);
    } finally {
      rays.mockRestore();
    }
  });

  it('a vertex that shares gets the colour it gets baked on its own', () => {
    const shared = bakedColors();
    const source = unbaked();
    const pos = source.getAttribute('position') as BufferAttribute;
    const nor = source.getAttribute('normal') as BufferAttribute;
    const same = (a: number, b: number) =>
      [pos, nor].every(
        at => at.getX(a) === at.getX(b) && at.getY(a) === at.getY(b) && at.getZ(a) === at.getZ(b)
      );
    let copies = 0;
    for (let i = 0; i < pos.count; i += 1) {
      // Turn every copy of vertex i the other way round: nothing shares with it any more, and
      // the occluders (positions only) stay as they were.
      const alone = source.clone();
      const normals = alone.getAttribute('normal') as BufferAttribute;
      for (let j = 0; j < pos.count; j += 1) {
        if (j === i || !same(i, j)) continue;
        normals.setXYZ(j, -nor.getX(j), -nor.getY(j), -nor.getZ(j));
        copies += 1;
      }
      const color = bakeVertexLighting(alone, bake).getAttribute('color') as BufferAttribute;
      expect([color.getX(i), color.getY(i), color.getZ(i)]).toEqual(
        Array.from(shared.slice(i * 3, i * 3 + 3))
      );
    }
    expect(copies).toBeGreaterThan(0);
  });
});

describe('aoBackFaces', () => {
  it('false: a vertex buried inside another part is not blacked out by that part', () => {
    // A plate sunk halfway into a block: its bottom vertices sit inside the block.
    const sunk = (aoBackFaces?: boolean) => {
      const root = new Node3D({ id: 'root', name: 'root' });
      root.add(part('block', [0, -0.5, 0], [2, 1, 2], '#ffffff'));
      root.add(part('plate', [0, 0, 0], [1, 0.1, 1], '#ffffff'));
      const bake = {
        sunDirection: [0, 1, 0],
        aoSamples: 16,
        aoDistance: 3,
        subdivide: false,
        aoBackFaces,
      };
      mergeStatic(root, { bake });
      const mesh = visibleMeshes(root)[0];
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      const col = mesh.geometry.getAttribute('color') as BufferAttribute;
      let buried = 0;
      for (let i = 0; i < pos.count; i += 1) {
        if (Math.abs(pos.getY(i) + 0.05) < 1e-4) buried += col.getX(i);
      }
      return buried;
    };
    expect(sunk()).toBeLessThan(0.5);
    expect(sunk(false)).toBeGreaterThan(sunk() + 1);
  });
});

describe('sunDirectionFromCamera', () => {
  /** A map camera heading (-0.707, -0.707) in XZ, looking down 40°. */
  const mapCamera = () => {
    const camera = new PerspectiveCamera();
    camera.position.set(10, 10 * Math.tan((40 * Math.PI) / 180) * Math.SQRT2, 10);
    camera.lookAt(0, 0, 0);
    return camera;
  };

  it('places the sun relative to the camera heading: 40° to its left, 50° up', () => {
    const [x, y, z] = sunDirectionFromCamera(mapCamera(), { azimuth: 40, elevation: 50 });
    expect(x).toBeCloseTo(0.056, 3);
    expect(y).toBeCloseTo(0.766, 3);
    expect(z).toBeCloseTo(0.64, 3);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    // Azimuth 0: straight from behind the camera.
    const [bx, , bz] = sunDirectionFromCamera(mapCamera(), { azimuth: 0, elevation: 0 });
    expect([bx, bz].map(v => Number(v.toFixed(4)))).toEqual([0.7071, 0.7071]);
  });

  it('a camera looking straight down takes its up vector as the heading; bad angles throw', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(0, 10, 0);
    camera.up.set(0, 0, -1); // the top of the screen is -Z
    camera.lookAt(0, 0, 0);
    const [x, y, z] = sunDirectionFromCamera(camera, { azimuth: 0, elevation: 0 });
    expect([x, y, z].map(v => Number(v.toFixed(5)) + 0)).toEqual([0, 0, 1]);
    expect(() => sunDirectionFromCamera(camera, { azimuth: Number.NaN, elevation: 0 })).toThrow(
      RangeError
    );
  });
});

describe('subdivideGeometry', () => {
  it('splits only the faces `accept` passes (the bake: those facing the sun)', () => {
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    const all = subdivideGeometry(box, 0.3).getAttribute('position').count;
    const top = subdivideGeometry(box, 0.3, n => n.y > 0.5).getAttribute('position').count;
    // 12 triangles; only the 2 of the top face are split.
    expect(top).toBe(30 + (all - 36) / 6 + 6);
    expect(top).toBeLessThan(all);
  });
});

describe('TriangleBVH', () => {
  it('finds a triangle in front and ignores one behind or beyond reach', () => {
    const bvh = new TriangleBVH(new Float32Array([-1, -1, 2, 1, -1, 2, 0, 1, 2]));
    const origin = new Vector3(0, 0, 0);
    expect(bvh.occluded(origin, new Vector3(0, 0, 1), 10, 1e-4)).toBe(true);
    expect(bvh.occluded(origin, new Vector3(0, 0, -1), 10, 1e-4)).toBe(false);
    expect(bvh.occluded(origin, new Vector3(0, 0, 1), 1, 1e-4)).toBe(false);
    // The triangle faces +z: the ray meets its back, which `frontOnly` ignores.
    expect(bvh.occluded(origin, new Vector3(0, 0, 1), 10, 1e-4, true)).toBe(false);
    expect(bvh.occluded(new Vector3(0, 0, 4), new Vector3(0, 0, -1), 10, 1e-4, true)).toBe(true);
  });
});
