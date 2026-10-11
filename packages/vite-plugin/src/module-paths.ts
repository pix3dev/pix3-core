import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** A module id without its query (`/a/b.ts?v=1` → `/a/b.ts`). */
export const fileOf = (id: string): string => id.split('?')[0];

/** A platform path with `/` separators. */
export const posixPath = (path: string): string => path.split(sep).join('/');

/** `file` relative to `dir`, `/`-separated, when it lies strictly inside `dir`; else null. */
export const relativeInside = (dir: string, file: string): string | null => {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? posixPath(rel) : null;
};

export const isUnder = (file: string, dir: string | null): boolean =>
  dir !== null && relativeInside(dir, file) !== null;

const realPaths = new Map<string, string>();

/**
 * The real path of a module id (query dropped; the id itself when it is not a file), cached. The
 * runtime's `src/` is a real path, and module ids are not always (`resolve.preserveSymlinks`, a
 * linked workspace): comparing the two as written would silently strip nothing.
 */
export const realFileOf = (id: string): string => {
  const file = fileOf(id);
  let real = realPaths.get(file);
  if (real === undefined) {
    try {
      real = realpathSync(file);
    } catch {
      real = file;
    }
    realPaths.set(file, real);
  }
  return real;
};
