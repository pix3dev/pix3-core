import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flipWinding } from './procedural-geometry';

/**
 * Static parts of a model drawn as one mesh, optionally with light, shadow and ambient occlusion
 * baked into its vertex colours.
 *
 * A prop or a building made of 10–40 `GeometryMesh` parts is 10–40 draw calls. `mergeStatic`
 * walks a group, takes every visible part that nothing animates (no component on it or on an
 * ancestor below the group), bakes its transform relative to the group into its geometry and its
 * material colour into a vertex colour, and adds one mesh per material kind to the group; the
 * parts stay in the tree, hidden. Moving parts (a mill's sails under `core:Rotate`) stay as they
 * are. `unmergeStatic` undoes it (show the parts again, drop the merged meshes) before a re-merge.
 *
 * With `bake`, the parts become ONE unlit mesh (`MeshBasicMaterial` + vertex colours): each vertex
 * gets direct sun light with a shadow ray, a sky/ground ambient term and ambient occlusion — rays
 * cast against the merged geometry itself through a small BVH. Large faces the sun reaches are
 * split first (`subdivide`) so a house can shade the yard it stands on. A part with an unlit
 * (`basic`) material — a lit window — keeps its own colour (it still casts shadow). Nothing in the
 * scene lights the result any more: the light lives in the model.
 */

export interface BakeOptions {
  /** World-space direction TOWARD the sun. Default `[-0.6, 1, 0.45]` (high, from the left-front). */
  sunDirection?: readonly number[];
  /** Sun colour (default warm `#fff0d8`) and strength (default 1). */
  sunColor?: string;
  sunIntensity?: number;
  /** Ambient light from above (default `#b8c6e0`) and below (default `#8a7a66`), and its strength (0.65). */
  skyColor?: string;
  groundColor?: string;
  ambient?: number;
  /** Cast shadows from the sun (default true). */
  shadows?: boolean;
  /** Ambient-occlusion rays per vertex (default 24; 0 = no AO). */
  aoSamples?: number;
  /** How far an occluder darkens, in the group's units (default: 30% of the model's radius). */
  aoDistance?: number;
  /** 0..1, how dark full occlusion gets (default 0.9). */
  aoStrength?: number;
  /**
   * Whether an AO ray that hits a face from behind counts as occluded (default true). `false`: only
   * front faces occlude — for models whose parts overlap, where a vertex buried inside another part
   * would go black and smear dark across its large face; an open shell (a `plane`, an open lathe)
   * then no longer occludes from behind. Shadow rays are unaffected.
   */
  aoBackFaces?: boolean;
  /**
   * Soft occlusion (default false). An AO ray then darkens by how near its hit is — fully at the
   * surface, not at all at `aoDistance` — instead of counting as a whole hit anywhere within reach,
   * so neighbouring vertices get close values and a face shades as an even gradient, not in blotches.
   * Costs the nearest hit per ray instead of any hit. Lighter overall: raise `aoStrength` or
   * `aoDistance` to taste.
   */
  aoFalloff?: boolean;
  /**
   * The sun's angular size, degrees (default 0 = a point: a vertex is lit or it is not). Above 0 each
   * vertex casts {@link SUN_RAYS} shadow rays across the disc and takes the share that got through, so
   * a shadow's edge is a soft ramp over a few vertices instead of a jagged step. 4–10 reads well.
   */
  sunSize?: number;
  /**
   * One light per flat polygon (default false). Every flat-shaded polygon — coplanar triangles that
   * touch, whose vertex normals are the face's own — takes the area-weighted mean of the light its
   * vertices caught, so a facet reads as one even tone (the low-poly look) instead of a blotchy
   * interpolation between vertices. Smooth-shaded surfaces keep their per-vertex light. The price:
   * a shadow that falls across a large flat polygon (a house on its yard) only darkens the whole of
   * it a little — split the ground into several polygons where a cast shadow should show.
   */
  flatFaces?: boolean;
  /**
   * Split faces longer than this (group units) before baking, so shadows and occlusion have
   * vertices to land on. `true` (default) = model radius / 10; `false` / 0 = off.
   */
  subdivide?: number | boolean;
  /**
   * Look controls, applied per lit vertex to the finished colour (albedo × (sun + sky/ground
   * ambient), after shadows and AO), in linear RGB, in this order: × `exposure` (default 1), then
   * `saturation` around Rec.709 luma (default 1; 0 = grey, above 1 = richer), then a per-channel
   * clip to 0..1. With both at 1 nothing is touched (the bake is identical to one without them).
   * Unlit (`basic`) parts keep their own colour.
   */
  exposure?: number;
  saturation?: number;
}

