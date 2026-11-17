import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

import { GeometryMesh } from './GeometryMesh';
import {
  buildMeshGeometry,
  describeGeometryProblems,
  type GeometryBuildSpec,
} from './procedural-geometry';

const build = (spec: Partial<GeometryBuildSpec>) =>
  buildMeshGeometry({ kind: 'box', size: [1, 1, 1], ...spec });

/** Every face's normal points away from the centre of the bounds (a convex-ish closed solid). */
const facesPointOutward = (g: BufferGeometry): number => {
  const soup = g.index ? g.toNonIndexed() : g;
  const pos = soup.getAttribute('position') as BufferAttribute;
  soup.computeBoundingBox();
  const centre = soup.boundingBox!.getCenter(new Vector3());
  let outward = 0;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const mid = a.clone().add(b).add(c).divideScalar(3);
    const n = c.clone().sub(b).cross(a.clone().sub(b));
    if (n.dot(mid.sub(centre)) >= 0) outward += 1;
  }
  return outward / (pos.count / 3);
};

const size = (g: BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!.getSize(new Vector3());
};

describe('procedural geometry kinds', () => {
  it('extrude: the contour in XY, the depth centred on Z, the bevel inside both', () => {
    const g = build({
      kind: 'extrude',
      shape: {
        points: [
          [-1, 0],
          [1, 0],
          [1, 1],
          [-1, 1],
        ],
        depth: 0.5,
        bevel: 0.05,
      },
    });
    const s = size(g);
    expect(s.x).toBeCloseTo(2, 3);
    expect(s.y).toBeCloseTo(1, 3);
    expect(s.z).toBeCloseTo(0.5, 3);
    expect(facesPointOutward(g)).toBeGreaterThan(0.95);
  });

  it('extrude: a third number rounds that corner', () => {
    const sharp = build({
      kind: 'extrude',
      shape: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    });
    const round = build({
      kind: 'extrude',
      shape: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1, 0.4],
          [0, 1],
        ],
      },
    });
    expect(round.getAttribute('position').count).toBeGreaterThan(
      sharp.getAttribute('position').count
    );
  });

  it('lathe faces outward whichever way the profile is written', () => {
    const up = [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ];
    expect(facesPointOutward(build({ kind: 'lathe', shape: { points: up } }))).toBeGreaterThan(
      0.95
    );
    expect(
      facesPointOutward(build({ kind: 'lathe', shape: { points: [...up].reverse() } }))
    ).toBeGreaterThan(0.95);
  });

  it('tube: capped ends make a closed, outward-facing solid', () => {
    const g = build({
      kind: 'tube',
      shape: {
        points: [
          [0, 0, 0],
          [0, 1, 0],
          [0, 2, 0],
        ],
        radius: 0.2,
      },
    });
    expect(facesPointOutward(g)).toBeGreaterThan(0.95);
    expect(size(g).y).toBeGreaterThan(1.9);
  });

  it('cylinder / cone capSegments: rings across a cap, the groups and the outside kept', () => {
    for (const kind of ['cylinder', 'cone'] as const) {
      const plain = build({ kind, shape: { segments: 8 } });
      // Unset or 1: three's own geometry, untouched.
      for (const capSegments of [undefined, 1]) {
        const same = build({ kind, shape: { segments: 8, capSegments } });
        expect(same.index!.array).toEqual(plain.index!.array);
        expect(same.getAttribute('position').array).toEqual(plain.getAttribute('position').array);
        expect(same.groups).toEqual(plain.groups);
      }
      const ringed = build({ kind, shape: { segments: 8, capSegments: 3 } });
      expect(size(ringed)).toEqual(size(plain));
      expect(facesPointOutward(ringed)).toBe(1);
      expect(ringed.groups.length).toBe(plain.groups.length); // side, (top,) bottom
      const pos = ringed.getAttribute('position') as BufferAttribute;
      const radii = new Set<string>();
      for (let i = 0; i < pos.count; i += 1) {
        if (pos.getY(i) === -0.5) radii.add(Math.hypot(pos.getX(i), pos.getZ(i)).toFixed(4));
      }
      expect([...radii].sort()).toEqual(['0.0000', '0.1667', '0.3333', '0.5000']);
    }
    // groups: the cylinder's top is still group 1, its whole ringed cap one colour.
    const g = build({
      kind: 'cylinder',
      shape: { capSegments: 2 },
      vertexColors: { groups: ['#ff0000', '#00ff00', '#0000ff'] },
    });
    const pos = g.getAttribute('position') as BufferAttribute;
    const col = g.getAttribute('color') as BufferAttribute;
    const n = g.getAttribute('normal') as BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      if (n.getY(i) > 0.99) expect([col.getX(i), col.getY(i), col.getZ(i)]).toEqual([0, 1, 0]);
    }
    expect(describeGeometryProblems({ geometry: 'cone', shape: { capSegments: 4 } })).toEqual([]);
    expect(
      describeGeometryProblems({ geometry: 'cylinder', shape: { capSegments: 0.5 } })[0]
    ).toMatch(/shape.capSegments must be a whole number ≥ 1/);
  });

  it('roundedBox keeps its extents', () => {
    const s = size(build({ kind: 'roundedBox', size: [2, 1, 0.5], shape: { radius: 0.1 } }));
    expect([s.x, s.y, s.z].map(v => Math.round(v * 100) / 100)).toEqual([2, 1, 0.5]);
  });

  it('bad parameters fall back to a box instead of throwing', () => {
    expect(
      build({ kind: 'extrude', shape: { points: [[0, 0]] } }).getAttribute('position').count
    ).toBe(36); // a box's 12 faces
  });
});

