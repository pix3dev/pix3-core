import { lstat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { errnoCode, HttpError } from '../server/http.ts';

/**
 * Wire paths of the file API (port of `packages/cli/src/serve/paths.ts`): POSIX, relative to the
 * project root (Vite's `root`), case preserved.
 *
 * The plugin enforces the root, so the rules are strict rather than normalising: a path that is
 * not already canonical is refused, not repaired. Percent-decoding happens exactly once, by
 * `URLSearchParams` for `?path=` (JSON bodies are not decoded at all) — a literal `%2e%2e` that
 * survives that one decoding is an ordinary file name, never a second chance to spell `..`.
 */

/**
 * Directory under the root that holds the plugin's own state (`dev.json`, staging, the version
 * journal). Never part of the revision set; through the API only its plugin-private entries are
 * refused, so the editor can still keep its own files there.
 */
export const RESERVED_ROOT_DIR = '.pix3';

/**
 * Entries directly under `.pix3/` that belong to the plugin (compared case-insensitively, so a
 * case-insensitive disk cannot be used to spell them differently). Anything below a private
 * directory is private too.
 */
const PLUGIN_PRIVATE_ENTRIES: ReadonlySet<string> = new Set([
  'dev.json',
  'dev.log',
  'tmp',
  'tx',
  'history',
  'local',
]);

/**
 * True for paths the file API refuses with `403 reserved_path`: `.pix3` itself (so it can be
 * neither deleted nor moved) and the plugin-private entries under it.
 */
export const isPluginPrivatePath = (wirePath: string): boolean => {
  const segments = wirePath.split('/');
  if (segments[0].toLowerCase() !== RESERVED_ROOT_DIR) return false;
  if (segments.length === 1) return true;
  return PLUGIN_PRIVATE_ENTRIES.has(segments[1].toLowerCase());
};

const MAX_PATH_LENGTH = 4096;

const bad = (message: string): HttpError => new HttpError(400, 'bad_path', message);

/** Validate a wire path and return it unchanged (it is already canonical when accepted). */
export const parseWirePath = (raw: unknown, field = 'path'): string => {
  if (typeof raw !== 'string' || raw.length === 0)
    throw bad(`\`${field}\` must be a non-empty string.`);
  if (raw.length > MAX_PATH_LENGTH) throw bad(`\`${field}\` is too long.`);
  if (raw.includes('\0')) throw bad(`\`${field}\` contains a NUL byte.`);
  if (raw.includes('\\')) throw bad(`\`${field}\` must use "/" separators, not backslashes.`);
  if (raw.startsWith('/')) throw bad(`\`${field}\` must be relative to the project root.`);
  if (/^[A-Za-z]:/.test(raw)) throw bad(`\`${field}\` must not carry a drive letter.`);
  for (const segment of raw.split('/')) {
    if (segment === '')
      throw bad(`\`${field}\` has an empty segment (leading, trailing or double "/").`);
    if (segment === '.' || segment === '..')
      throw bad(`\`${field}\` must not contain "." or "..".`);
    // Windows spellings of ANOTHER name, refused on every platform so a path means the same thing
    // everywhere: `name:stream` is an NTFS alternate data stream, and Win32 strips trailing dots
    // and spaces (`dev.json.` opens `dev.json`).
    if (segment.includes(':'))
      throw bad(`\`${field}\` must not contain ":" (a drive or an NTFS stream name).`);
    if (segment.endsWith('.') || segment.endsWith(' '))
      throw bad(`\`${field}\` has a segment ending in "." or a space.`);
  }
  if (isPluginPrivatePath(raw)) {
    throw new HttpError(
      403,
      'reserved_path',
      `\`${RESERVED_ROOT_DIR}\` itself and \`${RESERVED_ROOT_DIR}/{dev.json,dev.log,tmp,tx,history,` +
        'local}` belong to the plugin.'
    );
  }
  return raw;
};

export interface ResolvedPath {
  readonly absolute: string;
  /** What is at the path now; `null` when nothing is (only possible with `allowMissing`). */
  readonly kind: 'file' | 'dir' | 'other' | null;
}

/**
 * Resolve a validated wire path under `root` without ever passing through a symlink.
 *
 * Every existing component (parents included, which is what protects a path about to be CREATED)
 * is `lstat`ed: a symlink anywhere is refused with 403 `symlink`, a file where a directory is
 * needed with 409 `not_a_directory`. This is a check, not a lock: a local process that swaps a
 * directory for a symlink between the check and the use wins the race (same-user local processes
 * are trusted).
 */
export const resolveInsideRoot = async (
  root: string,
  wirePath: string,
  options: { readonly allowMissing: boolean }
): Promise<ResolvedPath> => {
  const segments = wirePath.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const last = i === segments.length - 1;
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT') {
        if (!options.allowMissing)
          throw new HttpError(404, 'not_found', `${wirePath} does not exist.`);
        return { absolute: join(root, ...segments), kind: null };
      }
      if (code === 'ENOTDIR') {
        throw new HttpError(409, 'not_a_directory', `A parent of ${wirePath} is not a directory.`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new HttpError(
        403,
        'symlink',
        `${wirePath} goes through a symbolic link; the file API does not follow them.`
      );
    }
    if (!last && !stats.isDirectory()) {
      throw new HttpError(409, 'not_a_directory', `A parent of ${wirePath} is not a directory.`);
    }
    if (process.platform === 'win32') {
      await refuseShortNameAlias(current, segments[i], wirePath);
    }
    if (last) {
      return {
        absolute: current,
        kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : 'other',
      };
    }
  }
  // Unreachable: `parseWirePath` guarantees at least one segment.
  throw bad('Empty path.');
};

/**
 * Windows only: refuse a segment that opened the entry under a name other than its own — an 8.3
 * short name (`.pix3/DEV~1.JSO`) would otherwise slip past {@link isPluginPrivatePath}, which only
 * knows the long names. NTFS names are case-insensitive, and case is not an alias.
 */
const refuseShortNameAlias = async (
  absolute: string,
  segment: string,
  wirePath: string
): Promise<void> => {
  const longName = basename(await realpath(absolute));
  if (longName.toLowerCase() !== segment.toLowerCase()) {
    throw bad(`${wirePath} uses "${segment}", an alias of "${longName}"; use the long name.`);
  }
};

/** Parent wire path, or `null` for a top-level entry. */
export const parentOf = (wirePath: string): string | null => {
  const slash = wirePath.lastIndexOf('/');
  return slash < 0 ? null : wirePath.slice(0, slash);
};