/**
 * A world direction TOWARD the sun, placed relative to a camera's heading on the ground, for
 * {@link BakeOptions.sunDirection}: `azimuth` (degrees about world up; 0 = the sun behind the
 * camera, positive = from the camera's left) and `elevation` (degrees above the horizon). The
 * heading is the camera's view direction projected onto XZ; a camera looking straight down uses
 * its up vector instead. Updates `camera`'s world matrix first; returns a unit `[x, y, z]`.
 * Call it once for a camera whose heading does not change — nothing rebakes when it moves.
 */
export function sunDirectionFromCamera(
  camera: Object3D,
  angles: { azimuth: number; elevation: number }
): [number, number, number] {
  const { azimuth, elevation } = angles;
  if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) {
    throw new RangeError('sunDirectionFromCamera: azimuth and elevation must be finite degrees');
  }
  camera.updateWorldMatrix(true, false);
  const e = camera.matrixWorld.elements;
  // Columns: 1 = the camera's up, 2 = its back (it looks along −Z).
  let hx = -e[8];
  let hz = -e[10];
  // Straight down (or up), relative to the column's length so a scaled camera reads the same.
  if (hx * hx + hz * hz < 1e-8 * (hx * hx + e[9] * e[9] + hz * hz)) [hx, hz] = [e[4], e[6]];
  const length = Math.hypot(hx, hz);
  hx /= length;
  hz /= length;
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  // Behind the camera is −heading; its left (world up × heading) is (hz, −hx) in XZ.
  const x = Math.cos(az) * -hx + Math.sin(az) * hz;
  const z = Math.cos(az) * -hz + Math.sin(az) * -hx;
  return [x * Math.cos(el), Math.sin(el), z * Math.cos(el)];
}

export interface MergeStaticOptions {
  /** Bake light into vertex colours (`true` = the defaults of {@link BakeOptions}). */
  bake?: boolean | BakeOptions;
  /**
   * Reuse the merged (and baked) geometry of an earlier call with the same key instead of building
   * it again — for many identical models. The key must change whenever the model or the light does.
   */
  cacheKey?: string;
  /** Leave this subtree (and anything `skip` returns true for) out of the merge. */
  skip?: Object3D | ((object: Object3D) => boolean) | null;
}

export interface MergeStaticResult {
  /** Meshes merged away (draw calls before − after, roughly). */
  readonly merged: number;
  /** The new meshes added to the group. */
  readonly meshes: readonly Mesh[];
  /** Vertices of the merged geometry. */
  readonly vertices: number;
  /** Whether the geometry came from the cache. */
  readonly cached: boolean;
  readonly ms: number;
}

/** Marks a mesh `mergeStatic` added (never merged again, removed by `unmergeStatic`). */
export const MERGED_MESH_FLAG = 'pix3MergedStatic';
/** Marks a part `mergeStatic` hid. */
const HIDDEN_PART_FLAG = 'pix3MergedPart';

type Family = 'basic' | 'lambert' | 'standard';
interface Bucket {
  readonly key: string;
  readonly family: Family | 'baked';
  readonly parts: BufferGeometry[];
  readonly meshes: Mesh[];
  castShadow: boolean;
  receiveShadow: boolean;
}

const sharedMaterials = new Map<string, Material>();
const geometryCache = new Map<string, { key: string; geometry: BufferGeometry }[]>();

/** The materials merged meshes share, by bucket key (one program each for the whole game). */
function sharedMaterial(key: string, family: Family | 'baked'): Material {
  let material = sharedMaterials.get(key);
  if (!material) {
    material =
      family === 'baked' || family === 'basic'
        ? new MeshBasicMaterial({ vertexColors: true })
        : family === 'lambert'
          ? new MeshLambertMaterial({ vertexColors: true })
          : new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
    material.name = `pix3-merged-${key}`;
    sharedMaterials.set(key, material);
  }
  return material;
}

/** Drop every cached merge (call after changing models at runtime under the same keys). */
export function clearMergeCache(): void {
  for (const entries of geometryCache.values()) for (const e of entries) e.geometry.dispose();
  geometryCache.clear();
}

function familyOf(material: Material): Family | null {
  if ((material as MeshBasicMaterial).isMeshBasicMaterial) return 'basic';
  if ((material as MeshLambertMaterial).isMeshLambertMaterial) return 'lambert';
  if ((material as MeshStandardMaterial).isMeshStandardMaterial) return 'standard';
  return null;
}

/** True when a component sits on `object` or an ancestor strictly below `group`. */
function animated(object: Object3D, group: Object3D): boolean {
  for (let n: Object3D | null = object; n && n !== group; n = n.parent) {
    const components = (n as { components?: readonly { type?: string }[] }).components;
    if (components && components.some(c => c.type !== 'core:MergeStatic')) return true;
  }
  return false;
}

function shown(object: Object3D, group: Object3D): boolean {
  for (let n: Object3D | null = object; n && n !== group; n = n.parent)
    if (!n.visible) return false;
  return true;
}

