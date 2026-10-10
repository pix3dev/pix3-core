import type { FsEvent, ProjectFiles } from '../files/project-files.ts';
import { parseWirePath } from '../files/paths.ts';
import type { EditorSocket, RequestReply } from '../server/editor-socket.ts';
import { HttpError, isRecord } from '../server/http.ts';
import { isGlobbedScript, type ScriptGraph } from './script-graph.ts';

/**
 * The sync barrier (plan §B.3), as S1 found it works:
 *
 * 0. **flush** — the editor writes its dirty scenes. The page's `pix3_sync` flushes itself before
 *    calling `POST /sync`; a caller without a tab (the CLI) gets the flush done here, through the
 *    writer tab (`POST /flush` is the same step on its own);
 * 1. **rescan** — stat + sha256 of the revision set, changes broadcast as `pix3:fs`;
 * 2. **hard-invalidate the roots**, so their `load()` runs again with the new revision;
 * 3. **propagate** every changed file through the client graph (`environment.reloadModule`), and
 *    the roots themselves when a globbed script was added or removed;
 * 4. **page confirmation** — the tab re-imports the roots with `?t=<13 digits>` and answers with the
 *    revision it executed and `globalThis.__pix3Executed`. Sync is ok only when that revision is
 *    current AND every changed module the editor runs carries a stamp equal to the sha on disk;
 *    otherwise `{ok:false, reason:'stale_modules', paths}`.
 *
 * A non-ok answer is not a barrier: on `gesture_in_progress` and `stale_modules` the agent
 * retries; on `expect_mismatch` it re-reads; on `stale` (play is running) it follows `playing`.
 */

export const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
export const VITE_CLIENT_WARNING =
  "/@vite/client is loaded on the editor page, so the game's full-reload can reload the editor: " +
  'a script, a bot policy or a module they import uses import.meta.hot, a CSS import or a ' +
  'non-literal import(). `pix3 check` names the file (W_EDITOR_*).';
const MAX_SYNC_TIMEOUT_MS = 120_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface SyncRequest {
  readonly expect?: Record<string, string>;
  readonly timeoutMs: number;
  /** The tab that asked (the page's `pix3_sync`); it has flushed already. */
  readonly tabId: string | null;
}

export type SyncResult = Record<string, unknown> & { readonly ok: boolean };

export const parseTimeout = (raw: unknown, fallback: number): number => {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new HttpError(400, 'bad_request', '`timeoutMs` must be a non-negative number.');
  }
  return Math.min(raw, MAX_SYNC_TIMEOUT_MS);
};

export const parseSyncRequest = (body: Record<string, unknown>): SyncRequest => {
  let expect: Record<string, string> | undefined;
  if (body.expect !== undefined) {
    if (!isRecord(body.expect)) {
      throw new HttpError(400, 'bad_request', '`expect` must be an object {path: sha256}.');
    }
    expect = {};
    for (const [key, value] of Object.entries(body.expect)) {
      const wirePath = parseWirePath(key, 'expect');
      if (typeof value !== 'string' || !SHA256_HEX.test(value.toLowerCase())) {
        throw new HttpError(400, 'bad_request', `expect["${key}"] must be a hex sha256.`);
      }
      expect[wirePath] = value.toLowerCase();
    }
  }
  const tabId = typeof body.tabId === 'string' ? body.tabId : null;
  return { expect, timeoutMs: parseTimeout(body.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS), tabId };
};

export interface BarrierDeps {
  readonly files: ProjectFiles;
  readonly scripts: ScriptGraph;
  readonly socket: EditorSocket;
  readonly log?: (line: string) => void;
}

export class SyncBarrier {
  private readonly deps: BarrierDeps;
  /** sha already propagated by a sync, per wire path: the watcher's late echo is suppressed. */
  private readonly propagated = new Map<string, string>();
  /** One barrier at a time; a second sync waits for the first. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: BarrierDeps) {
    this.deps = deps;
  }

  /** The tab that answers for the editor: the asker, else the writer, else the oldest tab. */
  private targetTab(asker: string | null): string | null {
    const { socket, files } = this.deps;
    if (asker && socket.hasTab(asker)) return asker;
    const writer = files.writerId;
    if (writer && socket.hasTab(writer)) return writer;
    return socket.tabs()[0]?.tabId ?? null;
  }

  /**
   * Step 0 on its own (`POST /__pix3/api/flush`, and `npm run build` / `pix3 check` before they
   * read the disk): the writer tab writes its dirty scenes. No writer tab = nothing unsaved here.
   */
  async flush(timeoutMs: number): Promise<SyncResult> {
    const { socket, files } = this.deps;
    const writer = files.writerId;
    if (!writer || !socket.hasTab(writer)) {
      return { ok: true, editor: socket.tabs().length > 0, flushed: false };
    }
    const reply = await socket.request(writer, 'flush', { timeoutMs }, timeoutMs + 1_000);
    return { ...reply, editor: true, flushed: reply.ok };
  }

