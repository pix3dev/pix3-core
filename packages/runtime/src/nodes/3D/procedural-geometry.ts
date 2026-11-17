import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Path,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * The geometry a `GeometryMesh` draws, built from what the scene file says — never from stored
 * vertices. A shape is a kind (`box` … `tube`), the kind's parameters (`shape`), a stack of
 * modifiers and a shading mode; colour without UVs comes from `vertexColors`. Everything here is
 * plain data in, `BufferGeometry` out, so an agent edits a silhouette by editing 8–20 numbers and a
 * diff shows what changed.
 *
 * Pure three.js — no node imports — so the AO/merge baker and the specs use it directly.
 */

/** Every `geometry:` kind. The first six are the original primitives. */
export const GEOMETRY_KINDS = [
  'box',
  'sphere',
  'plane',
  'cylinder',
  'cone',
  'torus',
  'roundedBox',
  'extrude',
  'lathe',
  'tube',
] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

export const GEOMETRY_SHADINGS = ['smooth', 'flat'] as const;
export type GeometryShading = (typeof GEOMETRY_SHADINGS)[number];

type Axis = 'x' | 'y' | 'z';
const AXES: readonly Axis[] = ['x', 'y', 'z'];

/**
 * Per-kind parameters (`properties.shape`). Unused keys are ignored.
 * - `roundedBox`: `radius` (corner, default 15% of the smallest side), `segments` (default 2).
 * - `extrude`: `points` — the 2D contour in the XY plane, `[x, y]` or `[x, y, r]` where `r` rounds
 *   that corner; `holes` (contours); `depth` along Z (default 1, centred); `bevel` (edge size, kept
 *   inside the contour and the depth); `bevelSegments` (default 2); `curveSegments` (default 6).
 * - `lathe`: `points` — the profile as `[radius, y]`, revolved about Y; `segments` (default 24);
 *   `angle` (degrees, default 360) and `startAngle`. Start/end at radius 0 to close the solid.
 * - `tube`: `points` — `[x, y, z]` control points of a smooth curve; `radius` (default 0.05);
 *   `segments` (radial, default 8); `tubularSegments` (default 8 per point); `closed` (a loop);
 *   `caps` (default true: flat ends on an open tube).
 * - `sphere` / `cylinder` / `cone` / `torus`: `segments` — sides around (default 32), for low-poly.
 * - `cylinder` / `cone`: `capSegments` — concentric rings across each flat cap (default 1: one
 *   fan from the centre), so `vertexColors` noise or a gradient has vertices to vary a cap by.
 */
export interface GeometryShapeSpec {
  points?: number[][];
  holes?: number[][][];
  depth?: number;
  bevel?: number;
  bevelSegments?: number;
  curveSegments?: number;
  segments?: number;
  capSegments?: number;
  tubularSegments?: number;
  radius?: number;
  angle?: number;
  startAngle?: number;
  closed?: boolean;
  caps?: boolean;
}

/**
 * One step of the modifier stack (`properties.modifiers`), applied in order in the mesh's own
 * frame after the kind is built. Angles are degrees.
 * - `mirror` — adds the reflection across the plane through the origin normal to `axis`.
 * - `array` — `count` copies (the original included), each one `offset` further and turned by
 *   `rotate` (degrees per copy, about the mesh origin — `rotate: [0, 60, 0]` with `count: 6`
 *   makes a ring).
 * - `taper` — scales across `axis` from 1 at the low end to `1 + amount` at the high end
 *   (`amount: -1` closes to a point).
 * - `twist` — turns about `axis` by `angle` from the low end to the high end.
 * - `bend` — curls the length along `axis` by `angle` toward `toward` (default: `x` for a
 *   `y` length, `y` otherwise).
 * - `noise` — moves every vertex by up to `amount` in a direction hashed from its position and
 *   `seed` (vertices that coincide move together, so seams stay closed): a rock from a cylinder.
 */
export type GeometryModifier =
  | { type: 'mirror'; axis?: Axis }
  | { type: 'array'; count?: number; offset?: number[]; rotate?: number[] }
  | { type: 'taper'; axis?: Axis; amount?: number }
  | { type: 'twist'; axis?: Axis; angle?: number }
  | { type: 'bend'; axis?: Axis; angle?: number; toward?: Axis }
  | { type: 'noise'; amount?: number; seed?: number };

export const GEOMETRY_MODIFIER_TYPES = ['mirror', 'array', 'taper', 'twist', 'bend', 'noise'];

