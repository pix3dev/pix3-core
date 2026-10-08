import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { errnoCode, headerValue, HttpError, sendJson } from '../server/http.ts';
import { contentTypeFor } from './content-type.ts';
import { parentOf, parseWirePath, resolveInsideRoot, RESERVED_ROOT_DIR } from './paths.ts';
import {
  applySubtree,
  computeRevision,
  HashCache,
  isExcludedPath,
  mtimeOf,
  scanInto,
  statKeyOf,
  type ChangeEvent,
  type FileEntry,
  type FileTable,
} from './scan.ts';

/**
 * The project's files as the editor sees them (plan §B.1, port of the file half of
 * `packages/cli/src/serve/workspace-server.ts`): a table of every file in the revision set with
 * its sha256, conditional atomic writes, mkdir/delete/move, batch hashing, and the change events
 * the editor tab receives over `/__pix3/ws`.
 *
 * Every table mutation — own writes, watcher batches, scans, the writer hand-over — runs one at a
 * time through {@link serial}; that queue is the mutex plan §C.3/§C.4 put the write path under.
 */

export type ChangeAuthor = 'editor' | 'external';

export interface FsEvent extends ChangeEvent {
  /** `editor` when the bytes are the plugin's last write of that path, else `external`. */
  readonly author: ChangeAuthor;
}

/** One `pix3:fs` frame: every change of one batch, under one `seq`. */
export interface FsFrame {
  readonly type: 'pix3:fs';
  readonly seq: number;
  readonly revision: string;
  readonly events: readonly FsEvent[];
  /** The writer tab that made an `editor` batch through the API. */
  readonly writerId?: string;
}

export interface ProjectFilesOptions {
  /** Absolute project root (Vite's `root`). */
  readonly root: string;
  readonly log?: (line: string) => void;
  /** Called for every batch of changes, own writes included. */
  readonly onChange?: (frame: FsFrame) => void;
  /** Quiet time after the last watch event before a batch is scanned (plan §B.1: 300 ms). */
  readonly stabilityMs?: number;
}

interface MutationOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const MAX_PUT_BYTES = 1024 * 1024 * 1024;
/** Files up to this size are read whole, so the ETag is the hash of exactly the bytes sent. */
const WHOLE_READ_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL = 2_000;
const MAX_HASH_PATHS = 20_000;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const WRITER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Longest a burst of watch events may keep postponing its batch. */
const MAX_BATCH_WAIT_MS = 1_000;
export const STABILITY_INTERVAL_MS = 300;

/** `"<hex>"` → hex; `W/"x"` is treated like `"x"` (weak comparison is enough for a hash). */
const parseEntityTags = (header: string): string[] =>
  header
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.startsWith('W/') ? part.slice(2) : part))
    .map(part =>
      part.startsWith('"') && part.endsWith('"') && part.length >= 2 ? part.slice(1, -1) : part
    );

/** One `bytes=` range; null = serve the whole file (absent, multi-range or unparsable). */
const parseRange = (
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
};

const hashHandle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash('sha256');
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Keep only the outermost paths: a directory's rescan covers everything under it. */
const outermost = (paths: Iterable<string>): string[] => {
  const prefixes: string[] = [];
  for (const path of [...paths].sort()) {
    if (prefixes.some(prefix => prefix === '' || path === prefix || path.startsWith(`${prefix}/`)))
      continue;
    prefixes.push(path);
  }
  return prefixes;
};

export class ProjectFiles {
  readonly root: string;
  private readonly log: (line: string) => void;
  private readonly onChange: (frame: FsFrame) => void;
  private readonly stabilityMs: number;
  private readonly cache = new HashCache();
  private readonly table: FileTable = new Map();
  private readonly journal = new Map<
    string,
    { fingerprint: string; outcome: Promise<MutationOutcome> }
  >();
  /** sha256 of the plugin's last write per path — what makes a change `author: 'editor'`. */
  private readonly ownWrites = new Map<string, string>();
  private seq = 0;
  private revisionMemo: string | null = null;
  private serialTail: Promise<unknown> = Promise.resolve();
  private dirty = new Set<string>();
  private batchTimer: NodeJS.Timeout | null = null;
  private firstDirtyAt = 0;
  private writer: string | null = null;
  private closed = false;

