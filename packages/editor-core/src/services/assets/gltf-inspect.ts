/**
 * Byte-level breakdown of a glTF 2.0 model (`.glb` or `.gltf`): what is inside — meshes, textures,
 * materials, animations — and how much of the file each part costs. Pure container parsing (the
 * JSON, the binary chunk, image headers); nothing is decoded or uploaded, so it is cheap enough to
 * run on demand from the Inspector.
 *
 * Byte attribution: every bufferView is charged to ONE owner (first claim wins, in the order
 * textures → meshes → animations → skins), so shared or interleaved views are never counted twice
 * and the shares add up to at most 100%. Meshopt-compressed views are charged their compressed
 * size. Whatever no part claims (padding, unused views, the JSON itself) is reported separately.
 */

export interface GltfInspectMesh {
  name: string;
  primitives: number;
  vertices: number;
  triangles: number;
  /** Vertex attribute names of the first primitive (`POSITION`, `NORMAL`, `TEXCOORD_0`, …). */
  attributes: string[];
  materials: string[];
  /** `draco` / `meshopt` when the geometry is stored compressed. */
  compression: string | null;
  bytes: number;
}

export interface GltfInspectTexture {
  name: string;
  /** `PNG`, `JPEG`, `WEBP`, `KTX2`, … — from the bytes when they can be read, else the mime type. */
  format: string;
  width: number | null;
  height: number | null;
  /** Where the image lives: inside the binary chunk, a data URI, or a separate file. */
  storage: 'embedded' | 'data-uri' | 'external';
  /** Material slots that use the image, e.g. `Hull · baseColor`. */
  usedBy: string[];
  bytes: number;
}

export interface GltfInspectMaterial {
  name: string;
  /** `PBR`, `Unlit`, or the shading extension in use. */
  shading: string;
  alphaMode: string;
  doubleSided: boolean;
  /** Texture slot → image name. */
  textures: Array<{ slot: string; image: string }>;
  /** Bytes of the textures this material uses (a texture shared between materials counts in each). */
  textureBytes: number;
}

export interface GltfInspectAnimation {
  name: string;
  channels: number;
  durationSeconds: number | null;
  bytes: number;
}

export interface GltfInspectReport {
  container: 'glb' | 'gltf';
  generator: string | null;
  /** Bytes of the model file plus every external file it references. */
  totalBytes: number;
  jsonBytes: number;
  binaryBytes: number;
  externalBytes: number;
  nodes: number;
  skins: number;
  skinBytes: number;
  totalVertices: number;
  totalTriangles: number;
  extensionsUsed: string[];
  meshes: GltfInspectMesh[];
  textures: GltfInspectTexture[];
  materials: GltfInspectMaterial[];
  animations: GltfInspectAnimation[];
  /** Buffer bytes no mesh, texture, animation or skin claimed (padding, unused views). */
  otherBinaryBytes: number;
  /** Non-fatal problems: unreadable external files, unknown layouts. */
  warnings: string[];
}

export interface GltfInspectOptions {
  /** Reads a file referenced by a relative `uri` (external buffers/images of a `.gltf`). */
  readExternal?: (uri: string) => Promise<Uint8Array>;
}

type Json = Record<string, unknown>;

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const TEXTURE_SLOTS: Array<[string, (m: Json) => unknown]> = [
  ['baseColor', m => (m.pbrMetallicRoughness as Json | undefined)?.baseColorTexture],
  [
    'metallicRoughness',
    m => (m.pbrMetallicRoughness as Json | undefined)?.metallicRoughnessTexture,
  ],
  ['normal', m => m.normalTexture],
  ['occlusion', m => m.occlusionTexture],
  ['emissive', m => m.emissiveTexture],
];

