/**
 * The MIME type of a project file by extension, for the `Blob`s the editor hands to the browser.
 * The dev server's bytes come without one, and a type-less blob is fine for raster images (the
 * decoder sniffs them) but not for SVG: `<img src=blob:…>` refuses an SVG it cannot identify, so
 * every SVG sprite failed to load in the editor (found by the write-model size cross-check).
 */
const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  json: 'application/json',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export function contentTypeOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) || '';
}