  sync(request: SyncRequest): Promise<SyncResult> {
    const run = this.tail.then(
      () => this.run(request),
      () => this.run(request)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(request: SyncRequest): Promise<SyncResult> {
    const { files, scripts, socket } = this.deps;
    const started = Date.now();
    if (request.tabId === null) {
      const flushed = await this.flush(request.timeoutMs);
      if (!flushed.ok) return { ...flushed, ok: false, step: 'flush' };
    }

    // 1. rescan
    const { events, seq } = await files.rescanAll();
    const changedFiles = events.filter(event => event.kind === 'file');
    const changed: Record<string, string | null> = {};
    for (const event of changedFiles) {
      changed[event.path] = event.op === 'delete' ? null : (event.sha256 ?? null);
      if (event.op === 'rename' && event.from) changed[event.from] = null;
    }
    const expectMismatch: Record<string, unknown>[] = [];
    for (const [path, expected] of Object.entries(request.expect ?? {})) {
      const actual = files.hashOf(path);
      if (actual !== expected) expectMismatch.push({ path, expected, actual });
    }

    // 2–3. hard-invalidate the roots, propagate
    scripts.hardInvalidateRoots();
    let rootsNeedReload = false;
    for (const event of changedFiles) {
      if (
        event.op !== 'modify' &&
        (isGlobbedScript(event.path) || isGlobbedScript(event.from ?? ''))
      )
        rootsNeedReload = true;
      if (event.op === 'delete' || !event.sha256) continue;
      this.propagated.set(event.path, event.sha256);
      await scripts.reload(event.path);
    }
    if (rootsNeedReload) await scripts.reloadRoots();
    const required = this.requiredStamps(changedFiles);

    const base = {
      rev: seq,
      seq,
      changed,
      expectMismatch,
      ...(expectMismatch.length > 0 ? { reason: 'expect_mismatch' } : {}),
    };

    // 4. page confirmation
    const tabId = this.targetTab(request.tabId);
    if (tabId === null) {
      return { ok: expectMismatch.length === 0, ...base, editor: false, ms: Date.now() - started };
    }
    const remaining = Math.max(0, request.timeoutMs - (Date.now() - started));
    const reply = await socket.request(
      tabId,
      'sync',
      // `policyOnly`: modules only bot policies import — applied during play like a policy (S11).
      { rev: seq, changed, paths: Object.keys(changed), policyOnly: scripts.policyOnlyModules() },
      remaining
    );
    const verdict = this.judge(reply, seq, required);
    return {
      ...base,
      ...verdict,
      ok: verdict.ok && expectMismatch.length === 0,
      ...(verdict.ok && expectMismatch.length > 0 ? { reason: 'expect_mismatch' } : {}),
      editor: true,
      tabId,
      // Contract B broken: the page found /@vite/client loaded (plan §B.2).
      ...(reply.viteClient === true ? { viteClient: true, warning: VITE_CLIENT_WARNING } : {}),
      ms: Date.now() - started,
    };
  }

  /** Changed files the editor executes, with the sha their stamp must carry. */
  private requiredStamps(events: readonly FsEvent[]): Map<string, string> {
    const required = new Map<string, string>();
    for (const event of events) {
      if (event.op === 'delete' || !event.sha256) continue;
      if (this.deps.scripts.isEditorModule(event.path)) required.set(event.path, event.sha256);
    }
    return required;
  }

  private judge(reply: RequestReply, rev: number, required: Map<string, string>): SyncResult {
    if (!reply.ok) {
      // `executed` is every stamp on the page (hundreds of modules): proof for the judge, noise
      // in an answer the agent reads.
      const { ok: _ok, executed: _executed, ...rest } = reply;
      return {
        ok: false,
        reason: typeof reply.reason === 'string' ? reply.reason : 'refused',
        ...rest,
      };
    }
    const executed = isRecord(reply.executed) ? reply.executed : {};
    const ackRev = typeof reply.rev === 'number' ? reply.rev : -1;
    const stale: string[] = [];
    for (const [path, sha] of required) if (executed[path] !== sha) stale.push(path);
    if (ackRev < rev || stale.length > 0) {
      return { ok: false, reason: 'stale_modules', paths: stale, ackRev };
    }
    return { ok: true };
  }

  /**
   * `handleHotUpdate` for a file a sync already propagated with the same bytes: the watcher's
   * late echo would otherwise propagate a second time (S1: chokidar repeats `change`).
   */
  alreadyPropagated(wirePath: string, sha: string | null): boolean {
    return sha !== null && this.propagated.get(wirePath) === sha;
  }

  notePropagated(wirePath: string, sha: string | null): void {
    if (sha === null) this.propagated.delete(wirePath);
    else this.propagated.set(wirePath, sha);
  }
}
