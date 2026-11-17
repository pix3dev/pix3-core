import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { readTextOrNull, writeAtomic } from '../fs-util.ts';
import {
  MODEL_JOB_FORMAT,
  MODEL_JOBS_DIR,
  parseModelFeedback,
  parseModelJob,
  type ModelFeedback,
  type ModelJob,
  type ModelJobIndex,
  type ModelJobWait,
  type ModelPass,
} from './types.ts';

/**
 * Reading and writing `.pix3/model-jobs/` (plan "Запись CLI"): every read-modify-write of
 * `job.json` + `index.json` runs under one directory lock, `.lock` (created with `wx`; holds the
 * pid and the time; a lock older than 30 s whose pid is dead is taken over). A pass publishes its
 * immutable `sheet.png` + `report.json` first, then `job.json`, then `index.json` — each through a
 * temp file and a rename. `index.json` is derived: rebuilt from every `job.json` on each write.
 */

export const jobsDir = (root: string): string => join(root, ...MODEL_JOBS_DIR.split('/'));
export const jobDir = (root: string, id: string): string => join(jobsDir(root), id);

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A `wait` whose process still runs and whose time has not run out. */
export const isWaitAlive = (wait: ModelJobWait | null, now: Date): boolean =>
  wait !== null && Date.parse(wait.expiresAt) > now.getTime() && isPidAlive(wait.pid);

/** Whether the lock is older than 30 s and its holder is dead (false when it is gone). */
const isStale = (lock: string): boolean => {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  if (age < LOCK_STALE_MS) return false;
  const pid = Number(/"pid":\s*(\d+)/.exec(readTextOrNull(lock) ?? '')?.[1]);
  return !(pid > 0 && isPidAlive(pid));
};

/**
 * Remove a dead holder's lock: one contender at a time (`.lock.break`, created with `wx`), and
 * checked again inside, so a fresh lock someone took meanwhile is never removed.
 */
