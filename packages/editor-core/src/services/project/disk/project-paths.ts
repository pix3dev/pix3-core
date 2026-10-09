/**
 * Project path keys of the write model. Per-file memory (baselines, pending external versions,
 * drafts) is keyed by the project-relative path WITHOUT a scheme (`scenes/level.pix3scene`):
 * scene descriptors say `res://scenes/level.pix3scene`, the host speaks bare paths, and both must
 * land on the same key.
 */

/** The dev server's own directory (transactions, version journal, temp files). */
export const PIX3_INTERNAL_DIRECTORY = '.pix3';

/** `res://scenes/a.pix3scene`, `./scenes/a.pix3scene`, `/scenes\\a.pix3scene` → `scenes/a.pix3scene`. */
export function toProjectPath(path: string): string {
  return path
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** True for `.pix3` itself and anything under it (in any spelling of the path). */
export function isPix3InternalPath(path: string): boolean {
  const normalized = toProjectPath(path);
  return (
    normalized === PIX3_INTERNAL_DIRECTORY || normalized.startsWith(`${PIX3_INTERNAL_DIRECTORY}/`)
  );
}

/** Scene-format files the stabilisation parse check applies to. */
export function isSceneFilePath(path: string): boolean {
  return /\.(?:pix3scene|prefab)$/i.test(path);
}
