import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** File helpers every command shares (Node-runnable: no runtime, no third-party imports). */

/** The file as UTF-8, or null when it is missing or unreadable. */
export const readTextOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Write through a temp file and a rename, so a reader never sees half a file; creates the folder.
 * `mode` applies to a newly written file (an existing file's wider mode is {@link narrowTo0600}'s).
 */
export const writeAtomic = (
  path: string,
  contents: string | Uint8Array,
  options: { readonly mode?: number } = {}
): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, options.mode === undefined ? undefined : { mode: options.mode });
  renameSync(temp, path);
};

export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Narrow a file group or others can read to 0600 (POSIX; Windows has no mode bits — the profile
 * directory's ACL protects it there). A failed stat or chmod is left to the caller's own read.
 */
export const narrowTo0600 = (path: string): void => {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    // the caller's read succeeds or fails on its own
  }
};

/** `join(dir, relativePath)` for the nearest `dir` (from `start` up) where it exists, or null. */
export const findUp = (start: string, relativePath: string): string | null => {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
};
