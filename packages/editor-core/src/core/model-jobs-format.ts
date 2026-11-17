/**
 * The model-job files under `.pix3/model-jobs/` (plan `.plans/model-jobs.md` → "Файлы задания"),
 * format v1: their types and the validators the 3D Asset Generator panel runs on every read.
 *
 * A COPY of `packages/cli/src/model/types.ts` (the editor never imports the CLI), plus the
 * `index.json` validator only the panel needs; keep the two in sync — both packages' specs read
 * the same `SAMPLE_JOB` / `SAMPLE_FEEDBACK` — and bump `v` for anything an older reader would
 * misread.
 *
 * Who writes what: the CLI writes `job.json`, `index.json`, `reference.<ext>` and `passes/`; the
 * panel only appends `feedback.jsonl` and writes `feedback/<fid>.png`. Every path a file names is
 * relative to the job's folder and stays inside it.
 */

export const MODEL_JOB_FORMAT = 1;

export const MODEL_JOBS_DIR = '.pix3/model-jobs';

/** A job id and a stage name: lowercase slug. */
export const MODEL_JOB_ID = /^[a-z0-9-]{1,64}$/;

export type ModelJobStatus = 'running' | 'done' | 'failed';

/** A `pix3 model feedback --wait` waiting for the human; only its own process removes it. */
export interface ModelJobWait {
  readonly pid: number;
  readonly since: string;
  readonly expiresAt: string;
}

/** What the CLI knows of one feedback entry: handed to the agent, then answered by a pass. */
export interface ModelFeedbackState {
  readonly deliveredAt: string;
  /** `seq` of the first pass rendered after delivery; null until then. */
  readonly addressedBy: number | null;
}

/** The conditions a pass was really rendered under: deltas compare only equal `params`. */
export interface ModelPassParams {
  readonly target: string;
  readonly node: string | null;
  readonly views: string;
  readonly size: number;
  readonly lights: string;
  readonly background: string;
  readonly frames: number;
  readonly referenceSha256: string | null;
  readonly referenceBackground: string | null;
}

/** The sheet's tiles, row by row (`model-sheet.ts`): `views[0]` is `reference` when there is one. */
export interface ModelPassSheet {
  readonly file: string;
  readonly views: readonly string[];
  /** One square tile's side, px. */
  readonly tile: number;
  readonly cols: number;
}

/**
 * Numbers copied from the render report (`model-look.ts` names), never recomputed; every field is
 * optional. `notCompared` is why the reference was not compared (a mask or comparison `error`).
 */
export interface ModelPassMetrics {
  readonly luminanceP50?: number;
  readonly nearBlack?: number;
  readonly saturationMedian?: number;
  readonly silhouetteIoU?: number;
  readonly saturationRatio?: number | null;
  readonly triangles?: number;
  readonly drawCalls?: number;
  readonly notCompared?: string | null;
}

export interface ModelPass {
  readonly seq: number;
  readonly stage: string;
  readonly at: string;
  /** The agent's note (`render --note`). */
  readonly note: string | null;
  /** Why the stage order was bypassed (`render --force "<reason>"`). */
  readonly forced: string | null;
  readonly params: ModelPassParams;
  readonly sheet: ModelPassSheet;
  /** The full render report (JSON), immutable like the sheet. */
  readonly report: string;
  readonly metrics: ModelPassMetrics;
}

