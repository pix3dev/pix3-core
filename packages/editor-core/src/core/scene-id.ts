/**
 * Scene ids are derived deterministically from a scene resource path so that the same
 * `.pix3scene` file always maps to the same id (the tab, the loader and the bridge agree on it).
 */
export function deriveSceneIdFromResourcePath(resourcePath: string): string {
  const withoutScheme = resourcePath.replace(/^res:\/\//i, '').replace(/^templ:\/\//i, '');
  const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
  const normalized = withoutExtension
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'scene';
}