/**
 * Colour without UVs (`properties.vertexColors`), multiplied into the material colour (author the
 * material `#ffffff` to see these exactly).
 * - `faces` — by which way a face looks: `top` (normal up), `bottom`, `side` (the rest).
 * - `gradient` — along `axis` from `from` at the low end to `to` at the high end (the mesh's own
 *   bounds, or `range: [low, high]` in its units).
 * - `groups` — one colour per face group of the built kind, in its order (before modifiers): `box`
 *   +x, −x, +y, −y, +z, −z; `cylinder` / `cone` side, top, bottom; `extrude` caps, sides. A kind
 *   with one group (sphere, lathe, tube…) takes the first colour.
 * - `noise` — brightness variation (value only, no hue), a factor in `1 ± amount` from smooth
 *   seeded value noise at the vertex's position in the mesh's own space after modifiers.
 * They multiply, `noise` last.
 */
export interface VertexColorSpec {
  faces?: { top?: string; side?: string; bottom?: string };
  groups?: string[];
  gradient?: { axis?: Axis; from?: string; to?: string; range?: number[] };
  noise?: VertexColorNoise;
}

/**
 * `vertexColors.noise`: `amount` 0..1 (default 0.15; clamped) — the factor runs from `1 - amount`
 * to `1 + amount`; `scale` (default 1) — the size of a noise cell in mesh units; `seed` (integer,
 * default 1); `per` — `vertex` (default: a smooth wash, shared vertices agree) or `face` (one
 * value per triangle, from its centre: the mesh becomes a triangle soup, 3 vertices a triangle).
 * Same seed, same mesh → the same colours on every machine.
 */
export interface VertexColorNoise {
  amount?: number;
  scale?: number;
  seed?: number;
  per?: 'vertex' | 'face';
}

export interface GeometryBuildSpec {
  kind: GeometryKind;
  size: [number, number, number];
  shape?: GeometryShapeSpec | null;
  modifiers?: readonly GeometryModifier[] | null;
  vertexColors?: VertexColorSpec | null;
  /** Unset: primitives keep their own normals, built kinds and modified ones get `smooth`. */
  shading?: GeometryShading | null;
}

const PRIMITIVE_KINDS: ReadonlySet<GeometryKind> = new Set([
  'box',
  'sphere',
  'plane',
  'cylinder',
  'cone',
  'torus',
]);

/** Faces within this angle share a normal under `smooth` shading (so a box stays a box). */
const SMOOTH_ANGLE = (50 * Math.PI) / 180;

/** Case-insensitive `geometry:` value → the kind, or `box` for anything unknown. */
export function normalizeGeometryKind(value: unknown): GeometryKind {
  const wanted = typeof value === 'string' ? value.toLowerCase() : '';
  return GEOMETRY_KINDS.find(kind => kind.toLowerCase() === wanted) ?? 'box';
}

export function normalizeShading(value: unknown): GeometryShading | null {
  return value === 'smooth' || value === 'flat' ? value : null;
}