const breakStaleLock = (lock: string): void => {
  const guard = `${lock}.break`;
  try {
    closeSync(openSync(guard, 'wx'));
  } catch {
    // Another contender is breaking it; a guard a crash left behind goes after 30 s.
    if (isStale(guard)) rmSync(guard, { force: true });
    return;
  }
  try {
    if (isStale(lock)) rmSync(lock, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
};

/** Run `body` holding `.pix3/model-jobs/.lock` (waits up to 10 s for it). */
export const withJobsLock = async <T>(root: string, body: () => T | Promise<T>): Promise<T> => {
  const dir = jobsDir(root);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  for (const deadline = Date.now() + LOCK_WAIT_MS; ; ) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      breakStaleLock(lock);
      if (Date.now() > deadline)
        throw new Error(`${MODEL_JOBS_DIR}/.lock is held by another pix3 process (waited 10 s)`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await body();
  } finally {
    rmSync(lock, { force: true });
  }
};

/** The job, or why it cannot be read (missing, broken JSON, a field the validator refuses). */
export const readJob = (root: string, id: string): ModelJob | { readonly error: string } => {
  const text = readTextOrNull(join(jobDir(root, id), 'job.json'));
  if (text === null) return { error: `no model job "${id}" (pix3 model list)` };
  const job = parseModelJob(text);
  if ('error' in job) return { error: `${MODEL_JOBS_DIR}/${id}/job.json: ${job.error}` };
  if (job.id !== id) return { error: `${MODEL_JOBS_DIR}/${id}/job.json names the job "${job.id}"` };
  return job;
};

/** Every readable job, by id; the unreadable ones as problems. */
export const readJobs = (root: string): { jobs: ModelJob[]; problems: string[] } => {
  const jobs: ModelJob[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(jobsDir(root), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    // no jobs yet
  }
  for (const name of names) {
    const job = readJob(root, name);
    if ('error' in job) problems.push(job.error);
    else jobs.push(job);
  }
  return { jobs, problems };
};

const buildIndex = (jobs: readonly ModelJob[]): ModelJobIndex => ({
  v: MODEL_JOB_FORMAT,
  jobs: jobs.map(job => ({
    id: job.id,
    title: job.title,
    status: job.status,
    target: job.target,
    passes: job.passes.length,
    stage: job.passes.at(-1)?.stage ?? null,
    updatedAt: job.updatedAt,
    wait: job.wait,
  })),
});

/** Rewrite `index.json` from every `job.json` (call under the lock), only when it differs. */
export const rebuildIndex = (root: string): void => {
  const text = `${JSON.stringify(buildIndex(readJobs(root).jobs), null, 2)}\n`;
  const file = join(jobsDir(root), 'index.json');
  if (readTextOrNull(file) !== text) writeAtomic(file, text);
};

/** Publish `job.json`, then `index.json` (under the lock). */
export const writeJob = (root: string, job: ModelJob): void => {
  writeAtomic(join(jobDir(root, job.id), 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  rebuildIndex(root);
};

/** Read, change and publish one job under the lock; `change` may refuse with `{ error }`. */
export const updateJob = (
  root: string,
  id: string,
  change: (job: ModelJob) => ModelJob | { readonly error: string }
): Promise<ModelJob | { readonly error: string }> =>
  withJobsLock(root, () => {
    const job = readJob(root, id);
    if ('error' in job) return job;
    const next = change(job);
    if ('error' in next) return next;
    writeJob(root, next);
    return next;
  });

/** The well-formed lines of `feedback.jsonl` (first of a repeated id wins), and the rest counted. */
export const readFeedback = (
  root: string,
  id: string
): { entries: ModelFeedback[]; broken: number } => {
  const text = readTextOrNull(join(jobDir(root, id), 'feedback.jsonl')) ?? '';
  const entries: ModelFeedback[] = [];
  let broken = 0;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseModelFeedback(line);
    if ('error' in entry) broken += 1;
    else if (!seen.has(entry.id)) {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return { entries, broken };
};

export const undelivered = (job: ModelJob, entries: readonly ModelFeedback[]): ModelFeedback[] =>
  entries.filter(entry => job.feedback[entry.id] === undefined);

/** The line `pix3 render --job` and `pix3 model next` end with when the human said something new. */
export const newFeedbackLine = (root: string, job: ModelJob): string => {
  const count = undelivered(job, readFeedback(root, job.id).entries).length;
  return count ? `${count} new feedback — pix3 model feedback ${job.id}\n` : '';
};

// --- stages --------------------------------------------------------------------------------------

/** The stages a next pass may take: the first; or the current one again and the one after it. */
export const allowedStages = (job: ModelJob): string[] => {
  const last = job.passes.at(-1);
  if (!last) return [job.stages[0]];
  const next = job.stages[job.stages.indexOf(last.stage) + 1];
  return next ? [last.stage, next] : [last.stage];
};

/** Whether a pass of `stage` may come next; `force` (a reason) bypasses the order, not the list. */
export const checkTransition = (
  job: ModelJob,
  stage: string,
  force: string | undefined
): { readonly forced: string | null } | { readonly error: string } => {
  if (job.status !== 'running')
    return { error: `the job "${job.id}" is ${job.status}; start another with pix3 model new` };
  if (!job.stages.includes(stage))
    return { error: `"${stage}" is not a stage of "${job.id}" (${job.stages.join(', ')})` };
  const allowed = allowedStages(job);
  if (allowed.includes(stage)) return { forced: null };
  if (force) return { forced: force };
  const last = job.passes.at(-1);
  const at = job.stages.indexOf(stage);
  const from = last ? job.stages.indexOf(last.stage) : -1;
  const missing = job.stages.slice(from + 1, at);
  return {
    error:
      at < from
        ? `"${stage}" comes before the current stage "${last!.stage}"`
        : `"${stage}" skips ${missing.map(s => `"${s}"`).join(', ')}, ${missing.length > 1 ? 'which have' : 'which has'} no pass yet`,
  };
};

/** What one pass adds; the sheet and report bytes are written before the job names them. */
export interface PassInput {
  readonly stage: string;
  readonly note: string | null;
  readonly force?: string;
  readonly params: ModelPass['params'];
  readonly sheetViews: readonly string[];
  readonly cols: number;
  readonly metrics: ModelPass['metrics'];
  readonly sheetPng: Uint8Array;
  readonly report: object;
  readonly now: Date;
}

/**
 * Record a rendered pass under the lock: the transition is checked again (a pass may have landed
 * since the render began), the pass folder is created fresh, and every delivered, unaddressed
 * feedback entry is marked addressed by this pass.
 */
export const recordPass = (
  root: string,
  id: string,
  input: PassInput
): Promise<{ readonly job: ModelJob; readonly pass: ModelPass } | { readonly error: string }> =>
  withJobsLock(root, () => {
    const job = readJob(root, id);
    if ('error' in job) return job;
    const transition = checkTransition(job, input.stage, input.force);
    if ('error' in transition) return transition;
    const seq = (job.passes.at(-1)?.seq ?? 0) + 1;
    const folder = `passes/${String(seq).padStart(2, '0')}-${input.stage}`;
    const absolute = join(jobDir(root, id), ...folder.split('/'));
    rmSync(absolute, { recursive: true, force: true }); // only a crashed run's leftovers: seq is new
    mkdirSync(absolute, { recursive: true });
    writeAtomic(join(absolute, 'sheet.png'), input.sheetPng);
    writeAtomic(join(absolute, 'report.json'), `${JSON.stringify(input.report, null, 2)}\n`);
    const at = input.now.toISOString();
    const pass: ModelPass = {
      seq,
      stage: input.stage,
      at,
      note: input.note,
      forced: transition.forced,
      params: input.params,
      sheet: {
        file: `${folder}/sheet.png`,
        views: input.sheetViews,
        tile: input.params.size,
        cols: input.cols,
      },
      report: `${folder}/report.json`,
      metrics: input.metrics,
    };
    const feedback = Object.fromEntries(
      Object.entries(job.feedback).map(([fid, state]) => [
        fid,
        state.addressedBy === null ? { ...state, addressedBy: seq } : state,
      ])
    );
    const next: ModelJob = { ...job, updatedAt: at, feedback, passes: [...job.passes, pass] };
    writeJob(root, next);
    return { job: next, pass };
  });

/** What a pass keeps of `model-look.ts`'s `LookStats` (the Node half cannot import the runtime). */
interface LookNumbers {
  readonly luminance?: { readonly p50: number };
  readonly nearBlack?: number;
  readonly saturation?: { readonly median: number };
}

/** … and of its `ReferenceReport`: a failed mask, or a comparison that may itself have failed. */
type ReferenceNumbers =
  | { readonly mask: { readonly error: string } }
  | {
      readonly mask: object;
      readonly comparison:
        | { readonly error: string }
        | { readonly silhouetteIoU: number; readonly saturationRatio: number | null };
    };

/**
 * The pass's metrics, copied from the render report (`look`, `reference`) under `model-look.ts`'s
 * names: a failed reference mask or comparison is `notCompared: "<reason>"`, never a zero.
 */
export const passMetrics = (
  info: { readonly triangles: number; readonly drawCalls: number },
  lookStats: object,
  referenceReport: object | undefined
): ModelPass['metrics'] => {
  const look = lookStats as LookNumbers;
  const reference = referenceReport as ReferenceNumbers | undefined;
  const comparison = reference && 'comparison' in reference ? reference.comparison : undefined;
  const compared = comparison && !('error' in comparison) ? comparison : undefined;
  return {
    ...(look.luminance && { luminanceP50: look.luminance.p50 }),
    ...(look.nearBlack !== undefined && { nearBlack: look.nearBlack }),
    ...(look.saturation && { saturationMedian: look.saturation.median }),
    ...(compared && {
      silhouetteIoU: compared.silhouetteIoU,
      saturationRatio: compared.saturationRatio,
    }),
    triangles: info.triangles,
    drawCalls: info.drawCalls,
    notCompared: !reference
      ? null
      : !('comparison' in reference)
        ? `mask: ${reference.mask.error}`
        : comparison && 'error' in comparison
          ? comparison.error
          : null,
  };
};

/** The sheet's columns for `tiles` tiles — `renderModelSheet`'s layout (`model-sheet.ts`). */
export const sheetColumns = (tiles: number): number => (tiles > 1 ? 2 : 1);
