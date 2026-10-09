import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errnoCode, HttpError } from '../server/http.ts';
import { RESERVED_ROOT_DIR } from './paths.ts';

/**
 * The version journal `.pix3/history/` (plan §C.4 "Журнал", Node port of the 1.x
 * `RecoveryJournalService`). It is what the History panel lists and restores from, and what makes
 * "the version before the agent's change" recoverable: every version a write, the watcher, a
 * restore or a rejected editor draft produced is kept as raw bytes.
 *
 * Layout, per wire path `<p>` (the path's own segments, so `scenes/a.pix3scene` is a directory):
 *
 *     .pix3/history/<p>/index.jsonl          one JSON line per version, oldest first
 *     .pix3/history/<p>/<stamp>-<hash8>      the version's bytes
 *
 * `<stamp>` is the epoch-ms time zero-padded to 13 digits (ids sort like their times), `<hash8>`
 * the first 8 hex digits of the sha256. Every caller runs under `ProjectFiles.serial`, so appends
 * and prunes of one index never interleave; readers skip a torn last line.
 */

export type HistoryAuthor = 'editor' | 'external' | 'restore' | 'rejected-draft';

export interface HistoryEntry {
  readonly id: string;
  readonly path: string;
  readonly author: HistoryAuthor;
  readonly at: number;
  readonly sha256: string;
  readonly size: number;
  readonly note?: string;
}

/**
 * Retention per path (plan §C.4): the newest 200 versions, none older than 7 days — except the
 * newest version, which age never prunes (the current disk must stay restorable).
 */
export const HISTORY_MAX_VERSIONS = 200;
export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const AUTHORS: ReadonlySet<string> = new Set(['editor', 'external', 'restore', 'rejected-draft']);
const ID_PATTERN = /^\d{13}-[0-9a-f]{8}(?:-\d{1,4})?$/;
const INDEX = 'index.jsonl';

/** Only scene-format files and the project file are journaled (plan §C.4: the History panel). */
export const isJournaledPath = (wirePath: string): boolean =>
  wirePath === 'pix3project.yaml' ||
  wirePath.endsWith('.pix3scene') ||
  wirePath.endsWith('.prefab');

const isEntry = (value: unknown): value is HistoryEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    ID_PATTERN.test(entry.id) &&
    typeof entry.path === 'string' &&
    typeof entry.author === 'string' &&
    AUTHORS.has(entry.author) &&
    typeof entry.at === 'number' &&
    typeof entry.sha256 === 'string' &&
    typeof entry.size === 'number' &&
    (entry.note === undefined || typeof entry.note === 'string')
  );
};

export interface VersionJournalOptions {
  readonly root: string;
  readonly log?: (line: string) => void;
  /** Clock, for retention specs. */
  readonly now?: () => number;
}

export class VersionJournal {
  private readonly dir: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(options: VersionJournalOptions) {
    this.dir = join(options.root, RESERVED_ROOT_DIR, 'history');
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  private pathDir(wirePath: string): string {
    return join(this.dir, ...wirePath.split('/'));
  }

  /** Every readable entry of `wirePath`, oldest first. */
  private async entries(wirePath: string): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.pathDir(wirePath), INDEX), 'utf8');
    } catch (error) {
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') return [];
      throw error;
    }
    const out: HistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isEntry(parsed)) out.push(parsed);
      } catch {
        // a torn line from a crash mid-append; the version it described is simply not listed
      }
    }
    return out;
  }

  /** Newest first. */
  async list(wirePath: string): Promise<HistoryEntry[]> {
    return (await this.entries(wirePath)).reverse();
  }

  async newest(wirePath: string): Promise<HistoryEntry | null> {
    const all = await this.entries(wirePath);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /** The bytes of version `id`, or null when the journal does not know it. */
  async read(wirePath: string, id: string): Promise<Buffer | null> {
    if (!ID_PATTERN.test(id)) return null;
    if (!(await this.entries(wirePath)).some(entry => entry.id === id)) return null;
    try {
      return await readFile(join(this.pathDir(wirePath), id));
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Journal `bytes` as the newest version of `wirePath`. A version equal to the newest one is not
   * recorded again (the watcher's echo of an own write, a restart over an unchanged disk): the
   * newest entry is returned instead.
   */
  async record(
    wirePath: string,
    bytes: Uint8Array,
    author: HistoryAuthor,
    note?: string
  ): Promise<HistoryEntry> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const all = await this.entries(wirePath);
    const last = all.length > 0 ? all[all.length - 1] : null;
    if (last && last.sha256 === sha256) return last;
    const at = this.now();
    const base = `${String(at).padStart(13, '0')}-${sha256.slice(0, 8)}`;
    // A, B, A within one millisecond would reuse an id; ids are unique per path.
    let id = base;
    for (let n = 1; all.some(entry => entry.id === id); n++) id = `${base}-${n}`;
    const dir = this.pathDir(wirePath);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id), bytes);
    const entry: HistoryEntry = {
      id,
      path: wirePath,
      author,
      at,
      sha256,
      size: bytes.byteLength,
      ...(note ? { note } : {}),
    };
    await appendFile(join(dir, INDEX), `${JSON.stringify(entry)}\n`);
    await this.prune(wirePath, [...all, entry]);
    return entry;
  }

  /** Drop what is beyond the newest {@link HISTORY_MAX_VERSIONS} or older than the age limit. */
  private async prune(wirePath: string, all: readonly HistoryEntry[]): Promise<void> {
    const now = this.now();
    const keep: HistoryEntry[] = [];
    const drop: HistoryEntry[] = [];
    all.forEach((entry, index) => {
      const fromNewest = all.length - 1 - index;
      const tooMany = fromNewest >= HISTORY_MAX_VERSIONS;
      const tooOld = fromNewest > 0 && now - entry.at > HISTORY_MAX_AGE_MS;
      (tooMany || tooOld ? drop : keep).push(entry);
    });
    if (drop.length === 0) return;
    const dir = this.pathDir(wirePath);
    // Rewrite the index first (atomically), then delete the bytes: a crash in between leaves
    // unlisted files, never a listed version without bytes.
    const temp = join(dir, `${INDEX}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, keep.map(entry => `${JSON.stringify(entry)}\n`).join(''));
    await rename(temp, join(dir, INDEX));
    for (const entry of drop) await rm(join(dir, entry.id), { force: true });
    this.log(`history: pruned ${drop.length} version(s) of ${wirePath}`);
  }
}

/** `author` of a `POST history/record` body: only the editor's own kind may be posted. */
export const parseRecordAuthor = (raw: unknown): 'rejected-draft' => {
  if (raw !== 'rejected-draft') {
    throw new HttpError(400, 'bad_author', "Only `author: 'rejected-draft'` can be recorded.");
  }
  return raw;
};