/** The finished geometry: kind → modifiers → shading → vertex colours. Never throws. */
export function buildMeshGeometry(spec: GeometryBuildSpec): BufferGeometry {
  let geometry: BufferGeometry;
  try {
    geometry = buildKind(spec.kind, spec.size, spec.shape ?? {});
  } catch {
    geometry = new BoxGeometry(spec.size[0] || 1, spec.size[1] || 1, spec.size[2] || 1);
  }
  const groups = spec.vertexColors?.groups;
  if (Array.isArray(groups) && groups.length > 0) geometry = paintGroups(geometry, groups);
  const modifiers = spec.modifiers ?? [];
  for (const modifier of modifiers) geometry = applyModifier(geometry, modifier);
  const primitiveAsBuilt = PRIMITIVE_KINDS.has(spec.kind) && modifiers.length === 0;
  const shading = spec.shading ?? (primitiveAsBuilt ? null : 'smooth');
  if (shading === 'flat') geometry = flatNormals(geometry);
  else if (shading === 'smooth' && !primitiveAsBuilt) geometry = creasedNormals(geometry);
  const colors = spec.vertexColors;
  if (colors && (colors.faces || colors.gradient || colors.noise)) {
    geometry = paintVertexColors(geometry, colors);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const count = (value: unknown, fallback: number, min: number): number =>
  Math.max(min, Math.round(positive(value, fallback)));
const degrees = (value: unknown, fallback: number): number =>
  ((typeof value === 'number' && Number.isFinite(value) ? value : fallback) * Math.PI) / 180;

function buildKind(
  kind: GeometryKind,
  size: [number, number, number],
  shape: GeometryShapeSpec
): BufferGeometry {
  const x = Math.max(0.0001, size[0]);
  const y = Math.max(0.0001, size[1]);
  const z = Math.max(0.0001, size[2]);
  const sides = count(shape.segments, 32, 3);
  switch (kind) {
    case 'sphere':
      return new SphereGeometry(x / 2, sides, Math.max(2, Math.round(sides / 2)));
    case 'plane': {
      const plane = new PlaneGeometry(x, z);
      plane.rotateX(-Math.PI / 2); // lie flat as a floor
      return plane;
    }
    case 'cylinder':
    case 'cone': {
      const rings = count(shape.capSegments, 1, 1);
      const top = kind === 'cylinder' ? x / 2 : 0;
      if (rings === 1) {
        return kind === 'cylinder'
          ? new CylinderGeometry(x / 2, x / 2, y, sides)
          : new ConeGeometry(x / 2, y, sides);
      }
      // Three's caps are one fan; ringed caps are built here, in its groups' order (side, top,
      // bottom — a cone has no top), so `vertexColors.groups` reads the same.
      const parts: BufferGeometry[] = [new CylinderGeometry(top, x / 2, y, sides, 1, true)];
      if (top > 0) parts.push(ringedCap(top, y / 2, sides, rings, 1));
      parts.push(ringedCap(x / 2, -y / 2, sides, rings, -1));
      const geometry = mergeGeometries(parts, true);
      for (const part of parts) part.dispose();
      return geometry;
    }
    case 'torus': {
      const radius = x / 2;
      const tube = Math.max(0.02, Math.min(radius * 0.6, y * 0.25));
      return new TorusGeometry(radius, tube, 20, count(shape.segments, 40, 3));
    }
    case 'roundedBox': {
      const smallest = Math.min(x, y, z);
      const radius = Math.min(positive(shape.radius, smallest * 0.15), smallest / 2 - 1e-4);
      return new RoundedBoxGeometry(x, y, z, count(shape.segments, 2, 1), Math.max(0, radius));
    }
    case 'extrude':
      return buildExtrude(shape);
    case 'lathe':
      return buildLathe(shape);
    case 'tube':
      return buildTube(shape);
    case 'box':
    default:
      return new BoxGeometry(x, y, z);
  }
}

/**
 * A flat round cap at height `y` facing `side` (1 up, -1 down): a centre vertex and `rings`
 * concentric rings of `sides` steps, the outer one where three's cylinder puts its rim; indexed,
 * with three's cap normals and UVs.
 */
function ringedCap(
  radius: number,
  y: number,
  sides: number,
  rings: number,
  side: 1 | -1
): BufferGeometry {
  const positions = [0, y, 0];
  const uvs = [0.5, 0.5];
  for (let ring = 1; ring <= rings; ring += 1) {
    const f = ring / rings;
    for (let s = 0; s <= sides; s += 1) {
      const theta = (s / sides) * Math.PI * 2;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      positions.push(radius * f * sin, y, radius * f * cos);
      uvs.push(cos * 0.5 * f + 0.5, sin * 0.5 * side * f + 0.5);
    }
  }
  // Vertex s of ring k (1-based); ring 0 is the centre.
  const at = (ring: number, s: number) => (ring === 0 ? 0 : 1 + (ring - 1) * (sides + 1) + s);
  const indices: number[] = [];
  const face = (a: number, b: number, c: number) =>
    side > 0 ? indices.push(a, b, c) : indices.push(b, a, c);
  for (let ring = 1; ring <= rings; ring += 1) {
    for (let s = 0; s < sides; s += 1) {
      face(at(ring, s), at(ring, s + 1), at(ring - 1, s));
      if (ring > 1) face(at(ring - 1, s), at(ring, s + 1), at(ring - 1, s + 1));
    }
  }
  const cap = new BufferGeometry();
  cap.setIndex(indices);
  cap.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length).map((_, i) => (i % 3 === 1 ? side : 0));
  cap.setAttribute('normal', new BufferAttribute(normals, 3));
  cap.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return cap;
}

/** `[x, y]` / `[x, y, r]` rows → finite points; fewer than `min` is an error. */
function readPoints(rows: unknown, width: 2 | 3, min: number): number[][] {
  if (!Array.isArray(rows)) throw new Error('points must be a list');
  const points = rows.filter(
    (row): row is number[] =>
      Array.isArray(row) &&
      row.length >= width &&
      row.slice(0, width).every(n => typeof n === 'number' && Number.isFinite(n))
  );
  if (points.length < min) throw new Error(`needs at least ${min} points`);
  return points;
}

/** A closed contour with optional rounded corners (`[x, y, r]`). */
function tracePath<T extends Path>(path: T, points: number[][]): T {
  const n = points.length;
  const at = (i: number) => new Vector2(points[(i + n) % n][0], points[(i + n) % n][1]);
  for (let i = 0; i < n; i += 1) {
    const corner = at(i);
    const r = points[i][2] ?? 0;
    if (!(r > 0)) {
      if (i === 0) path.moveTo(corner.x, corner.y);
      else path.lineTo(corner.x, corner.y);
      continue;
    }
    const prev = at(i - 1);
    const next = at(i + 1);
    const inLen = corner.distanceTo(prev);
    const outLen = corner.distanceTo(next);
    const cut = Math.min(r, inLen / 2, outLen / 2);
    const enter = corner.clone().lerp(prev, cut / (inLen || 1));
    const leave = corner.clone().lerp(next, cut / (outLen || 1));
    if (i === 0) path.moveTo(enter.x, enter.y);
    else path.lineTo(enter.x, enter.y);
    path.quadraticCurveTo(corner.x, corner.y, leave.x, leave.y);
  }
  path.closePath();
  return path;
}

function buildExtrude(spec: GeometryShapeSpec): BufferGeometry {
  const shape = tracePath(new Shape(), readPoints(spec.points, 2, 3));
  for (const hole of Array.isArray(spec.holes) ? spec.holes : []) {
    try {
      shape.holes.push(tracePath(new Path(), readPoints(hole, 2, 3)));
    } catch {
      /* a malformed hole is skipped; `pix3 check` reports it */
    }
  }
  const depth = positive(spec.depth, 1);
  const bevel = Math.min(Math.max(0, spec.bevel ?? 0), depth / 2 - 1e-4);
  const geometry = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: count(spec.bevelSegments, 2, 1),
    curveSegments: count(spec.curveSegments, 6, 1),
  });
  // ExtrudeGeometry spans z ∈ [-bevel, depth - bevel]; centre it on the origin.
  geometry.translate(0, 0, bevel - depth / 2);
  geometry.deleteAttribute('uv');
  return geometry;
}

