import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { sha256Hex } from '../fs-util.ts';
import type { CliIo } from '../io.ts';
import { resolveProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';
import {
  allowedStages,
  isWaitAlive,
  jobDir,
  readFeedback,
  readJob,
  readJobs,
  rebuildIndex,
  undelivered,
  updateJob,
  withJobsLock,
  writeJob,
} from './store.ts';
import {
  DEFAULT_MODEL_STAGES,
  MODEL_JOB_FORMAT,
  MODEL_JOB_ID,
  MODEL_JOBS_DIR,
  type ModelFeedback,
  type ModelFeedbackMark,
  type ModelJob,
} from './types.ts';

/**
 * `pix3 model …` — the journal of one model the coding agent builds (plan `.plans/model-jobs.md`):
 * `new` opens a job on a scene or prefab (with a reference), `pix3 render --job` adds passes,
 * `feedback` hands over what the human said in the editor's 3D Asset Generator panel, `next` says
 * where the job stands, `done` closes it. Everything lives in `.pix3/model-jobs/`; no dev server.
 */

export interface ModelIo extends CliIo {
  readonly now?: () => Date;
}

const VALUE_FLAGS = new Set([
  '--target',
  '--node',
  '--reference',
  '--reference-background',
  '--title',
  '--stages',
  '--views',
  '--size',
  '--timeout',
  '--failed',
  '--project',
]);
const BOOLEAN_FLAGS = new Set(['--wait', '--json', '--force']);
const SUBCOMMANDS = ['new', 'feedback', 'next', 'done', 'list', 'rm'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface ModelArgs {
  readonly sub: Subcommand;
  readonly id?: string;
  readonly flags: ReadonlyMap<string, string>;
}

export const parseModelArgs = (argv: readonly string[]): ModelArgs | { error: string } => {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]];
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return { error: `${flag} needs a value` };
      flags.set(flag, value);
    } else if (BOOLEAN_FLAGS.has(flag)) flags.set(flag, '');
    else if (flag.startsWith('-')) return { error: `unknown argument ${argv[i]}` };
    else positionals.push(flag);
  }
  const [sub, id, extra] = positionals;
  if (!SUBCOMMANDS.includes(sub as Subcommand))
    return {
      error: sub ? `no subcommand "${sub}" (${SUBCOMMANDS.join(', ')})` : 'name a subcommand',
    };
  if (extra !== undefined) return { error: `one job at a time (got ${id} and ${extra})` };
  if (sub !== 'list') {
    if (id === undefined) return { error: `pix3 model ${sub} needs the job id` };
    if (!MODEL_JOB_ID.test(id))
      return { error: `the job id is [a-z0-9-], at most 64 characters, not "${id}"` };
  }
  return { sub: sub as Subcommand, id, flags };
};

const toRes = (root: string, file: string): string =>
  `res://${relative(root, file).split(sep).join('/')}`;
const projectPath = (root: string, id: string, file: string): string =>
  relative(root, join(jobDir(root, id), ...file.split('/')))
    .split(sep)
    .join('/');

// --- feedback in words ---------------------------------------------------------------------------

const place = (x: number, y: number): string =>
  `${y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'middle'} ${x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center'}`;

/** `front: rect, top right` — the position inside the mark's own tile when the sheet is known. */
export const describeMark = (
  mark: ModelFeedbackMark,
  job: ModelJob,
  pass: number | null
): string => {
  const found = job.passes.find(p => p.seq === pass)?.sheet;
  const index = found ? found.views.indexOf(mark.view) : -1;
  const sheet = index >= 0 ? found : undefined; // the mark's tile is known
  const tile = Math.max(index, 0); // else 0: coordinates of the whole sheet
  const cols = sheet?.cols ?? 1;
  const rows = sheet ? Math.ceil(sheet.views.length / cols) : 1;
  const local = (x: number, y: number): [number, number] => [
    x * cols - (tile % cols),
    y * rows - Math.floor(tile / cols),
  ];
  const of = sheet ? '' : ' of the sheet';
  if (mark.shape === 'point') return `${mark.view}: point, ${place(...local(...mark.point))}${of}`;
  if (mark.shape === 'rect') {
    const [x, y, w, h] = mark.rect;
    const [cx, cy] = local(x + w / 2, y + h / 2);
    const area = `${Math.round(w * cols * 100)}%×${Math.round(h * rows * 100)}%`;
    return `${mark.view}: rect ${area}, ${place(cx, cy)}${of}`;
  }
  if (mark.shape === 'arrow')
    return `${mark.view}: arrow from ${place(...local(...mark.from))} pointing at ${place(...local(...mark.to))}${of}`;
  const first = local(...mark.path[0]);
  const last = local(...mark.path[mark.path.length - 1]);
  return `${mark.view}: stroke, ${place(...first)} → ${place(...last)}${of}`;
};

