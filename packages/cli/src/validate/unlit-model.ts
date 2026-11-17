import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a glTF / GLB model draws unlit: every primitive of every mesh has a material, and every
 * such material carries `KHR_materials_unlit` (three.js then builds a `MeshBasicMaterial`). Reads
 * only the JSON — of a `.glb`, its header and first chunk, not the binary buffer. Anything it
 * cannot read is "not known to be unlit" (false), which keeps the light warning.
 */
export const isUnlitModelFile = (file: string): boolean => {
  try {
    const json = file.toLowerCase().endsWith('.gltf') ? readFileSync(file, 'utf8') : glbJson(file);
    const gltf = JSON.parse(json ?? '') as {
      meshes?: { primitives?: { material?: number }[] }[];
      materials?: { extensions?: Record<string, unknown> }[];
    };
    const primitives = (gltf.meshes ?? []).flatMap(mesh => mesh.primitives ?? []);
    return (
      primitives.length > 0 &&
      primitives.every(
        p =>
          typeof p.material === 'number' &&
          gltf.materials?.[p.material]?.extensions?.KHR_materials_unlit !== undefined
      )
    );
  } catch {
    return false;
  }
};

/** A `.glb`'s JSON chunk (the first one, by the spec), or null when it is not a GLB. */
const glbJson = (file: string): string | null => {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) < 20) return null;
    // magic "glTF", then version, length; chunk 0: length, type "JSON".
    if (header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(16) !== 0x4e4f534a)
      return null;
    const length = header.readUInt32LE(12);
    if (20 + length > fstatSync(fd).size) return null; // a chunk longer than the file: not a GLB
    const json = Buffer.alloc(length);
    return readSync(fd, json, 0, length, 20) === length ? json.toString('utf8') : null;
  } finally {
    closeSync(fd);
  }
};

/** `isUnlitModel` for the renderability lint: a `res://` model of the project at `root`. */
export const unlitModelReader = (root: string): ((src: string) => boolean) => {
  const known = new Map<string, boolean>();
  return src => {
    if (!src.startsWith('res://')) return false;
    if (!known.has(src)) known.set(src, isUnlitModelFile(join(root, src.slice(6))));
    return known.get(src)!;
  };
};