function buildLathe(spec: GeometryShapeSpec): BufferGeometry {
  const points = readPoints(spec.points, 2, 2).map(([r, y]) => new Vector2(Math.max(0, r), y));
  // LatheGeometry faces outward when the profile runs upward; flip a profile drawn downward.
  let rise = 0;
  for (let i = 1; i < points.length; i += 1) {
    rise += (points[i].y - points[i - 1].y) * (points[i].x + points[i - 1].x);
  }
  if (rise < 0) points.reverse();
  const geometry = new LatheGeometry(
    points,
    count(spec.segments, 24, 3),
    degrees(spec.startAngle, 0),
    Math.min(Math.PI * 2, degrees(spec.angle, 360))
  );
  geometry.deleteAttribute('uv');
  return geometry;
}

function buildTube(spec: GeometryShapeSpec): BufferGeometry {
  const points = readPoints(spec.points, 3, 2).map(([x, y, z]) => new Vector3(x, y, z));
  const closed = spec.closed === true;
  const curve = new CatmullRomCurve3(points, closed, 'centripetal');
  const radius = positive(spec.radius, 0.05);
  const radial = count(spec.segments, 8, 3);
  const tubular = count(spec.tubularSegments, points.length * 8, 2);
  const tube = new TubeGeometry(curve, tubular, radius, radial, closed);
  tube.deleteAttribute('uv');
  if (closed || spec.caps === false) return tube;
  const parts: BufferGeometry[] = [tube.toNonIndexed()];
  const pos = tube.getAttribute('position');
  const ring = radial + 1;
  for (const end of [0, 1] as const) {
    const center = curve.getPointAt(end);
    const outward = curve.getTangentAt(end).multiplyScalar(end === 0 ? -1 : 1);
    const first = end === 0 ? 0 : tubular * ring;
    const verts: number[] = [];
    for (let j = 0; j < radial; j += 1) {
      const a = new Vector3().fromBufferAttribute(pos, first + j);
      const b = new Vector3().fromBufferAttribute(pos, first + j + 1);
      const flip =
        new Vector3().subVectors(a, center).cross(b.clone().sub(center)).dot(outward) < 0;
      const [p, q] = flip ? [b, a] : [a, b];
      verts.push(center.x, center.y, center.z, p.x, p.y, p.z, q.x, q.y, q.z);
    }
    const cap = new BufferGeometry();
    cap.setAttribute('position', new Float32BufferAttribute(verts, 3));
    cap.setAttribute(
      'normal',
      new Float32BufferAttribute(
        Array.from({ length: verts.length / 3 }, () => [outward.x, outward.y, outward.z]).flat(),
        3
      )
    );
    parts.push(cap);
  }
  return mergeGeometries(parts) ?? tube;
}

// ---------------------------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------------------------

const axisIndex = (axis: unknown): 0 | 1 | 2 =>
  (AXES.indexOf(axis as Axis) >= 0 ? AXES.indexOf(axis as Axis) : 1) as 0 | 1 | 2;

/** Only position + normal survive a structural modifier (UVs are not authored on these kinds). */
function plain(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') flat.deleteAttribute(name);
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  flat.clearGroups();
  return flat;
}