function inside(object: Object3D, ancestor: Object3D): boolean {
  for (let n: Object3D | null = object; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** Show the parts `mergeStatic` hid and remove the meshes it added. */
export function unmergeStatic(group: Object3D): void {
  const added: Object3D[] = [];
  group.traverse(o => {
    if (o.userData[MERGED_MESH_FLAG]) added.push(o);
    else if (o.userData[HIDDEN_PART_FLAG]) {
      o.visible = true;
      delete o.userData[HIDDEN_PART_FLAG];
    }
  });
  for (const mesh of added) mesh.removeFromParent();
}

/** Merge (and optionally bake) the static parts under `group`; see the module comment. */
export function mergeStatic(group: Object3D, options: MergeStaticOptions = {}): MergeStaticResult {
  const started = performance.now();
  const bake = options.bake ? (options.bake === true ? {} : options.bake) : null;
  const skip = options.skip;
  group.updateMatrixWorld(true);
  const inverse = new Matrix4().copy(group.matrixWorld).invert();
  const relative = new Matrix4();
  const buckets = new Map<string, Bucket>();
  group.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || mesh.userData[MERGED_MESH_FLAG] || mesh.userData[HIDDEN_PART_FLAG]) return;
    if (skip && (typeof skip === 'function' ? skip(object) : inside(object, skip))) return;
    if (Array.isArray(mesh.material) || (mesh as { isInstancedMesh?: boolean }).isInstancedMesh)
      return;
    const material = mesh.material as Material & {
      color?: Color;
      map?: unknown;
      roughness?: number;
      metalness?: number;
    };
    const family = familyOf(material);
    if (!family || !material.color || material.map || material.transparent) return;
    if (!shown(object, group) || animated(object, group)) return;
    const key = bake
      ? 'baked'
      : family === 'standard'
        ? `standard:${(material.roughness ?? 1).toFixed(1)}:${(material.metalness ?? 0).toFixed(1)}`
        : family;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        family: bake ? 'baked' : family,
        parts: [],
        meshes: [],
        castShadow: false,
        receiveShadow: false,
      };
      buckets.set(key, bucket);
    }
    bucket.meshes.push(mesh);
    bucket.castShadow ||= mesh.castShadow;
    bucket.receiveShadow ||= mesh.receiveShadow;
    if (options.cacheKey && geometryCache.has(options.cacheKey)) return;
    relative.multiplyMatrices(inverse, mesh.matrixWorld);
    const part = partGeometry(mesh.geometry, relative, material.color);
    // Baked: an unlit (basic) part — a lit window, glowing lava — keeps its colour but still casts.
    if (bake) markLit(part, family !== 'basic');
    bucket.parts.push(part);
  });

  const cached = options.cacheKey ? geometryCache.get(options.cacheKey) : undefined;
  const fresh: { key: string; geometry: BufferGeometry }[] = [];
  const meshes: Mesh[] = [];
  let merged = 0;
  let vertices = 0;
  for (const bucket of buckets.values()) {
    if (!cached && bucket.parts.length < (bake ? 1 : 2)) {
      for (const part of bucket.parts) part.dispose();
      continue;
    }
    let geometry = cached?.find(e => e.key === bucket.key)?.geometry ?? null;
    if (!cached) {
      geometry = mergeGeometries(bucket.parts);
      for (const part of bucket.parts) part.dispose();
      if (geometry && bake) geometry = bakeVertexLighting(geometry, bake, group);
      if (geometry) fresh.push({ key: bucket.key, geometry });
    }
    if (!geometry) continue;
    const mesh = new Mesh(geometry, sharedMaterial(bucket.key, bucket.family));
    mesh.name = `merged-${bucket.key}`;
    mesh.userData[MERGED_MESH_FLAG] = true;
    mesh.castShadow = !bake && bucket.castShadow;
    mesh.receiveShadow = !bake && bucket.receiveShadow;
    group.add(mesh);
    meshes.push(mesh);
    for (const part of bucket.meshes) {
      part.visible = false;
      part.userData[HIDDEN_PART_FLAG] = true;
    }
    merged += bucket.meshes.length;
    vertices += geometry.getAttribute('position').count;
  }
  if (options.cacheKey && !cached && fresh.length > 0) geometryCache.set(options.cacheKey, fresh);
  return { merged, meshes, vertices, cached: !!cached, ms: performance.now() - started };
}

/** Name of the per-vertex 0/1 attribute that says whether the bake lights a vertex. */
const LIT_ATTRIBUTE = 'pix3Lit';
function markLit(geometry: BufferGeometry, lit: boolean): void {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute(
    LIT_ATTRIBUTE,
    new BufferAttribute(new Float32Array(n).fill(lit ? 1 : 0), 1)
  );
}