  constructor(options: ProjectFilesOptions) {
    this.root = options.root;
    this.log = options.log ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
    this.stabilityMs = options.stabilityMs ?? STABILITY_INTERVAL_MS;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get writerId(): string | null {
    return this.writer;
  }

  /** sha256 over the sorted `path:sha256` lines of every file (see `computeRevision`). */
  revision(): string {
    this.revisionMemo ??= computeRevision(this.table);
    return this.revisionMemo;
  }

  /** sha256 of a file in the table, or null. */
  hashOf(wirePath: string): string | null {
    return this.table.get(wirePath)?.sha256 ?? null;
  }

  /** Every file of the revision set with its sha256. */
  hashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, entry] of this.table) if (entry.sha256) out[path] = entry.sha256;
    return out;
  }

  async start(): Promise<void> {
    await this.serial(async () => {
      const fresh: FileTable = new Map();
      await scanInto(this.root, '', this.cache, fresh);
      applySubtree(this.table, [''], fresh);
      this.revisionMemo = null;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    await this.serialTail.catch(() => undefined);
  }

  /** Every table mutation (own writes, watcher batches, scans) runs one at a time. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(work, work);
    this.serialTail = run.catch(() => undefined);
    return run;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private authored(events: readonly ChangeEvent[]): FsEvent[] {
    return events.map(event => ({
      ...event,
      author:
        event.kind === 'file' &&
        event.sha256 !== undefined &&
        this.ownWrites.get(event.path) === event.sha256
          ? 'editor'
          : 'external',
    }));
  }

  private emit(events: readonly FsEvent[], writerId?: string): number {
    const seq = this.nextSeq();
    if (events.length === 0) return seq;
    this.onChange({
      type: 'pix3:fs',
      seq,
      revision: this.revision(),
      events,
      ...(writerId ? { writerId } : {}),
    });
    return seq;
  }

  // --- Watcher ---------------------------------------------------------------------------------

  /** A watch event for an absolute path (Vite's `server.watcher`); ignored outside the set. */
  noteFsEvent(absolute: string): void {
    if (this.closed) return;
    const rel = relative(this.root, absolute);
    if (rel.startsWith('..') || rel === '' || /^[A-Za-z]:/.test(rel)) return;
    const wirePath = rel.split(sep).join('/');
    if (isExcludedPath(wirePath)) return;
    if (this.dirty.size === 0) this.firstDirtyAt = Date.now();
    this.dirty.add(wirePath);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    const waited = Date.now() - this.firstDirtyAt;
    const delay = Math.max(0, Math.min(this.stabilityMs, MAX_BATCH_WAIT_MS - waited));
    this.batchTimer = setTimeout(() => void this.flushDirty(), delay);
  }

  private async flushDirty(): Promise<void> {
    this.batchTimer = null;
    const prefixes = outermost(this.dirty);
    this.dirty = new Set();
    try {
      await this.serial(async () => {
        if (this.closed) return;
        const unstable = await this.stableRescan(prefixes);
        for (const path of unstable) this.dirty.add(path);
      });
    } catch (error) {
      this.log(`rescan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.dirty.size > 0 && !this.closed) {
      this.firstDirtyAt = Date.now();
      this.batchTimer = setTimeout(() => void this.flushDirty(), this.stabilityMs);
    }
  }

  /**
   * Plan §B.1 stabilisation: scan, wait {@link stabilityMs}, scan again; a file whose hash differs
   * between the two scans is still being written and stays out of this batch (its old entry is
   * kept, and the caller retries it). Returns the unstable paths.
   */
  private async stableRescan(prefixes: readonly string[]): Promise<string[]> {
    const first: FileTable = new Map();
    for (const prefix of prefixes) await scanInto(this.root, prefix, this.cache, first);
    await sleep(this.stabilityMs);
    const second: FileTable = new Map();
    for (const prefix of prefixes) await scanInto(this.root, prefix, this.cache, second);
    const unstable: string[] = [];
    const paths = new Set([...first.keys(), ...second.keys()]);
    for (const path of paths) {
      const a = first.get(path);
      const b = second.get(path);
      if (a?.kind !== b?.kind || a?.sha256 !== b?.sha256) unstable.push(path);
    }
    if (unstable.length > 0) {
      // Keep what the table already says about unstable paths, so applying `second` neither
      // creates nor deletes them yet.
      const isUnstable = (path: string): boolean => unstable.includes(path);
      for (const path of unstable) second.delete(path);
      for (const [path, entry] of this.table) {
        if (
          isUnstable(path) &&
          prefixes.some(p => p === '' || path === p || path.startsWith(`${p}/`))
        )
          second.set(path, entry);
      }
    }
    const events = applySubtree(this.table, prefixes, second);
    if (events.length > 0) {
      this.revisionMemo = null;
      this.emit(this.authored(events));
    }
    return unstable;
  }

  /**
   * Full rescan now, without stabilisation (plan §B.3 step 1: the agent says it is done). Changes
   * are broadcast like any batch and returned as `{path: sha256 | null}`.
   */
  async rescanAll(): Promise<{ events: FsEvent[]; seq: number }> {
    return this.serial(async () => {
      const fresh: FileTable = new Map();
      await scanInto(this.root, '', this.cache, fresh);
      const events = this.authored(applySubtree(this.table, [''], fresh));
      if (events.length > 0) {
        this.revisionMemo = null;
        this.emit(events);
      }
      return { events, seq: this.seq };
    });
  }

  // --- Writer (plan §C.3) ------------------------------------------------------------------------

  /**
   * `POST /__pix3/api/handover/claim {writerId}` — under the write mutex, so a write the previous
   * writer already had accepted completes first. Returns the disk the new writer starts from.
   */
  async claim(raw: unknown): Promise<Record<string, unknown>> {
    if (typeof raw !== 'string' || !WRITER_ID_PATTERN.test(raw)) {
      throw new HttpError(400, 'bad_writer', '`writerId` must be 1–128 chars of [A-Za-z0-9_.:-].');
    }
    return this.serial(async () => {
      const previous = this.writer;
      this.writer = raw;
      if (previous !== raw) this.log(`writer ${raw}${previous ? ` (was ${previous})` : ''}`);
      return { writerId: raw, seq: this.seq, revision: this.revision(), hashes: this.hashes() };
    });
  }

  /** Mutations are taken only from the current writer (`X-Pix3-Writer`), once one has claimed. */
  private checkWriter(writerId: string | null): void {
    if (this.writer === null || writerId === this.writer) return;
    throw new HttpError(
      409,
      'writer_superseded',
      'Another editor tab took over writing to this project; this tab is read-only now.',
      { writerId: this.writer }
    );
  }

  // --- Routes ------------------------------------------------------------------------------------

  async manifest(): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      // A full scan, not the watcher's view: the manifest is what reconciles missed events.
      const fresh: FileTable = new Map();
      await scanInto(this.root, '', this.cache, fresh);
      const events = this.authored(applySubtree(this.table, [''], fresh));
      if (events.length > 0) {
        this.revisionMemo = null;
        this.emit(events);
      }
      const files = [...this.table.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, entry]) => ({
          path,
          kind: entry.kind,
          size: entry.size,
          mtime: entry.mtime,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        }));
      return { revision: this.revision(), seq: this.seq, files };
    });
  }

  async hashPaths(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = body.paths;
    if (!Array.isArray(raw))
      throw new HttpError(400, 'bad_request', '`paths` must be an array of strings.');
    if (raw.length > MAX_HASH_PATHS)
      throw new HttpError(413, 'too_many_paths', `At most ${MAX_HASH_PATHS} paths.`);
    const paths = raw.map((value, index) => parseWirePath(value, `paths[${index}]`));
    const hashes: Record<string, string | null> = {};
    for (const wirePath of paths) hashes[wirePath] = await this.diskHash(wirePath);
    return { hashes, seq: this.seq };
  }

  /** sha256 of what is on disk at `wirePath` now, or null (missing, a directory, unreachable). */
  async diskHash(wirePath: string): Promise<string | null> {
    let absolute: string;
    try {
      const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
      if (resolved.kind !== 'file') return null;
      absolute = resolved.absolute;
    } catch (error) {
      if (error instanceof HttpError && error.code === 'not_a_directory') return null;
      throw error;
    }
    try {
      return await this.cache.hash(wirePath, absolute, await lstat(absolute, { bigint: true }));
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async readFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    headOnly: boolean
  ): Promise<void> {
    const wirePath = parseWirePath(url.searchParams.get('path') ?? '');
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: false });
    if (resolved.kind !== 'file')
      throw new HttpError(400, 'not_a_file', `${wirePath} is not a file.`);
    const handle = await open(resolved.absolute, 'r');
    let handedOff = false;
    try {
      const stats = await handle.stat({ bigint: true });
      const size = Number(stats.size);
      let whole: Buffer | null = null;
      let sha256: string;
      if (size <= WHOLE_READ_BYTES) {
        whole = await handle.readFile();
        sha256 = createHash('sha256').update(whole).digest('hex');
        this.cache.remember(wirePath, statKeyOf(stats), sha256);
      } else {
        const key = statKeyOf(stats);
        const entry = this.table.get(wirePath);
        sha256 =
          entry && entry.statKey === key && entry.sha256 ? entry.sha256 : await hashHandle(handle);
        this.cache.remember(wirePath, key, sha256);
      }
      const base: Record<string, string> = {
        ETag: `"${sha256}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      const ifNoneMatch = headerValue(req, 'if-none-match');
      if (ifNoneMatch && parseEntityTags(ifNoneMatch).some(tag => tag === '*' || tag === sha256)) {
        res.writeHead(304, base);
        res.end();
        return;
      }
      const range = parseRange(headerValue(req, 'range'), size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, {
        ...base,
        'Content-Type': contentTypeFor(wirePath),
        'Content-Length': String(length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (headOnly || length === 0) {
        res.end();
        return;
      }
      if (whole) {
        res.end(range ? whole.subarray(start, end + 1) : whole);
        return;
      }
      handedOff = true;
      const stream = handle.createReadStream({ start, end, autoClose: true });
      await pipeline(stream, res).catch(() => undefined);
    } finally {
      if (!handedOff) await handle.close();
    }
  }

  // --- Mutations ---------------------------------------------------------------------------------

  private mutationId(req: IncomingMessage): string | null {
    const id = headerValue(req, 'x-mutation-id');
    if (id === null) return null;
    if (!MUTATION_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        'bad_mutation_id',
        'X-Mutation-Id must be 1–128 chars of [A-Za-z0-9_.:-].'
      );
    }
    return id;
  }

  /**
   * Run `work` at most once per mutation id in this dev-server session. A retry of an id already
   * applied (or still in flight) gets the recorded answer and `X-Mutation-Replayed: true`, and
   * `work` does not run again — the rule that keeps a lost response from deleting or moving twice.
   * Reusing an id for a different request is refused (422), not silently replayed.
   */
  private async journaled(
    req: IncomingMessage,
    res: ServerResponse,
    fingerprint: string,
    work: () => Promise<MutationOutcome>
  ): Promise<void> {
    const id = this.mutationId(req);
    const known = id ? this.journal.get(id) : undefined;
    if (id && known) {
      req.resume();
      if (known.fingerprint !== fingerprint) {
        throw new HttpError(
          422,
          'mutation_id_reused',
          'That X-Mutation-Id was used for a different request.'
        );
      }
      const outcome = await known.outcome;
      sendJson(res, outcome.status, outcome.body, { 'X-Mutation-Replayed': 'true' });
      return;
    }
    const outcome = work().catch((error: unknown) => {
      if (!(error instanceof HttpError))
        this.log(`mutation failed: ${error instanceof Error ? error.stack : String(error)}`);
      return error instanceof HttpError
        ? {
            status: error.status,
            body: { error: error.code, message: error.message, ...error.extra },
          }
        : { status: 500, body: { error: 'internal', message: 'Internal error.' } };
    });
    if (id) {
      this.journal.set(id, { fingerprint, outcome });
      if (this.journal.size > MAX_JOURNAL) {
        const oldest = this.journal.keys().next().value;
        if (oldest !== undefined) this.journal.delete(oldest);
      }
    }
    const result = await outcome;
    req.resume();
    sendJson(res, result.status, result.body);
  }

  private async currentHashOf(wirePath: string, absolute: string): Promise<string | null> {
    try {
      const stats = await lstat(absolute, { bigint: true });
      if (!stats.isFile()) return null;
      return await this.cache.hash(wirePath, absolute, stats);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /** Record an own write in the table; the watcher's echo then finds nothing new. */
  private recordOwnFile(wirePath: string, stats: BigIntStats, sha256: string): void {
    this.ownWrites.set(wirePath, sha256);
    if (isExcludedPath(wirePath)) return;
    const entry: FileEntry = {
      kind: 'file',
      size: Number(stats.size),
      mtime: mtimeOf(stats),
      statKey: statKeyOf(stats),
      sha256,
    };
    this.cache.remember(wirePath, entry.statKey, sha256);
    this.table.set(wirePath, entry);
    this.revisionMemo = null;
  }

  /** Make sure every ancestor directory of `wirePath` that now exists is in the table. */
  private async recordAncestors(wirePath: string): Promise<ChangeEvent[]> {
    const parents: string[] = [];
    for (let parent = parentOf(wirePath); parent !== null; parent = parentOf(parent))
      parents.unshift(parent);
    const created: ChangeEvent[] = [];
    for (const parent of parents) {
      if (this.table.has(parent) || isExcludedPath(`${parent}/x`)) continue;
      try {
        const stats = await lstat(join(this.root, ...parent.split('/')), { bigint: true });
        if (!stats.isDirectory()) continue;
        this.table.set(parent, {
          kind: 'dir',
          size: 0,
          mtime: mtimeOf(stats),
          statKey: statKeyOf(stats),
        });
        created.push({ op: 'create', path: parent, kind: 'dir' });
      } catch {
        // raced away; the watcher reports it
      }
    }
    return created;
  }

  async writeFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const wirePath = parseWirePath(url.searchParams.get('path') ?? '');
    const ifMatchRaw = headerValue(req, 'if-match');
    const ifNoneMatchRaw = headerValue(req, 'if-none-match');
    const ifMatch = ifMatchRaw ? parseEntityTags(ifMatchRaw) : null;
    const createOnly = ifNoneMatchRaw !== null && parseEntityTags(ifNoneMatchRaw).includes('*');
    const writerId = headerValue(req, 'x-pix3-writer');
    const fingerprint = `put\n${wirePath}\n${ifMatchRaw ?? ''}\n${ifNoneMatchRaw ?? ''}`;
    await this.journaled(req, res, fingerprint, () =>
      this.performPut(req, wirePath, ifMatch, createOnly, writerId)
    );
  }

  private async performPut(
    req: IncomingMessage,
    wirePath: string,
    ifMatch: string[] | null,
    createOnly: boolean,
    writerId: string | null
  ): Promise<MutationOutcome> {
    const declared = Number(headerValue(req, 'content-length') ?? '0');
    if (declared > MAX_PUT_BYTES) throw new HttpError(413, 'too_large', 'File too large.');
    this.checkWriter(writerId);
    // Validate the target before accepting a body (parents too — a symlinked parent is refused).
    await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
    const tempDir = join(this.root, RESERVED_ROOT_DIR, 'tmp');
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const temp = join(tempDir, `put-${randomBytes(8).toString('hex')}`);
    let tempLive = true;
    try {
      const { sha256, size } = await this.streamBodyTo(req, temp);
      return await this.serial(async () => {
        // Again under the mutex: a hand-over may have landed while the body streamed in.
        this.checkWriter(writerId);
        const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
        if (resolved.kind === 'dir' || resolved.kind === 'other') {
          throw new HttpError(409, 'not_a_file', `${wirePath} exists and is not a file.`);
        }
        const currentHash =
          resolved.kind === 'file' ? await this.currentHashOf(wirePath, resolved.absolute) : null;
        if (createOnly && currentHash !== null) {
          throw new HttpError(412, 'exists', `${wirePath} already exists.`, { currentHash });
        }
        if (ifMatch && !ifMatch.includes('*') && !ifMatch.includes(currentHash ?? '')) {
          throw new HttpError(
            412,
            'base_mismatch',
            `${wirePath} changed since the base you edited.`,
            { currentHash }
          );
        }
        if (ifMatch && ifMatch.includes('*') && currentHash === null) {
          throw new HttpError(412, 'base_mismatch', `${wirePath} does not exist.`, {
            currentHash: null,
          });
        }
        await mkdir(dirname(resolved.absolute), { recursive: true });
        if (resolved.kind === 'file') {
          const previous = await stat(resolved.absolute);
          await chmod(temp, previous.mode & 0o7777);
        }
        await this.renameIntoPlace(temp, resolved.absolute);
        tempLive = false;
        const stats = await lstat(resolved.absolute, { bigint: true });
        const dirs = await this.recordAncestors(wirePath);
        const existed = this.table.has(wirePath);
        const unchanged = existed && this.table.get(wirePath)?.sha256 === sha256;
        this.recordOwnFile(wirePath, stats, sha256);
        const events: FsEvent[] = [
          ...dirs.map(event => ({ ...event, author: 'editor' as const })),
          ...(unchanged
            ? []
            : [
                {
                  op: existed ? ('modify' as const) : ('create' as const),
                  path: wirePath,
                  kind: 'file' as const,
                  sha256,
                  author: 'editor' as const,
                },
              ]),
        ];
        const seq = this.emit(events, writerId ?? undefined);
        return { status: 200, body: { path: wirePath, sha256, size, mtime: mtimeOf(stats), seq } };
      });
    } finally {
      if (tempLive) await rm(temp, { force: true });
    }
  }

  private async renameIntoPlace(temp: string, target: string): Promise<void> {
    try {
      await rename(temp, target);
    } catch (error) {
      if (errnoCode(error) !== 'EXDEV') throw error;
      // `.pix3/tmp` is on another device than the target: stage next to it instead.
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
  }

  private async streamBodyTo(
    req: IncomingMessage,
    temp: string
  ): Promise<{ sha256: string; size: number }> {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_PUT_BYTES) {
          callback(new HttpError(413, 'too_large', 'File too large.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }));
    return { sha256: hash.digest('hex'), size };
  }

  async jsonMutation(
    req: IncomingMessage,
    res: ServerResponse,
    op: 'mkdir' | 'delete' | 'move',
    body: Record<string, unknown>
  ): Promise<void> {
    const writerId = headerValue(req, 'x-pix3-writer');
    if (op === 'mkdir') {
      const wirePath = parseWirePath(body.path);
      await this.journaled(req, res, `mkdir\n${wirePath}`, () =>
        this.serial(() => this.performMkdir(wirePath, writerId))
      );
      return;
    }
    if (op === 'delete') {
      const wirePath = parseWirePath(body.path);
      const recursive = body.recursive === true;
      await this.journaled(req, res, `delete\n${wirePath}\n${recursive}`, () =>
        this.serial(() => this.performDelete(wirePath, recursive, writerId))
      );
      return;
    }
    const from = parseWirePath(body.from, 'from');
    const to = parseWirePath(body.to, 'to');
    const overwrite = body.overwrite === true;
    await this.journaled(req, res, `move\n${from}\n${to}\n${overwrite}`, () =>
      this.serial(() => this.performMove(from, to, overwrite, writerId))
    );
  }

  /** Rescan `prefixes` after an own mutation and broadcast the result as the writer's batch. */
  private async ownRescan(prefixes: readonly string[], writerId: string | null): Promise<number> {
    const fresh: FileTable = new Map();
    for (const prefix of prefixes) await scanInto(this.root, prefix, this.cache, fresh);
    const events = applySubtree(this.table, prefixes, fresh);
    if (events.length > 0) this.revisionMemo = null;
    for (const event of events) {
      if (event.kind === 'file' && event.sha256) this.ownWrites.set(event.path, event.sha256);
    }
    return this.emit(
      events.map(event => ({ ...event, author: 'editor' as const })),
      writerId ?? undefined
    );
  }

  private async performMkdir(wirePath: string, writerId: string | null): Promise<MutationOutcome> {
    this.checkWriter(writerId);
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
    if (resolved.kind === 'dir')
      return { status: 200, body: { path: wirePath, created: false, seq: this.seq } };
    if (resolved.kind !== null)
      throw new HttpError(409, 'exists', `${wirePath} exists and is not a directory.`);
    await mkdir(resolved.absolute, { recursive: true });
    const seq = await this.ownRescan([this.topmostNew(wirePath)], writerId);
    return { status: 200, body: { path: wirePath, created: true, seq } };
  }

  /** The outermost ancestor (or the path itself) the table did not know — what an own write created. */
  private topmostNew(wirePath: string): string {
    let top = wirePath;
    for (let parent = parentOf(wirePath); parent !== null; parent = parentOf(parent)) {
      if (this.table.has(parent)) break;
      top = parent;
    }
    return top;
  }

  private async performDelete(
    wirePath: string,
    recursive: boolean,
    writerId: string | null
  ): Promise<MutationOutcome> {
    this.checkWriter(writerId);
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: false });
    if (resolved.kind === 'dir') {
      if (recursive) {
        await rm(resolved.absolute, { recursive: true });
      } else {
        try {
          await rmdir(resolved.absolute);
        } catch (error) {
          if (errnoCode(error) === 'ENOTEMPTY' || errnoCode(error) === 'EEXIST') {
            throw new HttpError(
              409,
              'not_empty',
              `${wirePath} is not empty; pass recursive: true.`
            );
          }
          throw error;
        }
      }
    } else {
      await unlink(resolved.absolute);
    }
    const seq = await this.ownRescan([wirePath], writerId);
    return {
      status: 200,
      body: { path: wirePath, kind: resolved.kind === 'dir' ? 'dir' : 'file', seq },
    };
  }

  private async performMove(
    from: string,
    to: string,
    overwrite: boolean,
    writerId: string | null
  ): Promise<MutationOutcome> {
    this.checkWriter(writerId);
    if (to === from || to.startsWith(`${from}/`)) {
      throw new HttpError(400, 'bad_move', '`to` must not be `from` or inside it.');
    }
    const source = await resolveInsideRoot(this.root, from, { allowMissing: false });
    const target = await resolveInsideRoot(this.root, to, { allowMissing: true });
    if (target.kind !== null) {
      if (!overwrite) throw new HttpError(409, 'exists', `${to} already exists.`);
      if (target.kind === 'dir' || source.kind === 'dir') {
        throw new HttpError(409, 'exists', `${to} exists; only a file may overwrite a file.`);
      }
    }
    await mkdir(dirname(target.absolute), { recursive: true });
    // rename keeps ino/size/mtime, so seed the hash cache with the new paths: no re-hashing.
    for (const [path, entry] of this.table) {
      if ((path === from || path.startsWith(`${from}/`)) && entry.sha256) {
        this.cache.remember(to + path.slice(from.length), entry.statKey, entry.sha256);
      }
    }
    await rename(source.absolute, target.absolute);
    const seq = await this.ownRescan([from, this.topmostNew(to)], writerId);
    const moved = this.table.get(to);
    return {
      status: 200,
      body: {
        from,
        to,
        kind: source.kind === 'dir' ? 'dir' : 'file',
        ...(moved?.sha256 ? { sha256: moved.sha256 } : {}),
        seq,
      },
    };
  }
}