function applyModifier(geometry: BufferGeometry, modifier: GeometryModifier): BufferGeometry {
  if (!modifier || typeof modifier !== 'object') return geometry;
  switch (modifier.type) {
    case 'mirror': {
      const base = plain(geometry);
      const copy = base.clone();
      const scale = [1, 1, 1];
      scale[axisIndex(modifier.axis ?? 'x')] = -1;
      copy.scale(scale[0], scale[1], scale[2]);
      flipWinding(copy);
      return mergeGeometries([base, copy]) ?? base;
    }
    case 'array': {
      const base = plain(geometry);
      const copies = count(modifier.count, 2, 1);
      const offset = vec3(modifier.offset);
      const rotate = vec3(modifier.rotate).multiplyScalar(Math.PI / 180);
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < copies; i += 1) {
        const part = base.clone();
        part
          .rotateX(rotate.x * i)
          .rotateY(rotate.y * i)
          .rotateZ(rotate.z * i);
        part.translate(offset.x * i, offset.y * i, offset.z * i);
        parts.push(part);
      }
      return mergeGeometries(parts) ?? base;
    }
    case 'taper':
      return deform(geometry, modifier.axis, (p, t, along) => {
        const s = Math.max(0, 1 + (modifier.amount ?? 0) * t);
        for (let k = 0; k < 3; k += 1) if (k !== along) p[k] *= s;
      });
    case 'twist': {
      const total = degrees(modifier.angle, 0);
      return deform(refine(geometry, modifier.axis), modifier.axis, (p, t, along) => {
        const [u, v] = along === 0 ? [1, 2] : along === 1 ? [2, 0] : [0, 1];
        const a = total * t;
        const pu = p[u];
        const pv = p[v];
        p[u] = pu * Math.cos(a) - pv * Math.sin(a);
        p[v] = pu * Math.sin(a) + pv * Math.cos(a);
      });
    }
    case 'bend': {
      const total = degrees(modifier.angle, 0);
      if (Math.abs(total) < 1e-6) return geometry;
      return deform(refine(geometry, modifier.axis), modifier.axis, (p, t, along, low, length) => {
        const toward = axisIndex(modifier.toward ?? (along === 1 ? 'x' : 'y'));
        if (toward === along) return;
        const radius = length / total;
        const phi = total * t;
        const w = p[toward];
        p[toward] = radius - (radius - w) * Math.cos(phi);
        p[along] = low + (radius - w) * Math.sin(phi);
      });
    }
    case 'noise': {
      const amount = typeof modifier.amount === 'number' ? modifier.amount : 0.05;
      const seed = typeof modifier.seed === 'number' ? modifier.seed : 1;
      return deform(geometry, 'y', p => {
        for (let k = 0; k < 3; k += 1)
          p[k] += (hash3(p[0], p[1], p[2], seed + k * 17) - 0.5) * 2 * amount;
      });
    }
    default:
      return geometry;
  }
}

function vec3(value: unknown): Vector3 {
  const v = Array.isArray(value) ? value : [];
  const n = (i: number) => (typeof v[i] === 'number' && Number.isFinite(v[i]) ? v[i] : 0);
  return new Vector3(n(0), n(1), n(2));
}

export function flipWinding(geometry: BufferGeometry): void {
  for (const attribute of Object.values(geometry.attributes) as BufferAttribute[]) {
    const size = attribute.itemSize;
    const array = attribute.array;
    for (let tri = 0; tri < attribute.count; tri += 3) {
      for (let k = 0; k < size; k += 1) {
        const b = (tri + 1) * size + k;
        const c = (tri + 2) * size + k;
        const tmp = array[b];
        array[b] = array[c];
        array[c] = tmp;
      }
    }
    attribute.needsUpdate = true;
  }
}

/**
 * Split every triangle into four (edge midpoints) until no edge is longer than 1/16 of the mesh's
 * length along `axis` (at most four rounds): a twist or a bend needs vertices along its length,
 * and a box has none. Midpoint splits keep shared edges shared, so the deformed mesh has no cracks.
 */
function refine(geometry: BufferGeometry, axis: unknown): BufferGeometry {
  let soup = plain(geometry);
  soup.computeBoundingBox();
  const target =
    (soup.boundingBox!.max.getComponent(axisIndex(axis)) -
      soup.boundingBox!.min.getComponent(axisIndex(axis))) /
    16;
  for (let round = 0; round < 4 && longestEdge(soup) > target * 1.01; round += 1) {
    const src = soup.getAttribute('position').array;
    const out = new Float32Array(src.length * 4);
    // Colour painted by `vertexColors.groups` is one colour per face: the four parts keep it.
    const srcColor = soup.getAttribute('color')?.array;
    const outColor = srcColor ? new Float32Array(src.length * 4) : null;
    let o = 0;
    const put = (x: number, y: number, z: number) => {
      out[o++] = x;
      out[o++] = y;
      out[o++] = z;
    };
    for (let t = 0; t < src.length; t += 9) {
      const v = (k: number, c: number) => src[t + k * 3 + c];
      const m = (a: number, b: number, c: number) => (v(a, c) + v(b, c)) / 2;
      const corners = [0, 1, 2].map(k => [v(k, 0), v(k, 1), v(k, 2)]);
      const mids = [
        [m(0, 1, 0), m(0, 1, 1), m(0, 1, 2)],
        [m(1, 2, 0), m(1, 2, 1), m(1, 2, 2)],
        [m(2, 0, 0), m(2, 0, 1), m(2, 0, 2)],
      ];
      for (const [a, b, c] of [
        [corners[0], mids[0], mids[2]],
        [mids[0], corners[1], mids[1]],
        [mids[2], mids[1], corners[2]],
        [mids[0], mids[1], mids[2]],
      ]) {
        if (outColor && srcColor) {
          for (let k = 0; k < 9; k += 1) outColor[o + k] = srcColor[t + (k % 3)];
        }
        put(a[0], a[1], a[2]);
        put(b[0], b[1], b[2]);
        put(c[0], c[1], c[2]);
      }
    }
    soup = new BufferGeometry();
    soup.setAttribute('position', new BufferAttribute(out, 3));
    if (outColor) soup.setAttribute('color', new BufferAttribute(outColor, 3));
  }
  if (!soup.getAttribute('normal')) soup.computeVertexNormals();
  return soup;
}

