import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { errnoCode, HttpError, isRecord } from '../server/http.ts';
import { parseWirePath, RESERVED_ROOT_DIR } from './paths.ts';

/**
 * Multi-file transactions of the write path (plan §C.4 "Changeset: staging и восстановление").
 * `temp+rename` is atomic for one file only; a flush that touches a scene and a prefab must land
 * both or neither, including across a crash of the dev server between the two renames.
 *
 * On-disk layout of one transaction `<id>`:
 *
 *     .pix3/tx/<id>/new/<n>       the new bytes of entry n (fsynced before the intent)
 *     .pix3/tx/<id>/old/<n>       a copy of what was at entry n's path (absent when nothing was)
 *     .pix3/tx/<id>/intent.json   {id, files: [{path, sha256, old: 'absent' | 'old/<n>'}],
 *                                  state: 'prepared' | 'committed'} — replaced atomically
 *
 * Renames start only once `intent.json` is durable, so a transaction without a readable intent
 * never touched a project file. A rename moves `new/<n>` away, so "staged file still present"
 * means "not renamed yet"; a missing staged file whose target has the intended sha was renamed.
 */

export interface ChangesetEntry {
  readonly path: string;
  readonly data: Buffer;
  readonly sha256: string;
  /** Entity tags the file must match (`*` = must exist), or null for unconditional. */
  readonly ifMatch: readonly string[] | null;
  readonly createOnly: boolean;
}

export interface TxIntentFile {
  readonly path: string;
  readonly sha256: string;
  readonly old: 'absent' | `old/${number}`;
}

export interface TxIntent {
  readonly id: string;
  readonly files: readonly TxIntentFile[];
  readonly state: 'prepared' | 'committed';
}

/** What recovery did to one path; the caller journals it. */
export interface RecoveredFile {
  readonly path: string;
  readonly author: 'editor' | 'restore';
}

export const MAX_CHANGESET_BYTES = 256 * 1024 * 1024;
const MAX_CHANGESET_FILES = 1_000;

export const txRootOf = (root: string): string => join(root, RESERVED_ROOT_DIR, 'tx');

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** `"<hex>"`, `<hex>` or `*` from a JSON `ifMatch`. */
const parseIfMatch = (raw: unknown, index: number): string[] | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpError(400, 'bad_request', `files[${index}].ifMatch must be a string.`);
  }
  const tag = raw.trim().replace(/^W\//, '');
  return [tag.startsWith('"') && tag.endsWith('"') && tag.length >= 2 ? tag.slice(1, -1) : tag];
};

/** Validate `POST /__pix3/api/changeset` `{files: [{path, text? | base64?, ifMatch?, createOnly?}]}`. */
export const parseChangeset = (body: Record<string, unknown>): ChangesetEntry[] => {
  const raw = body.files;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'bad_request', '`files` must be a non-empty array.');
  }
  if (raw.length > MAX_CHANGESET_FILES) {
    throw new HttpError(413, 'too_many_files', `At most ${MAX_CHANGESET_FILES} files.`);
  }
  const seen = new Set<string>();
  return raw.map((item: unknown, index): ChangesetEntry => {
    if (!isRecord(item))
      throw new HttpError(400, 'bad_request', `files[${index}] is not an object.`);
    const path = parseWirePath(item.path, `files[${index}].path`);
    if (seen.has(path)) {
      throw new HttpError(400, 'bad_request', `${path} appears twice in one changeset.`);
    }
    seen.add(path);
    const hasText = typeof item.text === 'string';
    const hasBase64 = typeof item.base64 === 'string';
    if (hasText === hasBase64) {
      throw new HttpError(
        400,
        'bad_request',
        `files[${index}] needs exactly one of \`text\` or \`base64\`.`
      );
    }
    const data = hasText
      ? Buffer.from(item.text as string, 'utf8')
      : Buffer.from(item.base64 as string, 'base64');
    return {
      path,
      data,
      sha256: sha256Of(data),
      ifMatch: parseIfMatch(item.ifMatch, index),
      createOnly: item.createOnly === true,
    };
  });
};