export interface ModelJob {
  readonly v: typeof MODEL_JOB_FORMAT;
  readonly id: string;
  readonly title: string;
  readonly status: ModelJobStatus;
  /** `res://` scene or prefab. */
  readonly target: string;
  readonly node: string | null;
  /** `reference.<ext>` in the job folder, or null. */
  readonly reference: string | null;
  readonly referenceSha256: string | null;
  readonly referenceBackground: string | null;
  readonly views: string;
  readonly size: number;
  /** Unique slugs, in order. */
  readonly stages: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** done / failed: why (a failure's reason, or what `done --force` skipped); else null. */
  readonly result: string | null;
  readonly wait: ModelJobWait | null;
  /** Keyed by feedback id. */
  readonly feedback: Readonly<Record<string, ModelFeedbackState>>;
  readonly passes: readonly ModelPass[];
}

/** Coordinates are 0..1 of the whole sheet; `view` is the tile the mark is on. */
export type ModelFeedbackMark =
  | {
      readonly view: string;
      readonly shape: 'rect';
      readonly rect: readonly [number, number, number, number];
    }
  | { readonly view: string; readonly shape: 'point'; readonly point: readonly [number, number] }
  | {
      readonly view: string;
      readonly shape: 'path';
      readonly path: readonly (readonly [number, number])[];
    }
  | {
      readonly view: string;
      /** Points from `from` at `to` (the head); its view is the tile of `to`. */
      readonly shape: 'arrow';
      readonly from: readonly [number, number];
      readonly to: readonly [number, number];
    };

/** One line of `feedback.jsonl` (written by the panel, never changed). */
export interface ModelFeedback {
  readonly v: typeof MODEL_JOB_FORMAT;
  /** `f-<ms>-<rand>`, created once per send and kept across retries. */
  readonly id: string;
  readonly at: string;
  /** `seq` of the pass it is about; null before the first pass. */
  readonly pass: number | null;
  readonly text: string;
  readonly verdict: 'accept' | 'changes' | null;
  readonly marks: readonly ModelFeedbackMark[];
  /** `feedback/<id>.png`: the sheet with the marks drawn; present when there are marks. */
  readonly image?: string;
}

/** `index.json`: derived from every `job.json`, rebuilt by the CLI on each write. */
export interface ModelJobIndex {
  readonly v: typeof MODEL_JOB_FORMAT;
  readonly jobs: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: ModelJobStatus;
    readonly target: string;
    readonly passes: number;
    /** The last pass's stage, or null. */
    readonly stage: string | null;
    readonly updatedAt: string;
    readonly wait: ModelJobWait | null;
  }[];
}

// --- validation ----------------------------------------------------------------------------------

class Invalid extends Error {}

type Obj = Record<string, unknown>;

const fail = (where: string, what: string): never => {
  throw new Invalid(`${where}: ${what}`);
};
const obj = (value: unknown, where: string): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : fail(where, 'not an object');
const str = (value: unknown, where: string): string =>
  typeof value === 'string' ? value : fail(where, 'not a string');
const strOrNull = (value: unknown, where: string): string | null =>
  value === null ? null : str(value, where);