function longestEdge(geometry: BufferGeometry): number {
  const p = geometry.getAttribute('position').array;
  let longest = 0;
  for (let t = 0; t < p.length; t += 9) {
    for (const [a, b] of [
      [0, 3],
      [3, 6],
      [6, 0],
    ]) {
      longest = Math.max(
        longest,
        Math.hypot(p[t + a] - p[t + b], p[t + a + 1] - p[t + b + 1], p[t + a + 2] - p[t + b + 2])
      );
    }
  }
  return longest;
}

/** Move every position by `fn(p, t, along, low, length)`, `t` ∈ [0, 1] along `axis`. */
function deform(
  geometry: BufferGeometry,
  axis: unknown,
  fn: (p: number[], t: number, along: 0 | 1 | 2, low: number, length: number) => void
): BufferGeometry {
  const along = axisIndex(axis);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const low = box.min.getComponent(along);
  const length = Math.max(1e-6, box.max.getComponent(along) - low);
  const pos = geometry.getAttribute('position') as BufferAttribute;
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i += 1) {
    p[0] = pos.getX(i);
    p[1] = pos.getY(i);
    p[2] = pos.getZ(i);
    fn(p, (p[along] - low) / length, along, low, length);
    pos.setXYZ(i, p[0], p[1], p[2]);
  }
  pos.needsUpdate = true;
  return geometry;
}

/** A deterministic 0..1 hash of a position (rounded, so coincident vertices agree). */
function hash3(x: number, y: number, z: number, seed: number): number {
  const s =
    Math.sin(
      Math.round(x * 1e4) * 12.9898 +
        Math.round(y * 1e4) * 78.233 +
        Math.round(z * 1e4) * 37.719 +
        seed * 4.1
    ) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------------------------
// Shading and colour
// ---------------------------------------------------------------------------------------------

function flatNormals(geometry: BufferGeometry): BufferGeometry {
  const flat = plain(geometry);
  flat.deleteAttribute('normal');
  flat.computeVertexNormals(); // non-indexed: one normal per face
  return flat;
}

/**
 * Smooth normals that keep hard edges: a vertex averages the (area-weighted) normals of the faces
 * that meet at its position and lie within {@link SMOOTH_ANGLE} of its own face. three's
 * `toCreasedNormals` does the same but welds positions on a 1 cm grid, which collapses the small
 * parts game props are made of.
 */
export function creasedNormals(geometry: BufferGeometry, angle = SMOOTH_ANGLE): BufferGeometry {
  const flat = plain(geometry);
  const pos = flat.getAttribute('position') as BufferAttribute;
  const faces = pos.count / 3;
  const faceNormals = new Float32Array(faces * 3);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const byPosition = new Map<string, number[]>();
  const key = (i: number) =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  for (let f = 0; f < faces; f += 1) {
    a.fromBufferAttribute(pos, f * 3);
    b.fromBufferAttribute(pos, f * 3 + 1);
    c.fromBufferAttribute(pos, f * 3 + 2);
    const n = c.sub(b).cross(a.sub(b)); // area-weighted
    faceNormals.set([n.x, n.y, n.z], f * 3);
    for (let k = 0; k < 3; k += 1) {
      const id = key(f * 3 + k);
      const list = byPosition.get(id);
      if (list) list.push(f);
      else byPosition.set(id, [f]);
    }
  }
  const limit = Math.cos(angle);
  const normals = new Float32Array(pos.count * 3);
  const own = new Vector3();
  const other = new Vector3();
  const sum = new Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    const f = Math.floor(i / 3);
    own.fromArray(faceNormals, f * 3).normalize();
    sum.set(0, 0, 0);
    for (const g of byPosition.get(key(i)) ?? [f]) {
      other.fromArray(faceNormals, g * 3);
      if (g === f || other.clone().normalize().dot(own) >= limit) sum.add(other);
    }
    if (sum.lengthSq() < 1e-20) sum.copy(own);
    sum.normalize();
    normals.set([sum.x, sum.y, sum.z], i * 3);
  }
  flat.setAttribute('normal', new BufferAttribute(normals, 3));
  return flat;
}

