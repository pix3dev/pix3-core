import { normalizeAnimationResource, type AnimationResource } from '@pix3/runtime';

export function normalizeAnimationAssetPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const withScheme = trimmed.startsWith('res://')
    ? trimmed
    : `res://${trimmed.replace(/^\/+/, '')}`;

  if (withScheme.endsWith('.pix3anim')) {
    return withScheme;
  }

  const normalizedRelativePath = withScheme
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const pathSegments = normalizedRelativePath.split('/').filter(Boolean);
  const stem = pathSegments[pathSegments.length - 1] ?? 'animation';

  return `res://${normalizedRelativePath}/${stem}.pix3anim`;
}

export function getAnimationAssetDirectory(resourcePath: string): string {
  const normalizedPath = normalizeAnimationAssetPath(resourcePath);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  if (lastSlashIndex <= 'res://'.length) {
    return 'res://';
  }

  return normalizedPath.slice(0, lastSlashIndex);
}

/**
 * True when `resource`'s frames all live in the same folder as `assetPath` — the structural
 * predicate behind navigator grouping and the managed-folder bulk tools (§8.2). Cheap: it reads
 * only the already-parsed resource, never the filesystem.
 */
export function isManagedSpriteFolder(
  assetPath: string,
  frameTexturePaths: readonly string[]
): boolean {
  const directory = getAnimationAssetDirectory(assetPath);
  const resolvedFrames = frameTexturePaths.map(path => path.trim()).filter(Boolean);
  if (resolvedFrames.length === 0) {
    return false;
  }

  return resolvedFrames.every(framePath => {
    const normalized = framePath.replace(/\\/g, '/');
    const withScheme = normalized.startsWith('res://')
      ? normalized
      : `res://${normalized.replace(/^\/+/, '')}`;
    const lastSlashIndex = withScheme.lastIndexOf('/');
    const frameDirectory =
      lastSlashIndex <= 'res://'.length ? 'res://' : withScheme.slice(0, lastSlashIndex);
    return frameDirectory === directory;
  });
}

export function parseAnimationResourceText(source: string): AnimationResource {
  return normalizeAnimationResource(JSON.parse(source));
}