/** A request fingerprint for `X-Mutation-Id` replay: same paths, conditions and bytes. */
export const changesetFingerprint = (entries: readonly ChangesetEntry[]): string =>
  [
    'changeset',
    ...entries.map(
      entry =>
        `${entry.path}\n${entry.sha256}\n${entry.ifMatch?.join(',') ?? ''}\n${entry.createOnly}`
    ),
  ].join('\n');

/** fsync a directory, so a rename or a create inside it is durable. A no-op where unsupported. */
export const fsyncDir = async (dir: string): Promise<void> => {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    // Windows cannot open a directory for fsync (EPERM/EISDIR); NTFS journals the rename itself.
    const code = errnoCode(error);
    if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EINVAL' && code !== 'EBADF') throw error;
  } finally {
    await handle?.close();
  }
};

/** Write `bytes` to a new file and fsync it. */
const writeSynced = async (path: string, bytes: Uint8Array): Promise<void> => {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Replace `intent.json` atomically and durably (temp + fsync + rename + fsync of the dir). */
export const writeIntent = async (txDir: string, intent: TxIntent): Promise<void> => {
  const temp = join(txDir, `intent.${randomBytes(4).toString('hex')}.tmp`);
  await writeSynced(temp, Buffer.from(`${JSON.stringify(intent, null, 2)}\n`));
  await rename(temp, join(txDir, 'intent.json'));
  await fsyncDir(txDir);
};

/**
 * Rename `temp` over `target`. When `.pix3/` is on another device than the target, the bytes are
 * copied to a sibling first and renamed from there, so the replace itself stays atomic.
 */
export const renameIntoPlace = async (temp: string, target: string): Promise<void> => {
  try {
    await rename(temp, target);
  } catch (error) {
    if (errnoCode(error) !== 'EXDEV') throw error;
    const sibling = join(
      dirname(target),
      `.${basename(target)}.pix3-tmp-${randomBytes(6).toString('hex')}`
    );
    const source = await open(temp, 'r');
    try {
      await pipeline(source.createReadStream(), createWriteStream(sibling, { flags: 'wx' }));
    } finally {
      await source.close().catch(() => undefined);
    }
    await rename(sibling, target);
    await rm(temp, { force: true });
  }
};

export interface StagedFile {
  readonly entry: ChangesetEntry;
  readonly absolute: string;
  /** The file's mode bits to keep, or null when nothing is there yet. */
  readonly mode: number | null;
}

/**
 * Steps 3 of plan §C.4: stage the new bytes and copies of the old ones, then write the intent
 * (`prepared`). Returns the transaction directory and its intent; nothing in the project changed.
 */
export const stageTransaction = async (
  root: string,
  files: readonly StagedFile[]
): Promise<{ txDir: string; intent: TxIntent }> => {
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const txDir = join(txRootOf(root), id);
  await mkdir(join(txDir, 'new'), { recursive: true, mode: 0o700 });
  await mkdir(join(txDir, 'old'), { recursive: true, mode: 0o700 });
  const intentFiles: TxIntentFile[] = [];
  for (const [n, file] of files.entries()) {
    const staged = join(txDir, 'new', String(n));
    await writeSynced(staged, file.entry.data);
    if (file.mode !== null) {
      const handle = await open(staged, 'r');
      try {
        await handle.chmod(file.mode);
      } finally {
        await handle.close();
      }
      const old = join(txDir, 'old', String(n));
      await copyFile(file.absolute, old);
      const oldHandle = await open(old, 'r');
      try {
        await oldHandle.sync();
      } finally {
        await oldHandle.close();
      }
    }
    intentFiles.push({
      path: file.entry.path,
      sha256: file.entry.sha256,
      old: file.mode === null ? 'absent' : `old/${n}`,
    });
  }
  await fsyncDir(join(txDir, 'new'));
  await fsyncDir(join(txDir, 'old'));
  const intent: TxIntent = { id, files: intentFiles, state: 'prepared' };
  await writeIntent(txDir, intent);
  await fsyncDir(txRootOf(root));
  return { txDir, intent };
};

/** Put entry `n`'s old bytes back (or remove the file it created). */
export const rollBackFile = async (
  root: string,
  txDir: string,
  file: TxIntentFile
): Promise<void> => {
  const target = join(root, ...file.path.split('/'));
  if (file.old === 'absent') {
    await unlink(target).catch((error: unknown) => {
      if (errnoCode(error) !== 'ENOENT') throw error;
    });
    return;
  }
  await renameIntoPlace(join(txDir, file.old), target);
};

const hashFile = async (absolute: string): Promise<string | null> => {
  try {
    return sha256Of(await readFile(absolute));
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await open(path, 'r').then(handle => handle.close());
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
};

const isIntent = (value: unknown): value is TxIntent => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (value.state !== 'prepared' && value.state !== 'committed') return false;
  if (!Array.isArray(value.files)) return false;
  return value.files.every(
    (file: unknown) =>
      isRecord(file) &&
      typeof file.path === 'string' &&
      typeof file.sha256 === 'string' &&
      (file.old === 'absent' || (typeof file.old === 'string' && /^old\/\d+$/.test(file.old)))
  );
};

const readIntent = async (txDir: string): Promise<TxIntent | null> => {
  try {
    const parsed = JSON.parse(await readFile(join(txDir, 'intent.json'), 'utf8')) as unknown;
    if (!isIntent(parsed)) return null;
    // A path in the intent is written to and deleted on recovery: it must be a valid wire path.
    for (const file of parsed.files) parseWirePath(file.path);
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Recovery at plugin start (plan §C.4), before the first scan. For every `.pix3/tx/<id>/`:
 *
 * - no readable intent → nothing was renamed yet (renames start after the intent is durable):
 *   the directory is removed;
 * - `committed` → every file is in place: clean up (the versions are journaled as `editor`);
 * - `prepared` and consistent — every entry is either still staged with the intended bytes, or
 *   gone from `new/` with the target at the intended sha → roll forward;
 * - `prepared` and anything else (a staged file lost, a renamed target with other bytes) → roll
 *   back every renamed entry from `old/` (a target whose old was `absent` is deleted).
 *
 * Either way both files of a two-file changeset end up all old or all new (gate row N6).
 */
export const recoverTransactions = async (
  root: string,
  log: (line: string) => void
): Promise<RecoveredFile[]> => {
  const txRoot = txRootOf(root);
  let ids: string[];
  try {
    ids = (await readdir(txRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  const recovered: RecoveredFile[] = [];
  for (const id of ids.sort()) {
    const txDir = join(txRoot, id);
    const intent = await readIntent(txDir);
    if (!intent) {
      log(`changeset ${id}: no readable intent, nothing was renamed; discarded`);
      await rm(txDir, { recursive: true, force: true });
      continue;
    }
    if (intent.state === 'committed') {
      log(`changeset ${id}: committed; cleaned up`);
      for (const file of intent.files) recovered.push({ path: file.path, author: 'editor' });
      await rm(txDir, { recursive: true, force: true });
      continue;
    }
    const status: { file: TxIntentFile; staged: string; pending: boolean; consistent: boolean }[] =
      [];
    for (const [n, file] of intent.files.entries()) {
      const staged = join(txDir, 'new', String(n));
      const target = join(root, ...file.path.split('/'));
      if (await exists(staged)) {
        status.push({
          file,
          staged,
          pending: true,
          consistent: (await hashFile(staged)) === file.sha256,
        });
      } else {
        status.push({
          file,
          staged,
          pending: false,
          consistent: (await hashFile(target)) === file.sha256,
        });
      }
    }
    if (status.every(item => item.consistent)) {
      for (const item of status) {
        const target = join(root, ...item.file.path.split('/'));
        if (item.pending) {
          await mkdir(dirname(target), { recursive: true });
          await renameIntoPlace(item.staged, target);
        }
        recovered.push({ path: item.file.path, author: 'editor' });
      }
      log(
        `changeset ${id}: interrupted after staging; rolled forward (${intent.files.length} files)`
      );
    } else {
      for (const item of status) {
        // A still-staged entry never reached its target: the old bytes are what is there.
        if (item.pending) continue;
        if (item.file.old !== 'absent' && !(await exists(join(txDir, item.file.old)))) {
          log(`changeset ${id}: cannot roll back ${item.file.path}, its old copy is missing`);
          continue;
        }
        await rollBackFile(root, txDir, item.file);
        recovered.push({ path: item.file.path, author: 'restore' });
      }
      log(`changeset ${id}: staging incomplete; rolled back (${intent.files.length} files)`);
    }
    await rm(txDir, { recursive: true, force: true });
  }
  return recovered;
};