const num = (value: unknown, where: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(where, 'not a number');
const posInt = (value: unknown, where: string): number =>
  Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fail(where, 'not a whole number ≥ 1');
const time = (value: unknown, where: string): string =>
  Number.isNaN(Date.parse(str(value, where))) ? fail(where, 'not a timestamp') : (value as string);
const slug = (value: unknown, where: string): string =>
  MODEL_JOB_ID.test(str(value, where)) ? (value as string) : fail(where, 'not a [a-z0-9-] slug');
const oneOf = <T extends string>(value: unknown, values: readonly T[], where: string): T =>
  values.includes(value as T) ? (value as T) : fail(where, `not one of ${values.join(', ')}`);
const array = (value: unknown, where: string): unknown[] =>
  Array.isArray(value) ? value : fail(where, 'not an array');
const unit = (value: unknown, where: string): number => {
  const n = num(value, where);
  return n >= 0 && n <= 1 ? n : fail(where, 'outside 0..1');
};
const xy = (value: unknown, where: string): [number, number] => {
  const a = array(value, where);
  return a.length === 2
    ? [unit(a[0], `${where}[0]`), unit(a[1], `${where}[1]`)]
    : fail(where, 'not [x, y]');
};

/** A relative `a/b.png` that stays inside the job folder (no `..`, no absolute, no `\`). */
export const isJobRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !/^[A-Za-z]:/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

const jobPath = (value: unknown, where: string): string =>
  isJobRelativePath(str(value, where))
    ? (value as string)
    : fail(where, 'not a path inside the job');

const wait = (value: unknown, where: string): ModelJobWait | null => {
  if (value === null) return null;
  const w = obj(value, where);
  return {
    pid: posInt(w.pid, `${where}.pid`),
    since: time(w.since, `${where}.since`),
    expiresAt: time(w.expiresAt, `${where}.expiresAt`),
  };
};

const pass = (value: unknown, where: string): ModelPass => {
  const p = obj(value, where);
  const params = obj(p.params, `${where}.params`);
  const sheet = obj(p.sheet, `${where}.sheet`);
  const metrics = obj(p.metrics, `${where}.metrics`);
  const out: Record<string, number | string | null> = {};
  for (const key of [
    'luminanceP50',
    'nearBlack',
    'saturationMedian',
    'silhouetteIoU',
    'triangles',
    'drawCalls',
  ] as const) {
    if (metrics[key] !== undefined) out[key] = num(metrics[key], `${where}.metrics.${key}`);
  }
  if (metrics.saturationRatio !== undefined)
    out.saturationRatio =
      metrics.saturationRatio === null
        ? null
        : num(metrics.saturationRatio, `${where}.metrics.saturationRatio`);
  if (metrics.notCompared !== undefined)
    out.notCompared = strOrNull(metrics.notCompared, `${where}.metrics.notCompared`);
  return {
    seq: posInt(p.seq, `${where}.seq`),
    stage: slug(p.stage, `${where}.stage`),
    at: time(p.at, `${where}.at`),
    note: strOrNull(p.note, `${where}.note`),
    forced: strOrNull(p.forced, `${where}.forced`),
    params: {
      target: str(params.target, `${where}.params.target`),
      node: strOrNull(params.node, `${where}.params.node`),
      views: str(params.views, `${where}.params.views`),
      size: posInt(params.size, `${where}.params.size`),
      lights: str(params.lights, `${where}.params.lights`),
      background: str(params.background, `${where}.params.background`),
      frames: posInt(params.frames, `${where}.params.frames`),
      referenceSha256: strOrNull(params.referenceSha256, `${where}.params.referenceSha256`),
      referenceBackground: strOrNull(
        params.referenceBackground,
        `${where}.params.referenceBackground`
      ),
    },
    sheet: {
      file: jobPath(sheet.file, `${where}.sheet.file`),
      views: array(sheet.views, `${where}.sheet.views`).map((v, i) =>
        str(v, `${where}.sheet.views[${i}]`)
      ),
      tile: posInt(sheet.tile, `${where}.sheet.tile`),
      cols: posInt(sheet.cols, `${where}.sheet.cols`),
    },
    report: jobPath(p.report, `${where}.report`),
    metrics: out as ModelPassMetrics,
  };
};

const STATUSES: readonly ModelJobStatus[] = ['running', 'done', 'failed'];

const job = (value: unknown): ModelJob => {
  const j = obj(value, 'job');
  if (j.v !== MODEL_JOB_FORMAT)
    fail('v', `format ${String(j.v)} (this reader knows ${MODEL_JOB_FORMAT})`);
  const stages = array(j.stages, 'stages').map((s, i) => slug(s, `stages[${i}]`));
  if (stages.length === 0) fail('stages', 'empty');
  if (new Set(stages).size !== stages.length) fail('stages', 'not unique');
  const feedback: Record<string, ModelFeedbackState> = {};
  for (const [id, state] of Object.entries(obj(j.feedback, 'feedback'))) {
    const s = obj(state, `feedback.${id}`);
    feedback[id] = {
      deliveredAt: time(s.deliveredAt, `feedback.${id}.deliveredAt`),
      addressedBy:
        s.addressedBy === null ? null : posInt(s.addressedBy, `feedback.${id}.addressedBy`),
    };
  }
  const passes = array(j.passes, 'passes').map((p, i) => pass(p, `passes[${i}]`));
  passes.forEach((p, i) => {
    if (!stages.includes(p.stage))
      fail(`passes[${i}].stage`, `"${p.stage}" is not a stage of the job`);
    if (i > 0 && p.seq <= passes[i - 1].seq) fail(`passes[${i}].seq`, 'not increasing');
  });
  return {
    v: MODEL_JOB_FORMAT,
    id: slug(j.id, 'id'),
    title: str(j.title, 'title'),
    status: oneOf(j.status, STATUSES, 'status'),
    target: str(j.target, 'target'),
    node: strOrNull(j.node, 'node'),
    reference: j.reference === null ? null : jobPath(j.reference, 'reference'),
    referenceSha256: strOrNull(j.referenceSha256, 'referenceSha256'),
    referenceBackground: strOrNull(j.referenceBackground, 'referenceBackground'),
    views: str(j.views, 'views'),
    size: posInt(j.size, 'size'),
    stages,
    createdAt: time(j.createdAt, 'createdAt'),
    updatedAt: time(j.updatedAt, 'updatedAt'),
    result: strOrNull(j.result, 'result'),
    wait: wait(j.wait, 'wait'),
    feedback,
    passes,
  };
};

const mark = (value: unknown, where: string): ModelFeedbackMark => {
  const m = obj(value, where);
  const view = str(m.view, `${where}.view`);
  const shape = oneOf(m.shape, ['rect', 'point', 'path', 'arrow'] as const, `${where}.shape`);
  if (shape === 'point') return { view, shape, point: xy(m.point, `${where}.point`) };
  if (shape === 'arrow')
    return { view, shape, from: xy(m.from, `${where}.from`), to: xy(m.to, `${where}.to`) };
  if (shape === 'path') {
    const path = array(m.path, `${where}.path`).map((p, i) => xy(p, `${where}.path[${i}]`));
    return path.length >= 2 ? { view, shape, path } : fail(`${where}.path`, 'fewer than 2 points');
  }
  const r = array(m.rect, `${where}.rect`);
  if (r.length !== 4) fail(`${where}.rect`, 'not [x, y, w, h]');
  const [x, y, w, h] = r.map((n, i) => unit(n, `${where}.rect[${i}]`));
  return { view, shape, rect: [x, y, w, h] };
};

const feedback = (value: unknown): ModelFeedback => {
  const f = obj(value, 'feedback');
  if (f.v !== MODEL_JOB_FORMAT)
    fail('v', `format ${String(f.v)} (this reader knows ${MODEL_JOB_FORMAT})`);
  const id = str(f.id, 'id');
  if (!/^f-[A-Za-z0-9-]{1,64}$/.test(id)) fail('id', 'not f-<ms>-<rand>');
  const marks = array(f.marks, 'marks').map((m, i) => mark(m, `marks[${i}]`));
  return {
    v: MODEL_JOB_FORMAT,
    id,
    at: time(f.at, 'at'),
    pass: f.pass === null ? null : posInt(f.pass, 'pass'),
    text: str(f.text, 'text'),
    verdict:
      f.verdict === null ? null : oneOf(f.verdict, ['accept', 'changes'] as const, 'verdict'),
    marks,
    ...(f.image === undefined ? {} : { image: jobPath(f.image, 'image') }),
  };
};

const jobIndex = (value: unknown): ModelJobIndex => {
  const x = obj(value, 'index');
  if (x.v !== MODEL_JOB_FORMAT)
    fail('v', `format ${String(x.v)} (this reader knows ${MODEL_JOB_FORMAT})`);
  return {
    v: MODEL_JOB_FORMAT,
    jobs: array(x.jobs, 'jobs').map((entry, i) => {
      const e = obj(entry, `jobs[${i}]`);
      return {
        id: slug(e.id, `jobs[${i}].id`),
        title: str(e.title, `jobs[${i}].title`),
        status: oneOf(e.status, STATUSES, `jobs[${i}].status`),
        target: str(e.target, `jobs[${i}].target`),
        passes:
          Number.isInteger(e.passes) && (e.passes as number) >= 0
            ? (e.passes as number)
            : fail(`jobs[${i}].passes`, 'not a count'),
        stage: e.stage === null ? null : slug(e.stage, `jobs[${i}].stage`),
        updatedAt: time(e.updatedAt, `jobs[${i}].updatedAt`),
        wait: wait(e.wait, `jobs[${i}].wait`),
      };
    }),
  };
};

const parseWith =
  <T>(validate: (value: unknown) => T) =>
  (text: string): T | { readonly error: string } => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return { error: `not JSON (${(error as Error).message})` };
    }
    try {
      return validate(value);
    } catch (error) {
      if (error instanceof Invalid) return { error: error.message };
      throw error;
    }
  };

/** `job.json` text → the job, or the first thing wrong with it. */
export const parseModelJob = parseWith(job);
/** One `feedback.jsonl` line → the entry, or the first thing wrong with it. */
export const parseModelFeedback = parseWith(feedback);
/** `index.json` text → the list of jobs, or the first thing wrong with it (editor only). */
export const parseModelJobIndex = parseWith(jobIndex);