/** One part in the group's frame: position, normal and its colour (material × vertex colour). */
function partGeometry(source: BufferGeometry, matrix: Matrix4, color: Color): BufferGeometry {
  const g = source.index ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
  }
  g.clearGroups();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flipWinding(g);
  const n = g.getAttribute('position').count;
  const own = g.getAttribute('color') as BufferAttribute | undefined;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    colors[i * 3] = color.r * (own ? own.getX(i) : 1);
    colors[i * 3 + 1] = color.g * (own ? own.getY(i) : 1);
    colors[i * 3 + 2] = color.b * (own ? own.getZ(i) : 1);
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

// ---------------------------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------------------------

/**
 * Light a merged geometry (position, normal, colour; non-indexed) into its vertex colours, in place
 * apart from the subdivision, which returns a new geometry. `frame` is the object whose local space
 * the geometry is in (world directions are turned into it); omit for world space.
 */
export function bakeVertexLighting(
  geometry: BufferGeometry,
  options: BakeOptions = {},
  frame?: Object3D
): BufferGeometry {
  geometry.computeBoundingSphere();
  const radius = Math.max(1e-3, geometry.boundingSphere?.radius ?? 1);
  const split =
    options.subdivide === false || options.subdivide === 0
      ? 0
      : typeof options.subdivide === 'number'
        ? options.subdivide
        : radius / 10;
  const toLocal = new Matrix3();
  if (frame) {
    frame.updateMatrixWorld(true);
    toLocal.setFromMatrix4(frame.matrixWorld).invert();
  }
  const sun = new Vector3(...vector(options.sunDirection, [-0.6, 1, 0.45]))
    .applyMatrix3(toLocal)
    .normalize();
  // Only faces the sun reaches can hold a shadow's edge: the rest keep their vertices (their
  // light is the smooth ambient term), which saves most of the rays under a model.
  const g =
    split > 0 ? subdivideGeometry(geometry, split, normal => normal.dot(sun) > 0) : geometry;
  if (g !== geometry) geometry.dispose();
  const sunColor = new Color(options.sunColor ?? '#fff0d8').multiplyScalar(
    options.sunIntensity ?? 1
  );
  const ambient = options.ambient ?? 0.65;
  const sky = new Color(options.skyColor ?? '#b8c6e0').multiplyScalar(ambient);
  const ground = new Color(options.groundColor ?? '#8a7a66').multiplyScalar(ambient);
  const up = new Vector3(0, 1, 0).applyMatrix3(toLocal).normalize();
  const samples = Math.max(0, Math.round(options.aoSamples ?? 24));
  const aoDistance = options.aoDistance ?? radius * 0.3;
  const aoStrength = Math.min(1, Math.max(0, options.aoStrength ?? 0.9));
  const frontOnly = options.aoBackFaces === false;
  const falloff = options.aoFalloff === true;
  const sunRays = sunDisc(sun, nonNegative(options.sunSize, 0));
  const shadows = options.shadows !== false;
  const exposure = nonNegative(options.exposure, 1);
  const saturation = nonNegative(options.saturation, 1);
  const graded = exposure !== 1 || saturation !== 1;

  const pos = g.getAttribute('position') as BufferAttribute;
  const nor = g.getAttribute('normal') as BufferAttribute;
  const col = g.getAttribute('color') as BufferAttribute;
  const litFlags = g.getAttribute(LIT_ATTRIBUTE) as BufferAttribute | undefined;
  const bvh = new TriangleBVH(pos.array as Float32Array);
  const eps = radius * 1e-3;
  const directions = hemisphere(samples);
  const p = new Vector3();
  const n = new Vector3();
  const origin = new Vector3();
  const dir = new Vector3();
  const t1 = new Vector3();
  const t2 = new Vector3();
  const light = new Color();
  // One set of rays per position (to 1e-4 units) and unit normal (each component to 0.01): a
  // non-indexed smooth part repeats a vertex once per triangle round it, so it casts a third or
  // less of its rays. Normals 1° or more apart never share (a hard edge, the facets of a
  // flat-shaded curve); closer ones may. A vertex takes the light of the first one in its cell:
  // its own for an exact copy (nothing here depends on the index); for one within the rounding (a
  // seam's float noise) the point is < 1.8e-4 units and the normal < 1° from its own.
  const memo = new Map<string, [number, number, number]>();
  /** The light each lit vertex caught (shared tuples; replaced, never mutated). */
  const lightOf: ([number, number, number] | undefined)[] = new Array(pos.count);
  const out = [0, 0, 0];
  for (let i = 0; i < pos.count; i += 1) {
    if (litFlags && litFlags.getX(i) < 0.5) continue;
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i).normalize();
    const id = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)},${Math.round(n.x * 100)},${Math.round(n.y * 100)},${Math.round(n.z * 100)}`;
    let rgb = memo.get(id);
    if (!rgb) {
      origin.copy(p).addScaledVector(n, eps);
      // Sun: Lambert term, zero in shadow.
      const facing = Math.max(0, n.dot(sun));
      let lit = 0;
      if (facing > 0) {
        if (!shadows) lit = facing;
        else if (sunRays.length === 0) lit = bvh.occluded(origin, sun, Infinity, eps) ? 0 : facing;
        else {
          let through = 0;
          for (const ray of sunRays) if (!bvh.occluded(origin, ray, Infinity, eps)) through += 1;
          lit = (facing * through) / sunRays.length;
        }
      }
      // Ambient: sky above, ground below, occluded by nearby geometry.
      let open = 1;
      if (samples > 0) {
        tangentFrame(n, t1, t2);
        let hits = 0;
        for (const [x, y, z] of directions) {
          dir.set(0, 0, 0).addScaledVector(t1, x).addScaledVector(t2, y).addScaledVector(n, z);
          if (falloff)
            hits += 1 - bvh.nearest(origin, dir, aoDistance, eps, frontOnly) / aoDistance;
          else if (bvh.occluded(origin, dir, aoDistance, eps, frontOnly)) hits += 1;
        }
        open = 1 - aoStrength * (hits / directions.length);
      }
      const skyward = n.dot(up) * 0.5 + 0.5;
      light.copy(ground).lerp(sky, skyward).multiplyScalar(open);
      light.r += sunColor.r * lit;
      light.g += sunColor.g * lit;
      light.b += sunColor.b * lit;
      rgb = [light.r, light.g, light.b];
      memo.set(id, rgb);
    }
    lightOf[i] = rgb;
  }
  if (options.flatFaces === true) flattenFaceLight(pos, nor, lightOf);
  for (let i = 0; i < pos.count; i += 1) {
    const rgb = lightOf[i];
    if (!rgb) continue;
    out[0] = col.getX(i) * rgb[0];
    out[1] = col.getY(i) * rgb[1];
    out[2] = col.getZ(i) * rgb[2];
    if (graded) grade(out, exposure, saturation);
    col.setXYZ(i, out[0], out[1], out[2]);
  }
  col.needsUpdate = true;
  if (litFlags) g.deleteAttribute(LIT_ATTRIBUTE);
  return g;
}

/**
 * {@link BakeOptions.flatFaces}: give every flat polygon of a non-indexed geometry one light, the
 * area-weighted mean of its vertices'. A polygon is a set of lit triangles in one plane (normal to
 * 0.01 per component, offset to 1e-3 units) joined through shared corners (to 1e-4 units), each
 * with all three vertex normals on the face normal (so a smooth-shaded surface is left alone).
 */
function flattenFaceLight(
  pos: BufferAttribute,
  nor: BufferAttribute,
  lightOf: ([number, number, number] | undefined)[]
): void {
  const triangles = pos.count / 3;
  const parent = new Int32Array(triangles).fill(-1); // -1 = not a flat lit triangle
  const find = (t: number): number => {
    while (parent[t] !== t) t = parent[t] = parent[parent[t]];
    return t;
  };
  const area = new Float32Array(triangles);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const face = new Vector3();
  const n = new Vector3();
  const corners = new Map<string, number>();
  for (let t = 0; t < triangles; t += 1) {
    const i = t * 3;
    if (!lightOf[i] || !lightOf[i + 1] || !lightOf[i + 2]) continue;
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    face.subVectors(b, a).cross(n.subVectors(c, a));
    const doubled = face.length();
    if (doubled < 1e-12) continue;
    face.divideScalar(doubled);
    let flat = true;
    for (let k = 0; k < 3 && flat; k += 1) {
      flat =
        n
          .fromBufferAttribute(nor, i + k)
          .normalize()
          .dot(face) > 0.9999;
    }
    if (!flat) continue;
    parent[t] = t;
    area[t] = doubled / 2;
    const plane = `${Math.round(face.x * 100)},${Math.round(face.y * 100)},${Math.round(face.z * 100)},${Math.round(face.dot(a) * 1e3)}`;
    for (const v of [a, b, c]) {
      const key = `${plane}|${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
      const other = corners.get(key);
      if (other === undefined) corners.set(key, t);
      else parent[find(other)] = find(t);
    }
  }
  const sums = new Map<number, [number, number, number, number]>();
  for (let t = 0; t < triangles; t += 1) {
    if (parent[t] < 0) continue;
    const root = find(t);
    let sum = sums.get(root);
    if (!sum) sums.set(root, (sum = [0, 0, 0, 0]));
    const w = area[t] / 3;
    for (let k = 0; k < 3; k += 1) {
      const rgb = lightOf[t * 3 + k]!;
      sum[0] += rgb[0] * w;
      sum[1] += rgb[1] * w;
      sum[2] += rgb[2] * w;
    }
    sum[3] += area[t];
  }
  const means = new Map<number, [number, number, number]>();
  for (const [root, [r, g, bl, total]] of sums) means.set(root, [r / total, g / total, bl / total]);
  for (let t = 0; t < triangles; t += 1) {
    if (parent[t] < 0) continue;
    const mean = means.get(find(t))!;
    lightOf[t * 3] = lightOf[t * 3 + 1] = lightOf[t * 3 + 2] = mean;
  }
}