const VERDICT = { accept: 'accepted', changes: 'needs changes' } as const;

const describeFeedback = (root: string, job: ModelJob, entry: ModelFeedback): string => {
  const stage = job.passes.find(p => p.seq === entry.pass)?.stage;
  const lines = [
    `${entry.id} · ${entry.pass === null ? 'before the first pass' : `pass ${entry.pass}${stage ? ` (${stage})` : ''}`}` +
      (entry.verdict ? ` · verdict: ${VERDICT[entry.verdict]}` : ''),
  ];
  if (entry.text.trim()) lines.push(`  "${entry.text.trim()}"`);
  if (entry.marks.length)
    lines.push(`  marks: ${entry.marks.map(m => describeMark(m, job, entry.pass)).join('; ')}`);
  if (entry.image) {
    const path = projectPath(root, job.id, entry.image);
    lines.push(
      existsSync(join(root, ...path.split('/')))
        ? `  marked sheet: ${path} — Read it`
        : `  marked sheet: ${path} (missing)`
    );
  }
  return `${lines.join('\n')}\n`;
};

// --- subcommands ---------------------------------------------------------------------------------

type Run = (args: ModelArgs, root: string, io: ModelIo, now: () => Date) => Promise<number>;

const runNew: Run = async (args, root, io, now) => {
  const id = args.id!;
  const target = args.flags.get('--target');
  if (!target) return usageError(io, 'pix3 model new needs --target <scene|prefab>');
  const targetFile = target.startsWith('res://')
    ? join(root, target.slice(6))
    : resolve(io.cwd, target);
  const inside = relative(root, targetFile);
  if (
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    !existsSync(targetFile) ||
    !statSync(targetFile).isFile()
  )
    return usageError(io, `--target ${target}: no such scene or prefab in the project`);
  const reference = args.flags.get('--reference');
  const referenceFile = reference === undefined ? undefined : resolve(io.cwd, reference);
  const ext = referenceFile ? extname(referenceFile).toLowerCase() : '';
  if (referenceFile && !(existsSync(referenceFile) && statSync(referenceFile).isFile()))
    return usageError(io, `the reference ${referenceFile} is not a file`);
  if (referenceFile && !['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
    return usageError(io, '--reference takes a .png, .jpg or .webp image');
  const referenceBackground = args.flags.get('--reference-background') ?? null;
  if (referenceBackground !== null && !referenceFile)
    return usageError(io, '--reference-background needs --reference');
  if (referenceBackground !== null && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(referenceBackground))
    return usageError(io, '--reference-background takes a hex colour like #ffffff');
  const stages = (args.flags.get('--stages')?.split(',') ?? [...DEFAULT_MODEL_STAGES]).map(s =>
    s.trim()
  );
  if (stages.some(s => !MODEL_JOB_ID.test(s)) || new Set(stages).size !== stages.length)
    return usageError(io, '--stages takes unique [a-z0-9-] names, comma-separated');
  const size = Number(args.flags.get('--size') ?? 512);
  if (!Number.isInteger(size) || size < 64 || size > 2048)
    return usageError(io, '--size takes a tile size in px, 64–2048');
  const created = await withJobsLock(root, () => {
    const dir = jobDir(root, id);
    if (existsSync(dir)) return { error: `the job "${id}" exists (pix3 model rm ${id} first)` };
    mkdirSync(dir, { recursive: true });
    const at = now().toISOString();
    const copied = referenceFile ? `reference${ext}` : null;
    const job: ModelJob = {
      v: MODEL_JOB_FORMAT,
      id,
      title: args.flags.get('--title') ?? id,
      status: 'running',
      target: toRes(root, targetFile),
      node: args.flags.get('--node') ?? null,
      reference: copied,
      referenceSha256: referenceFile ? sha256Hex(readFileSync(referenceFile)) : null,
      referenceBackground,
      views: args.flags.get('--views') ?? 'iso,front,right,top',
      size,
      stages,
      createdAt: at,
      updatedAt: at,
      result: null,
      wait: null,
      feedback: {},
      passes: [],
    };
    try {
      if (referenceFile) copyFileSync(referenceFile, join(dir, copied!));
      writeJob(root, job);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true }); // no half-made job that blocks the id
      throw error;
    }
    return job;
  });
  if ('error' in created) return refuse(io, created.error);
  if (args.flags.has('--json')) io.stdout(`${JSON.stringify(created, null, 2)}\n`);
  else
    io.stdout(
      `Created ${MODEL_JOBS_DIR}/${id}: ${created.target}${created.node ? ` #${created.node}` : ''}` +
        `${created.reference ? `, reference ${reference}` : ''}\n` +
        `  stages: ${stages.join(' → ')}\n` +
        `  next: pix3 render --job ${id} --stage ${stages[0]} --note "<what this pass does>"\n`
    );
  return 0;
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const runFeedback: Run = async (args, root, io, now) => {
  const id = args.id!;
  const json = args.flags.has('--json');
  const timeout = Number(args.flags.get('--timeout') ?? 540);
  if (!(timeout > 0 && timeout <= 86_400))
    return usageError(io, '--timeout takes seconds, up to a day');
  let job = readJob(root, id);
  if ('error' in job) return refuse(io, job.error);
  let read = readFeedback(root, id);
  let fresh = undelivered(job, read.entries);
  let timedOut = false;
  if (fresh.length === 0 && args.flags.has('--wait')) {
    const since = now();
    const wait = {
      pid: process.pid,
      since: since.toISOString(),
      expiresAt: new Date(since.getTime() + timeout * 1000).toISOString(),
    };
    const set = await updateJob(root, id, j => ({ ...j, wait }));
    if ('error' in set) return refuse(io, set.error);
    // Only our own wait is removed (a later `--wait` may have replaced it); the error just skips the write.
    const clear = () =>
      updateJob(root, id, j =>
        j.wait?.pid === wait.pid && j.wait.since === wait.since
          ? { ...j, wait: null }
          : { error: 'not ours' }
      );
    const onSigint = () => void clear().finally(() => process.exit(130));
    process.once('SIGINT', onSigint);
    try {
      for (const deadline = Date.now() + timeout * 1000; ; ) {
        read = readFeedback(root, id);
        fresh = undelivered(job, read.entries);
        if (fresh.length > 0) break;
        const left = deadline - Date.now();
        if (left <= 0) {
          timedOut = true;
          break;
        }
        await sleep(Math.min(1000, left));
      }
    } finally {
      process.removeListener('SIGINT', onSigint);
      await clear();
    }
  }
  if (fresh.length > 0) {
    // Claimed under the lock against the job as it is now: a concurrent reader gets the rest.
    const deliveredAt = now().toISOString();
    const delivered = await updateJob(root, id, j => {
      fresh = undelivered(j, fresh);
      const feedback = { ...j.feedback };
      for (const entry of fresh) feedback[entry.id] = { deliveredAt, addressedBy: null };
      return { ...j, feedback };
    });
    if ('error' in delivered) return refuse(io, delivered.error);
    job = delivered;
  }
  const { broken } = read;
  if (json) {
    io.stdout(
      `${JSON.stringify(
        {
          job: id,
          timedOut,
          broken,
          feedback: fresh.map(entry => ({
            ...entry,
            ...(entry.image && { image: projectPath(root, id, entry.image) }),
            described: entry.marks.map(m => describeMark(m, job as ModelJob, entry.pass)),
          })),
        },
        null,
        2
      )}\n`
    );
    return 0;
  }
  if (fresh.length === 0)
    io.stdout(timedOut ? `No feedback yet (waited ${timeout} s).\n` : 'No new feedback.\n');
  for (const entry of fresh) io.stdout(describeFeedback(root, job, entry));
  if (fresh.length > 0)
    io.stdout(`Delivered ${fresh.length}; the next pix3 render --job ${id} marks it addressed.\n`);
  if (broken) io.stdout(`(${broken} unreadable line(s) in feedback.jsonl skipped)\n`);
  return 0;
};

const runNext: Run = async (args, root, io) => {
  const job = readJob(root, args.id!);
  if ('error' in job) return refuse(io, job.error);
  const entries = readFeedback(root, job.id).entries;
  const fresh = undelivered(job, entries);
  const verdict = entries.filter(e => e.verdict !== null).at(-1);
  const last = job.passes.at(-1);
  const allowed = job.status === 'running' ? allowedStages(job) : [];
  const doneReady = last?.stage === job.stages.at(-1) && fresh.length === 0;
  if (args.flags.has('--json')) {
    io.stdout(
      `${JSON.stringify(
        {
          job: job.id,
          status: job.status,
          stage: last?.stage ?? null,
          passes: job.passes.length,
          allowed,
          undelivered: fresh.length,
          verdict: verdict
            ? { id: verdict.id, pass: verdict.pass, verdict: verdict.verdict }
            : null,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }
  const count = (stage: string) => job.passes.filter(p => p.stage === stage).length;
  io.stdout(
    `${job.id} — ${job.status}${job.result ? ` (${job.result})` : ''}, ${job.target}${job.node ? ` #${job.node}` : ''}\n` +
      `  stages: ${job.stages.map(s => (s === last?.stage ? `[${s} ×${count(s)}]` : count(s) ? `${s} ×${count(s)}` : s)).join(' → ')}\n` +
      (verdict
        ? `  last verdict: ${VERDICT[verdict.verdict!]} (pass ${verdict.pass ?? '–'})\n`
        : '') +
      (job.status !== 'running'
        ? ''
        : `  next: ${allowed.map(s => `pix3 render --job ${job.id} --stage ${s}`).join('  |  ')}\n` +
          (doneReady ? `  or: pix3 model done ${job.id}\n` : '')) +
      (fresh.length ? `${fresh.length} new feedback — pix3 model feedback ${job.id}\n` : '')
  );
  return 0;
};

const runDone: Run = async (args, root, io, now) => {
  const failed = args.flags.get('--failed');
  const force = args.flags.has('--force');
  const result = await updateJob(root, args.id!, job => {
    if (job.status !== 'running') return { error: `the job "${job.id}" is already ${job.status}` };
    const at = now().toISOString();
    if (failed !== undefined)
      return { ...job, status: 'failed', result: failed || 'failed', updatedAt: at };
    const fresh = undelivered(job, readFeedback(root, job.id).entries).length;
    const lastStage = job.stages.at(-1)!;
    const missing = [
      ...(fresh ? [`${fresh} undelivered feedback (pix3 model feedback ${job.id})`] : []),
      ...(job.passes.some(p => p.stage === lastStage) ? [] : [`no "${lastStage}" pass`]),
    ];
    if (missing.length && !force) return { error: `not done: ${missing.join('; ')} — or --force` };
    return {
      ...job,
      status: 'done',
      result: missing.length ? `forced: ${missing.join('; ')}` : null,
      updatedAt: at,
    };
  });
  if ('error' in result) return refuse(io, result.error);
  io.stdout(`${result.id}: ${result.status}${result.result ? ` (${result.result})` : ''}\n`);
  return 0;
};

const runList: Run = async (args, root, io, now) => {
  const { jobs, problems } = readJobs(root);
  if (args.flags.has('--json')) io.stdout(`${JSON.stringify({ jobs, problems }, null, 2)}\n`);
  else {
    if (!jobs.length && !problems.length) io.stdout(`No model jobs (${MODEL_JOBS_DIR}).\n`);
    for (const job of jobs)
      io.stdout(
        `${job.id.padEnd(20)} ${job.status.padEnd(8)} ${String(job.passes.length).padStart(2)} pass(es)` +
          `${job.passes.length ? ` (${job.passes.at(-1)!.stage})` : ''}` +
          `${isWaitAlive(job.wait, now()) ? ' · waiting for you' : ''}  ${job.target}\n`
      );
    for (const problem of problems) io.stdout(`unreadable: ${problem}\n`);
  }
  return 0;
};

const runRm: Run = async (args, root, io, now) => {
  const id = args.id!;
  const refusal = await withJobsLock(root, (): { error: string } | null => {
    const dir = jobDir(root, id);
    if (!existsSync(dir)) return { error: `no model job "${id}"` };
    const job = readJob(root, id);
    if (!('error' in job) && isWaitAlive(job.wait, now()))
      return { error: `pix3 model feedback --wait (pid ${job.wait!.pid}) is waiting on "${id}"` };
    rmSync(dir, { recursive: true, force: true });
    rebuildIndex(root);
    return null;
  });
  if (refusal) return refuse(io, refusal.error);
  io.stdout(`Removed ${MODEL_JOBS_DIR}/${id}\n`);
  return 0;
};

const RUN: Record<Subcommand, Run> = {
  new: runNew,
  feedback: runFeedback,
  next: runNext,
  done: runDone,
  list: runList,
  rm: runRm,
};

const usageError = (io: CliIo, message: string): number => {
  io.stderr(`pix3 model: ${message} (pix3 model --help)\n`);
  return 2;
};
const refuse = (io: CliIo, message: string): number => {
  io.stderr(`pix3 model: ${message}\n`);
  return 1;
};

export const runModelCli = async (argv: readonly string[], io: ModelIo): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(COMMAND_USAGE.model);
    return 0;
  }
  const args = parseModelArgs(argv);
  if ('error' in args) return usageError(io, args.error);
  const project = resolveProjectRoot(io.cwd, args.flags.get('--project'));
  if ('error' in project) return usageError(io, project.error);
  return RUN[args.sub](args, project.root, io, io.now ?? (() => new Date()));
};