export async function inspectGltf(
  data: Uint8Array,
  options: GltfInspectOptions = {}
): Promise<GltfInspectReport> {
  const warnings: string[] = [];
  const { json, jsonBytes, bin, container } = splitContainer(data);

  const buffers = arr(json.buffers);
  const bufferViews = arr(json.bufferViews);
  const accessors = arr(json.accessors);
  const images = arr(json.images);
  const textures = arr(json.textures);
  const materials = arr(json.materials);
  const meshes = arr(json.meshes);
  const animations = arr(json.animations);
  const skins = arr(json.skins);

  // Resolve every buffer to bytes (or at least a length) so images and sizes can be read.
  const bufferData: Array<Uint8Array | null> = [];
  let binaryBytes = 0;
  let externalBytes = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    const buffer = buffers[i];
    const uri = str(buffer.uri);
    const meshoptFallback = Boolean(ext(buffer, 'EXT_meshopt_compression')?.fallback);
    if (!uri) {
      if (container === 'glb' && i === 0 && bin) {
        bufferData.push(bin);
        binaryBytes += bin.byteLength;
      } else {
        // A meshopt fallback buffer has no bytes in the file — it is decoded at load time.
        bufferData.push(null);
        if (!meshoptFallback) {
          warnings.push(`Buffer ${i} has no data.`);
        }
      }
      continue;
    }
    const resolved = await resolveUri(uri, options, warnings);
    bufferData.push(resolved.bytes);
    if (resolved.external) {
      externalBytes += resolved.size;
    } else {
      binaryBytes += resolved.size;
    }
  }

  const viewBytes = (index: number): number => {
    const view = bufferViews[index];
    if (!view) {
      return 0;
    }
    const meshopt = ext(view, 'EXT_meshopt_compression');
    return num(meshopt?.byteLength ?? view.byteLength);
  };
  const viewData = (index: number): Uint8Array | null => {
    const view = bufferViews[index];
    const source = view ? bufferData[num(view.buffer)] : null;
    if (!view || !source) {
      return null;
    }
    const offset = num(view.byteOffset);
    return source.subarray(offset, offset + num(view.byteLength));
  };

  const claimed = new Set<number>();
  const claim = (viewIndex: unknown): number => {
    if (typeof viewIndex !== 'number' || claimed.has(viewIndex)) {
      return 0;
    }
    claimed.add(viewIndex);
    return viewBytes(viewIndex);
  };
  const claimAccessor = (accessorIndex: unknown): number => {
    if (typeof accessorIndex !== 'number') {
      return 0;
    }
    const accessor = accessors[accessorIndex];
    if (!accessor) {
      return 0;
    }
    const sparse = accessor.sparse as Json | undefined;
    return (
      claim(accessor.bufferView) +
      claim((sparse?.indices as Json | undefined)?.bufferView) +
      claim((sparse?.values as Json | undefined)?.bufferView)
    );
  };

  const imageName = (index: number): string => {
    const image = images[index];
    const uri = image ? str(image.uri) : null;
    return (
      str(image?.name) ??
      (uri && !uri.startsWith('data:') ? (uri.split('/').pop() ?? uri) : `image ${index}`)
    );
  };
  const materialName = (index: number): string =>
    str(materials[index]?.name) ?? `material ${index}`;

  // Images first: they are usually the bulk of the file.
  const usedBy = new Map<number, string[]>();
  const materialTextures = materials.map((material, index) => {
    const slots: Array<{ slot: string; image: number }> = [];
    for (const [slot, read] of materialSlots(material)) {
      const textureIndex = (read as Json | undefined)?.index;
      const image = typeof textureIndex === 'number' ? textureSource(textures[textureIndex]) : null;
      if (image === null) {
        continue;
      }
      slots.push({ slot, image });
      const users = usedBy.get(image) ?? [];
      users.push(`${materialName(index)} · ${slot}`);
      usedBy.set(image, users);
    }
    return slots;
  });

  const textureReports: GltfInspectTexture[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const uri = str(image.uri);
    let bytes = 0;
    let content: Uint8Array | null = null;
    let storage: GltfInspectTexture['storage'] = 'embedded';
    if (typeof image.bufferView === 'number') {
      bytes = claim(image.bufferView);
      content = viewData(image.bufferView);
    } else if (uri) {
      const resolved = await resolveUri(uri, options, warnings);
      content = resolved.bytes;
      bytes = resolved.size;
      storage = resolved.external ? 'external' : 'data-uri';
      if (resolved.external) {
        externalBytes += resolved.size;
      } else {
        // A data-URI image lives inside the JSON; it is carved out of jsonBytes below.
        binaryBytes += resolved.size;
      }
    }
    const header = content ? readImageHeader(content) : null;
    textureReports.push({
      name: imageName(i),
      format: header?.format ?? mimeToFormat(str(image.mimeType)) ?? 'unknown',
      width: header?.width ?? null,
      height: header?.height ?? null,
      storage,
      usedBy: usedBy.get(i) ?? [],
      bytes,
    });
  }

  let totalVertices = 0;
  let totalTriangles = 0;
  const meshReports: GltfInspectMesh[] = meshes.map((mesh, index) => {
    let bytes = 0;
    let vertices = 0;
    let triangles = 0;
    let compression: string | null = null;
    const meshMaterials = new Set<string>();
    const primitives = arr(mesh.primitives);
    for (const primitive of primitives) {
      const attributes = (primitive.attributes as Json | undefined) ?? {};
      const draco = ext(primitive, 'KHR_draco_mesh_compression');
      if (draco) {
        compression = 'draco';
        bytes += claim(draco.bufferView);
      }
      for (const accessorIndex of Object.values(attributes)) {
        bytes += claimAccessor(accessorIndex);
      }
      for (const target of arr(primitive.targets)) {
        for (const accessorIndex of Object.values(target)) {
          bytes += claimAccessor(accessorIndex);
        }
      }
      bytes += claimAccessor(primitive.indices);

      const vertexCount = num(accessors[num(attributes.POSITION, -1)]?.count);
      const indexCount =
        typeof primitive.indices === 'number' ? num(accessors[primitive.indices]?.count) : null;
      const mode = typeof primitive.mode === 'number' ? primitive.mode : 4;
      vertices += vertexCount;
      triangles += countTriangles(mode, indexCount ?? vertexCount);
      if (typeof primitive.material === 'number') {
        meshMaterials.add(materialName(primitive.material));
      }
      if (!compression && usesMeshopt(primitive, accessors, bufferViews)) {
        compression = 'meshopt';
      }
    }
    totalVertices += vertices;
    totalTriangles += triangles;
    return {
      name: str(mesh.name) ?? `mesh ${index}`,
      primitives: primitives.length,
      vertices,
      triangles,
      attributes: Object.keys((primitives[0]?.attributes as Json | undefined) ?? {}),
      materials: [...meshMaterials],
      compression,
      bytes,
    };
  });

  const animationReports: GltfInspectAnimation[] = animations.map((animation, index) => {
    let bytes = 0;
    let duration: number | null = null;
    for (const sampler of arr(animation.samplers)) {
      bytes += claimAccessor(sampler.input) + claimAccessor(sampler.output);
      const max = arr<unknown>(accessors[num(sampler.input, -1)]?.max as unknown[] | undefined)[0];
      if (typeof max === 'number') {
        duration = Math.max(duration ?? 0, max);
      }
    }
    return {
      name: str(animation.name) ?? `animation ${index}`,
      channels: arr(animation.channels).length,
      durationSeconds: duration,
      bytes,
    };
  });

  let skinBytes = 0;
  for (const skin of skins) {
    skinBytes += claimAccessor(skin.inverseBindMatrices);
  }

  const materialReports: GltfInspectMaterial[] = materials.map((material, index) => {
    const slots = materialTextures[index];
    const textureBytes = [...new Set(slots.map(slot => slot.image))].reduce(
      (sum, image) => sum + (textureReports[image]?.bytes ?? 0),
      0
    );
    return {
      name: materialName(index),
      shading: materialShading(material),
      alphaMode: str(material.alphaMode) ?? 'OPAQUE',
      doubleSided: material.doubleSided === true,
      textures: slots.map(slot => ({
        slot: slot.slot,
        image: textureReports[slot.image]?.name ?? '?',
      })),
      textureBytes,
    };
  });

  // Data-URI images and buffers are counted in the binary totals; take them out of the JSON size.
  const dataUriBytes = dataUriPayloadBytes(json);
  const jsonOnlyBytes = Math.max(0, jsonBytes - dataUriBytes);

  const claimedBytes =
    meshReports.reduce((sum, mesh) => sum + mesh.bytes, 0) +
    animationReports.reduce((sum, animation) => sum + animation.bytes, 0) +
    textureReports.reduce((sum, texture) => sum + texture.bytes, 0) +
    skinBytes;
  const fileBytes = container === 'glb' ? data.byteLength : jsonOnlyBytes + binaryBytes;

  return {
    container,
    generator: str((json.asset as Json | undefined)?.generator),
    totalBytes: fileBytes + externalBytes,
    jsonBytes: jsonOnlyBytes,
    binaryBytes,
    externalBytes,
    nodes: arr(json.nodes).length,
    skins: skins.length,
    skinBytes,
    totalVertices,
    totalTriangles,
    extensionsUsed: arr<unknown>(json.extensionsUsed as unknown[] | undefined).filter(
      (value): value is string => typeof value === 'string'
    ),
    meshes: meshReports,
    textures: textureReports,
    materials: materialReports,
    animations: animationReports,
    otherBinaryBytes: Math.max(0, binaryBytes + externalBytes - claimedBytes),
    warnings,
  };
}