describe('modifiers, shading, colours', () => {
  it('mirror doubles the faces and keeps them facing out', () => {
    const half = build({
      kind: 'extrude',
      shape: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    });
    const whole = build({
      kind: 'extrude',
      shape: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      modifiers: [{ type: 'mirror', axis: 'x' }],
    });
    expect(whole.getAttribute('position').count).toBe(half.getAttribute('position').count * 2);
    expect(size(whole).x).toBeCloseTo(2, 4);
    expect(facesPointOutward(whole)).toBeGreaterThan(0.95);
  });

  it('array places count copies by the offset', () => {
    const g = build({
      size: [0.1, 0.1, 0.1],
      modifiers: [{ type: 'array', count: 5, offset: [1, 0, 0] }],
    });
    expect(size(g).x).toBeCloseTo(4.1, 4);
  });

  it('taper to -1 closes the top to a point; bend curls a column', () => {
    const tapered = build({ modifiers: [{ type: 'taper', axis: 'y', amount: -1 }] });
    tapered.computeBoundingBox();
    const pos = tapered.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      if (pos.getY(i) > 0.49) expect(Math.abs(pos.getX(i))).toBeLessThan(1e-6);
    }
    const bent = build({
      size: [0.2, 2, 0.2],
      modifiers: [{ type: 'bend', axis: 'y', angle: 90 }],
    });
    expect(size(bent).x).toBeGreaterThan(1); // a quarter circle of radius ~1.27
  });

  it('flat shading: one normal per face', () => {
    const g = build({ kind: 'sphere', shape: { segments: 6 }, shading: 'flat' });
    const n = g.getAttribute('normal') as BufferAttribute;
    for (let i = 0; i < n.count; i += 3) {
      expect(n.getX(i)).toBeCloseTo(n.getX(i + 1), 5);
      expect(n.getY(i)).toBeCloseTo(n.getY(i + 2), 5);
    }
  });

  it('faces colours tops, sides and bottoms; gradient runs along the axis', () => {
    const g = build({
      vertexColors: { faces: { top: '#ff0000', side: '#00ff00', bottom: '#0000ff' } },
    });
    const pos = g.getAttribute('normal') as BufferAttribute;
    const col = g.getAttribute('color') as BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      if (pos.getY(i) > 0.9) expect([col.getX(i), col.getY(i)]).toEqual([1, 0]);
      if (pos.getY(i) < -0.9) expect(col.getZ(i)).toBe(1);
    }
    const graded = build({
      vertexColors: { gradient: { axis: 'y', from: '#000000', to: '#ffffff' } },
    });
    const p = graded.getAttribute('position') as BufferAttribute;
    const c = graded.getAttribute('color') as BufferAttribute;
    for (let i = 0; i < p.count; i += 1) expect(c.getX(i)).toBeCloseTo(p.getY(i) + 0.5, 5);
  });

  it('groups colours the face groups of the kind, and the colour survives modifiers', () => {
    // A cylinder's groups: side, top cap, bottom cap.
    const capped = (spec: Partial<GeometryBuildSpec>) => {
      const g = build({
        kind: 'cylinder',
        vertexColors: { groups: ['#ff0000', '#00ff00', '#0000ff'] },
        ...spec,
      });
      const n = g.getAttribute('normal') as BufferAttribute;
      const c = g.getAttribute('color') as BufferAttribute;
      const seen = { side: 0, top: 0, bottom: 0 };
      for (let i = 0; i < n.count; i += 1) {
        const ny = n.getY(i);
        const part =
          ny > 0.99 ? 'top' : ny < -0.99 ? 'bottom' : Math.abs(ny) < 0.01 ? 'side' : null;
        if (!part) continue;
        seen[part] += 1;
        expect([c.getX(i), c.getY(i), c.getZ(i)]).toEqual(
          { top: [0, 1, 0], bottom: [0, 0, 1], side: [1, 0, 0] }[part]
        );
      }
      expect(Math.min(seen.side, seen.top, seen.bottom)).toBeGreaterThan(0);
    };
    capped({});
    capped({ modifiers: [{ type: 'twist', angle: 30 }], shading: 'flat' });
    // With faces on top, the two multiply.
    const both = build({
      vertexColors: { groups: ['#ffffff', '#ffffff', '#00ff00'], faces: { side: '#ff0000' } },
    });
    expect((both.getAttribute('color') as BufferAttribute).getX(0)).toBe(1);
    expect(describeGeometryProblems({ vertexColors: { groups: '#fff' } })).toEqual([
      'vertexColors.groups must be a list of colours, one per face group',
    ]);
  });

  describe('noise', () => {
    const colours = (g: BufferGeometry) => (g.getAttribute('color') as BufferAttribute).array;
    const sphere = (noise: object, more: Partial<GeometryBuildSpec> = {}) =>
      build({
        kind: 'sphere',
        shape: { segments: 12 },
        vertexColors: { noise: { amount: 0.4, scale: 0.2, ...noise } },
        ...more,
      });

    it('is deterministic per seed, stays within 1 ± amount and never goes negative', () => {
      const a = colours(sphere({ seed: 3 }));
      expect(Array.from(colours(sphere({ seed: 3 })))).toEqual(Array.from(a));
      expect(Array.from(colours(sphere({ seed: 4 })))).not.toEqual(Array.from(a));
      const values = Array.from(a);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(0.6);
      expect(Math.max(...values)).toBeLessThanOrEqual(1.4);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.2);
      // Value only: the three channels of a vertex move together.
      for (let i = 0; i < values.length; i += 3) expect(values[i + 1]).toBe(values[i]);
      // amount clamps to 1: the factor stays in 0..2.
      const strong = Array.from(colours(sphere({ amount: 5 })));
      expect(Math.min(...strong)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...strong)).toBeLessThanOrEqual(2);
    });

    it('multiplies after faces / gradient, and samples the shape after modifiers', () => {
      const gradient = { axis: 'x' as const, from: '#808080', to: '#ffffff' };
      const base = build({ vertexColors: { faces: { top: '#ff0000' }, gradient } });
      const noisy = build({
        vertexColors: { faces: { top: '#ff0000' }, gradient, noise: { amount: 0.5 } },
      });
      const n = noisy.getAttribute('normal') as BufferAttribute;
      for (let i = 0; i < n.count; i += 1) {
        if (n.getY(i) > 0.9) expect(colours(noisy)[i * 3 + 1]).toBe(0); // red stays red
      }
      // noise = one factor per vertex on top of the painted colour: every channel ratio agrees.
      const [b0, n0] = [colours(base), colours(noisy)];
      let varied = false;
      for (let i = 0; i < b0.length; i += 3) {
        const factor = n0[i] / b0[i];
        expect(n0[i + 2]).toBeCloseTo(b0[i + 2] * factor, 5);
        varied ||= Math.abs(factor - 1) > 0.01;
      }
      expect(varied).toBe(true);
      const moved = (offset: number) =>
        Array.from(
          colours(
            build({
              modifiers: [{ type: 'array', count: 2, offset: [offset, 0, 0] }],
              vertexColors: { noise: { amount: 0.5, scale: 0.3 } },
            })
          )
        );
      expect(moved(0)).not.toEqual(moved(0.37));
    });

    it('per vertex: coincident vertices agree, so creased and indexed meshes stay seamless', () => {
      for (const more of [{ shading: 'smooth' as const }, {}]) {
        const g = sphere({}, more);
        const pos = g.getAttribute('position') as BufferAttribute;
        const col = g.getAttribute('color') as BufferAttribute;
        const seen = new Map<string, number>();
        for (let i = 0; i < pos.count; i += 1) {
          const key = [pos.getX(i), pos.getY(i), pos.getZ(i)].map(v => v.toFixed(5)).join();
          const first = seen.get(key);
          if (first === undefined) seen.set(key, col.getX(i));
          else expect(col.getX(i)).toBeCloseTo(first, 5);
        }
      }
      expect(sphere({}).index).not.toBeNull(); // a primitive as built keeps its index
    });

    it('per face: one value a triangle; an indexed mesh is split into a triangle soup', () => {
      for (const more of [{}, { shading: 'smooth' as const }, { shading: 'flat' as const }]) {
        const g = sphere({ per: 'face' }, more);
        expect(g.index).toBeNull();
        expect(g.getAttribute('normal')).toBeDefined();
        const c = colours(g);
        for (let t = 0; t < c.length; t += 9) {
          expect(c[t + 3]).toBe(c[t]);
          expect(c[t + 6]).toBe(c[t]);
        }
      }
      expect(sphere({ per: 'face' }).getAttribute('uv')).toBeDefined(); // a primitive keeps its UVs
    });

    it('describeGeometryProblems names bad noise params', () => {
      expect(describeGeometryProblems({ vertexColors: { noise: { amount: 0.2 } } })).toEqual([]);
      expect(
        describeGeometryProblems({
          vertexColors: { noise: { amount: 20, scale: 0, seed: 1.5, per: 'pixel' } },
        })
      ).toEqual([
        'vertexColors.noise.amount 20 must be a number 0..1',
        'vertexColors.noise.scale 0 must be a positive number (mesh units)',
        'vertexColors.noise.seed 1.5 must be an integer',
        'vertexColors.noise.per "pixel" must be `vertex` or `face`',
      ]);
      expect(describeGeometryProblems({ vertexColors: { noise: 0.2 } })).toEqual([
        'vertexColors.noise must be a map: `{ amount: 0..1, scale, seed, per: vertex | face }`',
      ]);
    });
  });
});