/** {@link BakeOptions.exposure} and `saturation` on one linear colour, then the 0..1 clip. */
function grade(rgb: number[], exposure: number, saturation: number): void {
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) * exposure;
  for (let k = 0; k < 3; k += 1) {
    rgb[k] = Math.min(1, Math.max(0, luma + (rgb[k] * exposure - luma) * saturation));
  }
}

const nonNegative = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;

function vector(
  value: readonly number[] | undefined,
  fallback: number[]
): [number, number, number] {
  const v =
    Array.isArray(value) && value.length >= 3 && value.every(Number.isFinite) ? value : fallback;
  return [v[0], v[1], v[2]];
}

/** Cosine-weighted directions on the +Z hemisphere (Hammersley points: no noise, no seed). */
function hemisphere(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u = (i + 0.5) / count;
    const v = bits / 4294967296;
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u))]);
  }
  return out;
}

/** Shadow rays per vertex for a sun with a size ({@link BakeOptions.sunSize}). */
const SUN_RAYS = 8;

/** Directions across the sun's disc (`size` degrees wide), around `sun`; none for a point sun. */
function sunDisc(sun: Vector3, size: number): Vector3[] {
  if (!(size > 0)) return [];
  const t1 = new Vector3();
  const t2 = new Vector3();
  tangentFrame(sun, t1, t2);
  const spread = Math.tan((Math.min(size, 90) * Math.PI) / 360);
  // The same low-discrepancy disc the AO uses, scaled to the sun's radius.
  return hemisphere(SUN_RAYS).map(([x, y]) =>
    sun
      .clone()
      .addScaledVector(t1, x * spread)
      .addScaledVector(t2, y * spread)
      .normalize()
  );
}