/** `PNG` / `JPEG` / `WEBP` / `KTX2` / `GIF` and pixel size, from the first bytes of an image. */
export function readImageHeader(
  bytes: Uint8Array
): { format: string; width: number | null; height: number | null } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (offset: number, ...values: number[]) =>
    values.every((value, i) => bytes[offset + i] === value);

  if (bytes.length >= 24 && at(0, 0x89, 0x50, 0x4e, 0x47)) {
    return { format: 'PNG', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && at(0, 0xff, 0xd8)) {
    // Walk the JPEG segments to the first start-of-frame marker.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          format: 'JPEG',
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
        };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return { format: 'JPEG', width: null, height: null };
  }
  if (bytes.length >= 30 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8 ') {
      return {
        format: 'WEBP',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { format: 'WEBP', width, height };
    }
    return { format: 'WEBP', width: null, height: null };
  }
  if (bytes.length >= 28 && at(0, 0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30)) {
    return { format: 'KTX2', width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }
  if (bytes.length >= 10 && at(0, 0x47, 0x49, 0x46)) {
    return { format: 'GIF', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  return null;
}

function splitContainer(data: Uint8Array): {
  json: Json;
  jsonBytes: number;
  bin: Uint8Array | null;
  container: 'glb' | 'gltf';
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    const text = new TextDecoder().decode(data);
    return { json: parseJson(text), jsonBytes: data.byteLength, bin: null, container: 'gltf' };
  }

  let json: Json | null = null;
  let jsonBytes = 0;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON && !json) {
      json = parseJson(new TextDecoder().decode(body));
      jsonBytes = length;
    } else if (type === CHUNK_BIN && !bin) {
      bin = body;
    }
    offset += 8 + length;
  }
  if (!json) {
    throw new Error('GLB has no JSON chunk.');
  }
  return { json, jsonBytes, bin, container: 'glb' };
}