/** One colour per face group (`vertexColors.groups`), as a `color` attribute on a triangle soup. */
function paintGroups(geometry: BufferGeometry, groups: readonly string[]): BufferGeometry {
  const ranges = geometry.groups.length
    ? geometry.groups.map(g => ({ start: g.start, count: g.count }))
    : [{ start: 0, count: (geometry.index ?? geometry.getAttribute('position')).count }];
  const soup = plain(geometry); // non-indexed: a group's index range is now its vertex range
  const colors = new Float32Array(soup.getAttribute('position').count * 3).fill(1);
  const color = new Color();
  ranges.forEach((range, i) => {
    color.set(groups[Math.min(i, groups.length - 1)] ?? '#ffffff');
    const end = Math.min(range.start + range.count, colors.length / 3);
    for (let v = range.start; v < end; v += 1) colors.set([color.r, color.g, color.b], v * 3);
  });
  soup.setAttribute('color', new BufferAttribute(colors, 3));
  return soup;
}

function paintVertexColors(geometry: BufferGeometry, spec: VertexColorSpec): BufferGeometry {
  const perFace = spec.noise?.per === 'face';
  // `faces` and per-face noise colour whole triangles: shared vertices are split first.
  const painted = spec.faces
    ? plain(geometry)
    : perFace && geometry.index
      ? geometry.toNonIndexed()
      : geometry;
  const pos = painted.getAttribute('position') as BufferAttribute;
  const base = painted.getAttribute('color');
  const colors = base ? Float32Array.from(base.array) : new Float32Array(pos.count * 3).fill(1);
  const tmp = new Color();
  if (spec.faces) {
    const top = new Color(spec.faces.top ?? spec.faces.side ?? '#ffffff');
    const side = new Color(spec.faces.side ?? '#ffffff');
    const bottom = new Color(spec.faces.bottom ?? spec.faces.side ?? '#ffffff');
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    for (let f = 0; f < pos.count / 3; f += 1) {
      a.fromBufferAttribute(pos, f * 3);
      b.fromBufferAttribute(pos, f * 3 + 1);
      c.fromBufferAttribute(pos, f * 3 + 2);
      const ny = c.sub(b).cross(a.sub(b)).normalize().y;
      const color = ny > 0.5 ? top : ny < -0.5 ? bottom : side;
      for (let k = 0; k < 3; k += 1) {
        const at = (f * 3 + k) * 3;
        colors[at] *= color.r;
        colors[at + 1] *= color.g;
        colors[at + 2] *= color.b;
      }
    }
  }
  const gradient = spec.gradient;
  if (gradient) {
    const along = axisIndex(gradient.axis ?? 'y');
    painted.computeBoundingBox();
    const range = Array.isArray(gradient.range) ? gradient.range : [];
    const low =
      typeof range[0] === 'number' ? range[0] : painted.boundingBox!.min.getComponent(along);
    const high =
      typeof range[1] === 'number' ? range[1] : painted.boundingBox!.max.getComponent(along);
    const from = new Color(gradient.from ?? '#ffffff');
    const to = new Color(gradient.to ?? '#ffffff');
    const p = new Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      p.fromBufferAttribute(pos, i);
      const t = Math.min(1, Math.max(0, (p.getComponent(along) - low) / (high - low || 1)));
      tmp.copy(from).lerp(to, t);
      colors[i * 3] *= tmp.r;
      colors[i * 3 + 1] *= tmp.g;
      colors[i * 3 + 2] *= tmp.b;
    }
  }
  const noise = spec.noise;
  if (noise) {
    const amount = Math.min(1, Math.max(0, finite(noise.amount, 0.15)));
    const scale = positive(noise.scale, 1);
    const seed = Math.round(finite(noise.seed, 1));
    const span = perFace ? 3 : 1;
    const p = new Vector3();
    const q = new Vector3();
    for (let i = 0; i + span <= pos.count; i += span) {
      p.fromBufferAttribute(pos, i);
      if (perFace)
        p.add(q.fromBufferAttribute(pos, i + 1))
          .add(q.fromBufferAttribute(pos, i + 2))
          .divideScalar(3);
      const factor = 1 + amount * (2 * valueNoise(p.x / scale, p.y / scale, p.z / scale, seed) - 1);
      for (let at = i * 3; at < (i + span) * 3; at += 1) colors[at] *= factor;
    }
  }
  painted.setAttribute('color', new BufferAttribute(colors, 3));
  return painted;
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Integer lattice hash → [0, 1); integer maths only, so every machine agrees. */
function latticeHash(x: number, y: number, z: number, seed: number): number {
  let h =
    Math.imul(x, 0x8da6b343) ^
    Math.imul(y, 0xd8163841) ^
    Math.imul(z, 0xcb1ab31f) ^
    Math.imul(seed, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0, 1): one random value per unit cell corner, eased between them. */
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const ease = (t: number) => t * t * (3 - 2 * t);
  const u = ease(x - x0);
  const v = ease(y - y0);
  const w = ease(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const corner = (dx: number, dy: number, dz: number) =>
    latticeHash(x0 + dx, y0 + dy, z0 + dz, seed);
  return lerp(
    lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v),
    w
  );
}