function tangentFrame(n: Vector3, t1: Vector3, t2: Vector3): void {
  t1.set(Math.abs(n.x) > 0.9 ? 0 : 1, Math.abs(n.x) > 0.9 ? 1 : 0, 0);
  t2.crossVectors(n, t1).normalize();
  t1.crossVectors(t2, n);
}

/**
 * Split every triangle longer than `maxEdge` along its longest edge until none is — only the
 * triangles `accept` passes (given the face's unit normal), when it is given.
 */
export function subdivideGeometry(
  geometry: BufferGeometry,
  maxEdge: number,
  accept?: (normal: Vector3) => boolean
): BufferGeometry {
  const names = Object.keys(geometry.attributes);
  const sources = names.map(name => geometry.getAttribute(name) as BufferAttribute);
  // One vertex = all its attribute values in a row (position first), `stride` numbers.
  const posIndex = names.indexOf('position');
  const order = [posIndex, ...names.map((_, j) => j).filter(j => j !== posIndex)];
  const stride = order.reduce((sum, j) => sum + sources[j].itemSize, 0);
  const pos = geometry.getAttribute('position') as BufferAttribute;
  const count = pos.count;
  const input = new Float32Array(count * stride);
  for (let i = 0; i < count; i += 1) {
    let o = i * stride;
    for (const j of order) {
      const a = sources[j];
      for (let k = 0; k < a.itemSize; k += 1) input[o++] = a.array[i * a.itemSize + k];
    }
  }
  const limit = maxEdge * maxEdge;
  let out = new Float32Array(Math.max(stride * 3, input.length * 2));
  let used = 0;
  // Scratch: the vertices of the triangles being split, `stride` numbers each.
  let scratch = new Float32Array(stride * 64);
  let top = 0;
  const push = (src: Float32Array, at: number): number => {
    if (top + stride > scratch.length) {
      const grown = new Float32Array(scratch.length * 2);
      grown.set(scratch);
      scratch = grown;
    }
    const slot = top;
    scratch.set(src.subarray(at, at + stride), slot);
    top += stride;
    return slot;
  };
  const midpoint = (a: number, b: number): number => {
    if (top + stride > scratch.length) {
      const grown = new Float32Array(scratch.length * 2);
      grown.set(scratch);
      scratch = grown;
    }
    const slot = top;
    for (let k = 0; k < stride; k += 1) scratch[slot + k] = (scratch[a + k] + scratch[b + k]) / 2;
    top += stride;
    return slot;
  };
  const len2 = (a: number, b: number) =>
    (scratch[a] - scratch[b]) ** 2 +
    (scratch[a + 1] - scratch[b + 1]) ** 2 +
    (scratch[a + 2] - scratch[b + 2]) ** 2;
  const emit = (v: number) => {
    if (used + stride > out.length) {
      const grown = new Float32Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    out.set(scratch.subarray(v, v + stride), used);
    used += stride;
  };
  const split = (a: number, b: number, c: number, depth: number): void => {
    const ab = len2(a, b);
    const bc = len2(b, c);
    const ca = len2(c, a);
    const longest = Math.max(ab, bc, ca);
    if (longest <= limit || depth > 12) {
      emit(a);
      emit(b);
      emit(c);
      return;
    }
    const mark = top;
    if (longest === ab) {
      const m = midpoint(a, b);
      split(a, m, c, depth + 1);
      split(m, b, c, depth + 1);
    } else if (longest === bc) {
      const m = midpoint(b, c);
      split(a, b, m, depth + 1);
      split(a, m, c, depth + 1);
    } else {
      const m = midpoint(c, a);
      split(a, b, m, depth + 1);
      split(m, b, c, depth + 1);
    }
    top = mark;
  };
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (let i = 0; i < count; i += 3) {
    top = 0;
    const a = push(input, i * stride);
    const b = push(input, (i + 1) * stride);
    const c = push(input, (i + 2) * stride);
    if (accept) {
      e1.set(
        scratch[b] - scratch[a],
        scratch[b + 1] - scratch[a + 1],
        scratch[b + 2] - scratch[a + 2]
      );
      e2.set(
        scratch[c] - scratch[a],
        scratch[c + 1] - scratch[a + 1],
        scratch[c + 2] - scratch[a + 2]
      );
      if (!accept(e1.cross(e2).normalize())) {
        emit(a);
        emit(b);
        emit(c);
        continue;
      }
    }
    split(a, b, c, 0);
  }
  const vertices = used / stride;
  const result = new BufferGeometry();
  let offset = 0;
  for (const j of order) {
    const size = sources[j].itemSize;
    const values = new Float32Array(vertices * size);
    for (let v = 0; v < vertices; v += 1)
      for (let k = 0; k < size; k += 1) values[v * size + k] = out[v * stride + offset + k];
    offset += size;
    result.setAttribute(names[j], new BufferAttribute(values, size));
  }
  const normals = result.getAttribute('normal') as BufferAttribute | undefined;
  if (normals) {
    const v = new Vector3();
    for (let i = 0; i < normals.count; i += 1) {
      v.fromBufferAttribute(normals, i).normalize();
      normals.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return result;
}

/**
 * A bounding-volume hierarchy over a triangle soup, for occlusion rays only ("is anything hit
 * within `far`"). Median split on the longest axis, four triangles a leaf.
 */
export class TriangleBVH {
  private readonly tris: Float32Array;
  private readonly order: Uint32Array;
  private readonly boxes: number[] = [];
  /** Per node: left child (or -1 for a leaf), right child / first triangle, triangle count. */
  private readonly nodes: number[] = [];
  /** The traversal stack, reused by every ray (its depth is bounded by twice the tree's). */
  private stack = new Int32Array(0);

  constructor(positions: Float32Array) {
    this.tris = positions;
    const count = Math.floor(positions.length / 9);
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) this.order[i] = i;
    const centroids = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        centroids[i * 3 + k] =
          (positions[i * 9 + k] + positions[i * 9 + 3 + k] + positions[i * 9 + 6 + k]) / 3;
      }
    }
    if (count > 0) this.build(0, count, centroids);
    this.stack = new Int32Array(Math.max(8, 2 * (Math.ceil(Math.log2(count + 1)) + 2)));
  }

  private build(start: number, end: number, centroids: Float32Array): number {
    const index = this.nodes.length / 3;
    this.nodes.push(-1, start, end - start);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i += 1) {
      const t = this.order[i] * 9;
      for (let v = 0; v < 9; v += 3) {
        for (let k = 0; k < 3; k += 1) {
          const value = this.tris[t + v + k];
          if (value < box[k]) box[k] = value;
          if (value > box[k + 3]) box[k + 3] = value;
        }
      }
    }
    this.boxes.push(...box);
    if (end - start <= 4) return index;
    const extent = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    const axis =
      extent[0] > extent[1] ? (extent[0] > extent[2] ? 0 : 2) : extent[1] > extent[2] ? 1 : 2;
    const middle = (start + end) >> 1;
    this.selectMedian(start, end, middle, centroids, axis);
    const left = this.build(start, middle, centroids);
    const right = this.build(middle, end, centroids);
    this.nodes[index * 3] = left;
    this.nodes[index * 3 + 1] = right;
    return index;
  }

  /** Reorder `order[start, end)` so `order[k]` is the k-th by centroid on `axis`, smaller ones before it (quickselect). */
  private selectMedian(
    start: number,
    end: number,
    k: number,
    centroids: Float32Array,
    axis: number
  ): void {
    const order = this.order;
    const key = (i: number) => centroids[order[i] * 3 + axis];
    let lo = start;
    let hi = end - 1;
    while (lo < hi) {
      const pivot = key((lo + hi) >> 1);
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (key(i) < pivot) i += 1;
        while (key(j) > pivot) j -= 1;
        if (i <= j) {
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
          i += 1;
          j -= 1;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /**
   * Whether a ray from `origin` along unit `dir` hits a triangle at distance in (near, far) —
   * with `frontOnly`, only a triangle it meets from its front (counter-clockwise) side.
   */
  occluded(origin: Vector3, dir: Vector3, far: number, near: number, frontOnly = false): boolean {
    if (this.nodes.length === 0) return false;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const stack = this.stack;
    stack[0] = 0;
    let depth = 1;
    const tris = this.tris;
    while (depth > 0) {
      const node = stack[--depth];
      const b = node * 6;
      const boxes = this.boxes;
      let tx1 = (boxes[b] - ox) * ix;
      let tx2 = (boxes[b + 3] - ox) * ix;
      let tmin = Math.min(tx1, tx2);
      let tmax = Math.max(tx1, tx2);
      tx1 = (boxes[b + 1] - oy) * iy;
      tx2 = (boxes[b + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(tx1, tx2));
      tmax = Math.min(tmax, Math.max(tx1, tx2));
      tx1 = (boxes[b + 2] - oz) * iz;
      tx2 = (boxes[b + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(tx1, tx2));
      tmax = Math.min(tmax, Math.max(tx1, tx2));
      if (tmax < Math.max(tmin, 0) || tmin > far) continue;
      const left = this.nodes[node * 3];
      if (left >= 0) {
        stack[depth++] = left;
        stack[depth++] = this.nodes[node * 3 + 1];
        continue;
      }
      const first = this.nodes[node * 3 + 1];
      const last = first + this.nodes[node * 3 + 2];
      for (let i = first; i < last; i += 1) {
        const t = this.order[i] * 9;
        const ax = tris[t];
        const ay = tris[t + 1];
        const az = tris[t + 2];
        const e1x = tris[t + 3] - ax;
        const e1y = tris[t + 4] - ay;
        const e1z = tris[t + 5] - az;
        const e2x = tris[t + 6] - ax;
        const e2y = tris[t + 7] - ay;
        const e2z = tris[t + 8] - az;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12 || (frontOnly && det < 0)) continue;
        const inv = 1 / det;
        const sx = ox - ax;
        const sy = oy - ay;
        const sz = oz - az;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > near && dist < far) return true;
      }
    }
    return false;
  }

  /** Distance to the nearest hit along `dir` between `near` and `far`, or `far` when nothing is hit. */
  nearest(origin: Vector3, dir: Vector3, far: number, near: number, frontOnly = false): number {
    if (this.nodes.length === 0) return far;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const stack = this.stack;
    stack[0] = 0;
    let depth = 1;
    const tris = this.tris;
    while (depth > 0) {
      const node = stack[--depth];
      const b = node * 6;
      const boxes = this.boxes;
      let tx1 = (boxes[b] - ox) * ix;
      let tx2 = (boxes[b + 3] - ox) * ix;
      let tmin = Math.min(tx1, tx2);
      let tmax = Math.max(tx1, tx2);
      tx1 = (boxes[b + 1] - oy) * iy;
      tx2 = (boxes[b + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(tx1, tx2));
      tmax = Math.min(tmax, Math.max(tx1, tx2));
      tx1 = (boxes[b + 2] - oz) * iz;
      tx2 = (boxes[b + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(tx1, tx2));
      tmax = Math.min(tmax, Math.max(tx1, tx2));
      if (tmax < Math.max(tmin, 0) || tmin > far) continue;
      const left = this.nodes[node * 3];
      if (left >= 0) {
        stack[depth++] = left;
        stack[depth++] = this.nodes[node * 3 + 1];
        continue;
      }
      const first = this.nodes[node * 3 + 1];
      const last = first + this.nodes[node * 3 + 2];
      for (let i = first; i < last; i += 1) {
        const t = this.order[i] * 9;
        const ax = tris[t];
        const ay = tris[t + 1];
        const az = tris[t + 2];
        const e1x = tris[t + 3] - ax;
        const e1y = tris[t + 4] - ay;
        const e1z = tris[t + 5] - az;
        const e2x = tris[t + 6] - ax;
        const e2y = tris[t + 7] - ay;
        const e2z = tris[t + 8] - az;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12 || (frontOnly && det < 0)) continue;
        const inv = 1 / det;
        const sx = ox - ax;
        const sy = oy - ay;
        const sz = oz - az;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > near && dist < far) far = dist;
      }
    }
    return far;
  }
}