function parseJson(text: string): Json {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('glTF JSON is not an object.');
  }
  return value as Json;
}

async function resolveUri(
  uri: string,
  options: GltfInspectOptions,
  warnings: string[]
): Promise<{ bytes: Uint8Array | null; size: number; external: boolean }> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const payload = uri.slice(comma + 1);
    if (uri.slice(0, comma).endsWith(';base64')) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { bytes, size: bytes.byteLength, external: false };
    }
    const bytes = new TextEncoder().encode(decodeURIComponent(payload));
    return { bytes, size: bytes.byteLength, external: false };
  }
  if (!options.readExternal) {
    warnings.push(`External file not read: ${uri}`);
    return { bytes: null, size: 0, external: true };
  }
  try {
    const bytes = await options.readExternal(decodeURIComponent(uri));
    return { bytes, size: bytes.byteLength, external: true };
  } catch {
    warnings.push(`External file missing: ${uri}`);
    return { bytes: null, size: 0, external: true };
  }
}

function dataUriPayloadBytes(json: Json): number {
  let total = 0;
  for (const entry of [...arr(json.buffers), ...arr(json.images)]) {
    const uri = str(entry.uri);
    if (uri?.startsWith('data:')) {
      total += uri.length;
    }
  }
  return total;
}

function materialSlots(material: Json): Array<[string, unknown]> {
  const slots: Array<[string, unknown]> = TEXTURE_SLOTS.map(([slot, read]) => [
    slot,
    read(material),
  ]);
  const extensions = (material.extensions as Json | undefined) ?? {};
  for (const [name, value] of Object.entries(extensions)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const short = name.replace(/^KHR_materials_/, '');
    for (const [key, slot] of Object.entries(value as Json)) {
      if (key.endsWith('Texture')) {
        slots.push([`${short}.${key.replace(/Texture$/, '')}`, slot]);
      }
    }
  }
  return slots;
}

function textureSource(texture: Json | undefined): number | null {
  if (!texture) {
    return null;
  }
  for (const name of ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif']) {
    const source = ext(texture, name)?.source;
    if (typeof source === 'number') {
      return source;
    }
  }
  return typeof texture.source === 'number' ? texture.source : null;
}

function materialShading(material: Json): string {
  const extensions = Object.keys((material.extensions as Json | undefined) ?? {});
  if (extensions.includes('KHR_materials_unlit')) {
    return 'Unlit';
  }
  if (extensions.includes('KHR_materials_pbrSpecularGlossiness')) {
    return 'Specular-Glossiness';
  }
  return 'PBR';
}

function usesMeshopt(primitive: Json, accessors: Json[], bufferViews: Json[]): boolean {
  const attributes = Object.values((primitive.attributes as Json | undefined) ?? {});
  return [...attributes, primitive.indices].some(index => {
    const view = typeof index === 'number' ? accessors[index]?.bufferView : undefined;
    return typeof view === 'number' && Boolean(ext(bufferViews[view], 'EXT_meshopt_compression'));
  });
}

function countTriangles(mode: number, count: number): number {
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function mimeToFormat(mime: string | null): string | null {
  if (!mime) return null;
  const sub = mime.split('/')[1] ?? mime;
  return sub.toUpperCase();
}

function ext(owner: Json | undefined, name: string): Json | undefined {
  return ((owner?.extensions as Json | undefined)?.[name] as Json | undefined) ?? undefined;
}

function arr<T = Json>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