/**
 * Problems with the authored `shape` / `modifiers` / `vertexColors` of one `GeometryMesh`, worded
 * for `pix3 check` (empty when the mesh builds as written). `geometry` and `shading` are schema
 * enums, checked as such.
 */
export function describeGeometryProblems(props: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const kind = normalizeGeometryKind(props.geometry);
  const shape = props.shape as GeometryShapeSpec | undefined;
  if (
    shape !== undefined &&
    (typeof shape !== 'object' || shape === null || Array.isArray(shape))
  ) {
    problems.push('shape must be a map of parameters');
  } else if (kind === 'extrude' || kind === 'lathe' || kind === 'tube') {
    const [width, min] =
      kind === 'tube'
        ? ([3, 2] as const)
        : kind === 'lathe'
          ? ([2, 2] as const)
          : ([2, 3] as const);
    try {
      readPoints(shape?.points, width, min);
    } catch (error) {
      const form =
        kind === 'tube'
          ? '[x, y, z]'
          : kind === 'lathe'
            ? '[radius, y]'
            : '[x, y] or [x, y, cornerRadius]';
      problems.push(`geometry ${kind}: shape.points ${(error as Error).message} (rows of ${form})`);
    }
  } else if (
    (kind === 'cylinder' || kind === 'cone') &&
    shape?.capSegments !== undefined &&
    !(Number.isInteger(shape.capSegments) && shape.capSegments >= 1)
  ) {
    problems.push(
      `geometry ${kind}: shape.capSegments must be a whole number ≥ 1 (rings across each cap)`
    );
  }
  const modifiers = props.modifiers;
  if (modifiers !== undefined) {
    if (!Array.isArray(modifiers)) problems.push('modifiers must be a list');
    else
      modifiers.forEach((m, i) => {
        const type = (m as { type?: unknown } | null)?.type;
        if (typeof type !== 'string' || !GEOMETRY_MODIFIER_TYPES.includes(type)) {
          problems.push(
            `modifiers[${i}].type ${JSON.stringify(type)} is not one of ${GEOMETRY_MODIFIER_TYPES.join(', ')}`
          );
        }
      });
  }
  const colors = props.vertexColors as VertexColorSpec | undefined;
  if (colors !== undefined) {
    if (
      typeof colors !== 'object' ||
      colors === null ||
      (!colors.faces && !colors.gradient && !colors.groups && !colors.noise)
    ) {
      problems.push(
        'vertexColors needs `faces: {top, side, bottom}`, `gradient: {axis, from, to}`, `groups: [colour, …]` and/or `noise: {amount, scale, seed, per}`'
      );
    } else {
      if (
        colors.groups !== undefined &&
        (!Array.isArray(colors.groups) || !colors.groups.every(c => typeof c === 'string'))
      ) {
        problems.push('vertexColors.groups must be a list of colours, one per face group');
      }
      if (colors.noise !== undefined) problems.push(...describeNoiseProblems(colors.noise));
    }
  }
  return problems;
}

function describeNoiseProblems(noise: unknown): string[] {
  if (typeof noise !== 'object' || noise === null || Array.isArray(noise)) {
    return [
      'vertexColors.noise must be a map: `{ amount: 0..1, scale, seed, per: vertex | face }`',
    ];
  }
  const { amount, scale, seed, per } = noise as Record<string, unknown>;
  const problems: string[] = [];
  const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (amount !== undefined && !(isNumber(amount) && amount >= 0 && amount <= 1)) {
    problems.push(`vertexColors.noise.amount ${JSON.stringify(amount)} must be a number 0..1`);
  }
  if (scale !== undefined && !(isNumber(scale) && scale > 0)) {
    problems.push(
      `vertexColors.noise.scale ${JSON.stringify(scale)} must be a positive number (mesh units)`
    );
  }
  if (seed !== undefined && !(isNumber(seed) && Number.isInteger(seed))) {
    problems.push(`vertexColors.noise.seed ${JSON.stringify(seed)} must be an integer`);
  }
  if (per !== undefined && per !== 'vertex' && per !== 'face') {
    problems.push(`vertexColors.noise.per ${JSON.stringify(per)} must be \`vertex\` or \`face\``);
  }
  return problems;
}