describe('GeometryMesh with procedural geometry', () => {
  it('round-trips shape, modifiers, colours and shading, and turns vertex colours on', () => {
    const props = {
      geometry: 'extrude',
      shape: {
        points: [
          [0, 0],
          [1, 0],
          [0.5, 1],
        ],
        depth: 0.2,
      },
      modifiers: [{ type: 'mirror' as const, axis: 'x' as const }],
      vertexColors: { gradient: { axis: 'y' as const, from: '#000000', to: '#ffffff' } },
      shading: 'flat',
    };
    const mesh = new GeometryMesh({ id: 'm', name: 'm', ...props, material: { type: 'lambert' } });
    const saved = mesh.serializeConfig();
    expect(saved).toMatchObject(props);
    expect(mesh.renderMesh?.material).toMatchObject({ vertexColors: true });
    mesh.vertexColors = null;
    expect(mesh.renderMesh?.material).toMatchObject({ vertexColors: false });
    expect(mesh.serializeConfig().vertexColors).toBeUndefined();
  });

  it('a primitive without the new keys serializes exactly as before', () => {
    const mesh = new GeometryMesh({ id: 'b', name: 'b', geometry: 'box' });
    expect(Object.keys(mesh.serializeConfig())).toEqual([
      'geometry',
      'size',
      'castShadow',
      'receiveShadow',
      'material',
    ]);
  });

  it('describeGeometryProblems names what will not build', () => {
    expect(
      describeGeometryProblems({
        geometry: 'extrude',
        shape: {
          points: [
            [0, 0],
            [1, 0],
          ],
        },
      })[0]
    ).toMatch(/shape.points needs at least 3 points/);
    expect(
      describeGeometryProblems({ geometry: 'box', modifiers: [{ type: 'wobble' }] })[0]
    ).toMatch(/modifiers\[0\].type "wobble"/);
    expect(
      describeGeometryProblems({
        geometry: 'lathe',
        shape: {
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      })
    ).toEqual([]);
  });
});
