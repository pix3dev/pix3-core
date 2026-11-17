// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { runRenderCli } from '../render/command.ts';
import { describeMark, parseModelArgs, runModelCli } from './command.ts';
import {
  jobDir,
  jobsDir,
  passMetrics,
  readJob,
  recordPass,
  updateJob,
  withJobsLock,
  type PassInput,
} from './store.ts';
import { parseModelFeedback, parseModelJob, type ModelJob } from './types.ts';

/** `pix3 model` and `pix3 render --job` without Chrome (plan `.plans/model-jobs.md`, Stage 1). */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-model-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const project = (): string => {
  const root = join(scratch, `p${++counter}`);
  mkdirSync(join(root, 'scenes', 'prefabs'), { recursive: true });
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
  writeFileSync(join(root, 'scenes', 'prefabs', 'tower.prefab'), 'root: []\n');
  writeFileSync(join(root, 'concept.png'), 'not really a png');
  return root;
};
const cli = async (root: string, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runModelCli(argv, {
    cwd: root,
    stdout: t => out.push(t),
    stderr: t => err.push(t),
  });
  return { code, out: out.join(''), err: err.join('') };
};
const job = (root: string, id = 'tower'): ModelJob => {
  const read = readJob(root, id);
  if ('error' in read) throw new Error(read.error);
  return read;
};
const pass = (stage: string, extra: Partial<PassInput> = {}): PassInput => ({
  stage,
  note: null,
  params: {
    target: 'res://scenes/prefabs/tower.prefab',
    node: null,
    views: 'iso,front',
    size: 256,
    lights: 'auto',
    background: '#8f9aa6',
    frames: 2,
    referenceSha256: null,
    referenceBackground: null,
  },
  sheetViews: ['reference', 'iso', 'front'],
  cols: 2,
  metrics: { luminanceP50: 0.3, triangles: 12, drawCalls: 1, notCompared: null },
  sheetPng: Buffer.from('png'),
  report: { look: {} },
  now: new Date('2026-11-16T10:00:00.000Z'),
  ...extra,
});
const addFeedback = (root: string, entry: Record<string, unknown>): void =>
  appendFileSync(
    join(jobDir(root, 'tower'), 'feedback.jsonl'),
    `${JSON.stringify({ v: 1, at: '2026-11-16T10:05:00.000Z', pass: 1, text: '', verdict: null, marks: [], ...entry })}\n`
  );

describe('pix3 model arguments', () => {
  it('takes a subcommand, a slug id and known flags only', () => {
    expect(parseModelArgs(['new', 'tower', '--target', 'a.prefab'])).toMatchObject({
      sub: 'new',
      id: 'tower',
    });
    expect(parseModelArgs(['list'])).toMatchObject({ sub: 'list' });
    expect(parseModelArgs(['new', 'Tower!'])).toMatchObject({
      error: expect.stringContaining('[a-z0-9-]'),
    });
    expect(parseModelArgs(['next'])).toMatchObject({
      error: expect.stringContaining('needs the job id'),
    });
    expect(parseModelArgs(['make', 'x'])).toMatchObject({
      error: expect.stringContaining('no subcommand'),
    });
    expect(parseModelArgs(['next', 'x', '--bogus'])).toMatchObject({
      error: 'unknown argument --bogus',
    });
    expect(parseModelArgs(['new', 'x', '--target'])).toMatchObject({
      error: '--target needs a value',
    });
  });
});

describe('pix3 model new', () => {
  it('opens a job on a res:// target, copies the reference and keeps its sha256', async () => {
    const root = project();
    const r = await cli(
      join(root, 'scenes'),
      'new',
      'tower',
      '--target',
      'prefabs/tower.prefab',
      '--reference',
      '../concept.png',
      '--stages',
      'blockout,form'
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('pix3 render --job tower --stage blockout');
    const created = job(root);
    expect(created).toMatchObject({
      v: 1,
      status: 'running',
      target: 'res://scenes/prefabs/tower.prefab',
      reference: 'reference.png',
      stages: ['blockout', 'form'],
      views: 'iso,front,right,top',
      size: 512,
      passes: [],
    });
    expect(created.referenceSha256).toBe(
      createHash('sha256').update('not really a png').digest('hex')
    );
    expect(readFileSync(join(jobDir(root, 'tower'), 'reference.png'), 'utf8')).toBe(
      'not really a png'
    );
    const index = JSON.parse(readFileSync(join(jobsDir(root), 'index.json'), 'utf8'));
    expect(index).toMatchObject({ v: 1, jobs: [{ id: 'tower', passes: 0, stage: null }] });

    expect(
      (await cli(root, 'new', 'tower', '--target', 'res://scenes/prefabs/tower.prefab')).err
    ).toContain('exists');
    expect((await cli(root, 'new', 'b', '--target', 'res://nope.prefab')).code).toBe(2);
    expect((await cli(root, 'new', 'c', '--target', '../../etc/passwd')).code).toBe(2);
    expect(
      (
        await cli(
          root,
          'new',
          'd',
          '--target',
          'res://scenes/prefabs/tower.prefab',
          '--stages',
          'a,a'
        )
      ).code
    ).toBe(2);
  });
});

describe('passes and stages', () => {
  it('takes the first stage, then the same or the next; refuses a jump unless forced, and keeps why', async () => {
    const root = project();
    await cli(root, 'new', 'tower', '--target', 'res://scenes/prefabs/tower.prefab');
    expect(await recordPass(root, 'tower', pass('form'))).toEqual({
      error: '"form" skips "blockout", "structure", which have no pass yet',
    });
    const first = await recordPass(root, 'tower', pass('blockout', { note: 'boxes' }));
    expect('error' in first).toBe(false);
    expect(await recordPass(root, 'tower', pass('blockout'))).not.toHaveProperty('error');
    expect(await recordPass(root, 'tower', pass('form'))).toHaveProperty('error');
    expect(await recordPass(root, 'tower', pass('nope', { force: 'x' }))).toHaveProperty('error');
    const forced = await recordPass(
      root,
      'tower',
      pass('form', { force: 'structure is trivial here' })
    );
    expect(forced).toMatchObject({
      pass: { seq: 3, stage: 'form', forced: 'structure is trivial here' },
    });
    expect(await recordPass(root, 'tower', pass('blockout'))).toEqual({
      error: '"blockout" comes before the current stage "form"',
    });

    const j = job(root);
    expect(j.passes.map(p => [p.seq, p.stage, p.note])).toEqual([
      [1, 'blockout', 'boxes'],
      [2, 'blockout', null],
      [3, 'form', null],
    ]);
    expect(j.passes[2].sheet).toEqual({
      file: 'passes/03-form/sheet.png',
      views: ['reference', 'iso', 'front'],
      tile: 256,
      cols: 2,
    });
    expect(
      readFileSync(join(jobDir(root, 'tower'), 'passes', '01-blockout', 'sheet.png'), 'utf8')
    ).toBe('png');
    expect(
      JSON.parse(readFileSync(join(jobDir(root, 'tower'), j.passes[0].report), 'utf8'))
    ).toEqual({ look: {} });
    const index = JSON.parse(readFileSync(join(jobsDir(root), 'index.json'), 'utf8'));
    expect(index.jobs[0]).toMatchObject({ passes: 3, stage: 'form' });
  });

  it('copies metrics under model-look names; a failed mask or comparison is notCompared, not zero', () => {
    const info = { triangles: 10, drawCalls: 1 };
    const look = {
      samples: 100,
      coverage: 0.4,
      luminance: { p10: 0.1, p50: 0.3, p90: 0.6 },
      nearBlack: 0.02,
      saturation: { median: 0.4, share: 0.9 },
      note: '',
    };
    expect(passMetrics(info, look, undefined)).toEqual({
      luminanceP50: 0.3,
      nearBlack: 0.02,
      saturationMedian: 0.4,
      triangles: 10,
      drawCalls: 1,
      notCompared: null,
    });
    expect(passMetrics(info, look, { mask: { error: 'its corners disagree' } }).notCompared).toBe(
      'mask: its corners disagree'
    );
    const judged = {
      mask: { method: 'alpha', coverage: 0.3 },
      look,
      view: 'iso',
      palette: [],
    };
    expect(
      passMetrics(info, look, { ...judged, comparison: { error: 'the render has no foreground' } })
    ).toMatchObject({ notCompared: 'the render has no foreground' });
    const compared = passMetrics(info, look, {
      ...judged,
      comparison: {
        silhouetteIoU: 0.7,
        aspect: { reference: 1, render: 1 },
        bands: [],
        saturationRatio: null,
      },
    });
    expect(compared).toMatchObject({
      silhouetteIoU: 0.7,
      saturationRatio: null,
      notCompared: null,
    });
  });
});

describe('the lock and the index', () => {
  it('two processes writing at once lose nothing, and a dead holder’s stale lock is taken over', async () => {
    const root = project();
    await cli(
      root,
      'new',
      'tower',
      '--target',
      'res://scenes/prefabs/tower.prefab',
      '--title',
      '0'
    );
    // Each child bumps the counter in the title 15 times, read-modify-write under the lock.
    const store = pathToFileURL(join(import.meta.dirname, 'store.ts')).href;
    const code =
      `import { updateJob } from ${JSON.stringify(store)};` +
      `for (let i = 0; i < 15; i++) await updateJob(${JSON.stringify(root)}, 'tower', j => ({ ...j, title: String(Number(j.title) + 1) }));`;
    const child = () =>
      new Promise<number | null>(resolve =>
        spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' }).on(
          'exit',
          resolve
        )
      );
    expect(await Promise.all([child(), child()])).toEqual([0, 0]);
    expect(job(root).title).toBe('30');

    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const lock = join(jobsDir(root), '.lock');
    writeFileSync(lock, JSON.stringify({ pid: dead, at: '2026-01-01T00:00:00.000Z' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await withJobsLock(root, () => 'taken')).toBe('taken');
    expect(existsSync(lock)).toBe(false);
  });

  it('a fresh lock of a live process is waited for', async () => {
    const root = project();
    const lock = join(jobsDir(root), '.lock');
    mkdirSync(jobsDir(root), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    setTimeout(() => rmSync(lock), 150);
    const start = Date.now();
    await withJobsLock(root, () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it('rebuilds index.json from every job.json on a write', async () => {
    const root = project();
    await cli(root, 'new', 'a', '--target', 'res://scenes/prefabs/tower.prefab');
    await cli(root, 'new', 'b', '--target', 'res://scenes/prefabs/tower.prefab');
    writeFileSync(join(jobsDir(root), 'index.json'), '{ broken');
    rmSync(jobDir(root, 'a'), { recursive: true });
    await cli(root, 'done', 'b', '--failed', 'no time');
    const index = JSON.parse(readFileSync(join(jobsDir(root), 'index.json'), 'utf8'));
    expect(index.jobs.map((e: { id: string; status: string }) => [e.id, e.status])).toEqual([
      ['b', 'failed'],
    ]);
  });
});

describe('pix3 model feedback', () => {
  it('prints undelivered feedback in words, marks it delivered, and the next pass addresses it', async () => {
    const root = project();
    await cli(root, 'new', 'tower', '--target', 'res://scenes/prefabs/tower.prefab');
    await recordPass(root, 'tower', pass('blockout'));
    expect((await cli(root, 'feedback', 'tower')).out).toBe('No new feedback.\n');
    addFeedback(root, {
      id: 'f-1-a',
      text: 'roof too flat',
      verdict: 'changes',
      marks: [{ view: 'front', shape: 'rect', rect: [0.3, 0.52, 0.1, 0.1] }],
      image: 'feedback/f-1-a.png',
    });
    appendFileSync(join(jobDir(root, 'tower'), 'feedback.jsonl'), '{ torn\n');
    const next = await cli(root, 'next', 'tower');
    expect(next.out).toContain('1 new feedback — pix3 model feedback tower');
    expect(next.out).toContain('last verdict: needs changes (pass 1)');

    const r = await cli(root, 'feedback', 'tower');
    expect(r.out).toContain('f-1-a · pass 1 (blockout) · verdict: needs changes');
    expect(r.out).toContain('"roof too flat"');
    // front is the first tile of row 1 (reference | iso / front): the mark is its top right.
    expect(r.out).toContain('front: rect 20%×20%, top right');
    expect(r.out).toContain('.pix3/model-jobs/tower/feedback/f-1-a.png (missing)');
    expect(r.out).toContain('1 unreadable line(s)');
    expect(job(root).feedback['f-1-a']).toMatchObject({ addressedBy: null });
    expect((await cli(root, 'feedback', 'tower')).out).toBe(
      'No new feedback.\n(1 unreadable line(s) in feedback.jsonl skipped)\n'
    );

    addFeedback(root, { id: 'f-2-b', text: 'later' });
    await recordPass(root, 'tower', pass('blockout'));
    const after = job(root);
    expect(after.feedback['f-1-a'].addressedBy).toBe(2);
    expect(after.feedback['f-2-b']).toBeUndefined(); // not delivered, so not addressed
  });

  it('--wait times out with exit 0 and removes only its own wait; it also picks up what arrives', async () => {
    const root = project();
    await cli(root, 'new', 'tower', '--target', 'res://scenes/prefabs/tower.prefab');
    const timedOut = await cli(root, 'feedback', 'tower', '--wait', '--timeout', '0.2', '--json');
    expect(timedOut.code).toBe(0);
    expect(JSON.parse(timedOut.out)).toMatchObject({ timedOut: true, feedback: [] });
    expect(job(root).wait).toBeNull();

    const waiting = cli(root, 'feedback', 'tower', '--wait', '--timeout', '5');
    await new Promise(r => setTimeout(r, 150));
    expect(job(root).wait).toMatchObject({ pid: process.pid });
    expect((await cli(root, 'rm', 'tower')).err).toContain('is waiting on "tower"');
    addFeedback(root, { id: 'f-3-c', pass: null, text: 'make it taller', verdict: null });
    const got = await waiting;
    expect(got.out).toContain('f-3-c · before the first pass');
    expect(job(root).wait).toBeNull();
    expect(job(root).feedback['f-3-c']).toBeDefined();

    // A wait another process put in its place meanwhile stays.
    const again = cli(root, 'feedback', 'tower', '--wait', '--timeout', '0.4');
    await new Promise(r => setTimeout(r, 100));
    const foreign = {
      pid: 1,
      since: '2026-11-16T10:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    await updateJob(root, 'tower', j => ({ ...j, wait: foreign }));
    await again;
    expect(job(root).wait).toEqual(foreign);
  });
});

describe('pix3 model done / rm / list', () => {
  it('done needs the last stage and no undelivered feedback, unless --force', async () => {
    const root = project();
    await cli(
      root,
      'new',
      'tower',
      '--target',
      'res://scenes/prefabs/tower.prefab',
      '--stages',
      'blockout,bake'
    );
    expect((await cli(root, 'done', 'tower')).err).toContain('no "bake" pass');
    await recordPass(root, 'tower', pass('blockout'));
    await recordPass(root, 'tower', pass('bake'));
    addFeedback(root, { id: 'f-9-z', text: 'hm' });
    expect((await cli(root, 'done', 'tower')).err).toContain('1 undelivered feedback');
    expect((await cli(root, 'next', 'tower')).out).not.toContain('pix3 model done');
    await cli(root, 'feedback', 'tower');
    expect((await cli(root, 'next', 'tower')).out).toContain('or: pix3 model done tower');
    expect((await cli(root, 'done', 'tower')).code).toBe(0);
    expect(job(root)).toMatchObject({ status: 'done', result: null });
    expect((await cli(root, 'done', 'tower')).err).toContain('already done');
    expect(await recordPass(root, 'tower', pass('bake'))).toMatchObject({
      error: expect.stringContaining('is done'),
    });

    await cli(root, 'new', 'other', '--target', 'res://scenes/prefabs/tower.prefab');
    expect((await cli(root, 'done', 'other', '--force')).out).toContain('forced: no "bake" pass');
    const list = await cli(root, 'list');
    expect(list.out).toMatch(/^other\s+done\s+0 pass/m);
    expect(list.out).toMatch(/^tower\s+done\s+2 pass\(es\) \(bake\)/m);

    expect((await cli(root, 'rm', 'other')).code).toBe(0);
    expect(existsSync(jobDir(root, 'other'))).toBe(false);
    expect((await cli(root, 'rm', 'other')).code).toBe(1);
    const index = JSON.parse(readFileSync(join(jobsDir(root), 'index.json'), 'utf8'));
    expect(index.jobs.map((e: { id: string }) => e.id)).toEqual(['tower']);
  });
});

describe('pix3 render --job (before Chrome)', () => {
  const render = async (root: string, ...argv: string[]) => {
    const err: string[] = [];
    const code = await runRenderCli(argv, {
      cwd: root,
      stdout: () => undefined,
      stderr: t => err.push(t),
      env: { PATH: '' },
    });
    return { code, err: err.join('') };
  };

  it('refuses --out, a missing --stage, pass flags without a job, and a stage out of order', async () => {
    const root = project();
    await cli(root, 'new', 'tower', '--target', 'res://scenes/prefabs/tower.prefab');
    expect(
      (await render(root, '--job', 'tower', '--stage', 'blockout', '--out', 'a.png')).err
    ).toContain('--out and --job exclude each other');
    expect((await render(root, '--job', 'tower')).err).toContain('--job needs --stage');
    expect((await render(root, 'x.pix3scene', '--stage', 'form')).err).toContain('belong to --job');
    const jump = await render(root, '--job', 'tower', '--stage', 'form');
    expect(jump.code).toBe(2);
    expect(jump.err).toContain('refused: "form" skips "blockout", "structure"');
    expect(jump.err).toContain('Allowed now: blockout');
    expect((await render(root, '--job', 'nope', '--stage', 'form')).err).toContain(
      'no model job "nope"'
    );
    expect(job(root).passes).toEqual([]);
  });
});

describe('the format validators', () => {
  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(SAMPLE_JOB));

  it('reads the sample job and feedback the panel shares', () => {
    expect(parseModelJob(JSON.stringify(SAMPLE_JOB))).toEqual(SAMPLE_JOB);
    for (const line of SAMPLE_FEEDBACK.trim().split('\n'))
      expect(parseModelFeedback(line)).not.toHaveProperty('error');
  });

  it('refuses broken JSON, another version, a path out of the job, a pass of an unknown stage', () => {
    expect(parseModelJob('{ nope')).toMatchObject({ error: expect.stringContaining('not JSON') });
    expect(parseModelJob(JSON.stringify({ ...valid(), v: 2 }))).toMatchObject({
      error: expect.stringContaining('format 2'),
    });
    expect(parseModelJob(JSON.stringify({ ...valid(), reference: '../x.png' }))).toEqual({
      error: 'reference: not a path inside the job',
    });
    const j = valid();
    (j.passes as { sheet: { file: string } }[])[0].sheet.file = '/etc/passwd';
    expect(parseModelJob(JSON.stringify(j))).toEqual({
      error: 'passes[0].sheet.file: not a path inside the job',
    });
    const k = valid();
    (k.passes as { stage: string }[])[0].stage = 'paint';
    expect(parseModelJob(JSON.stringify(k))).toMatchObject({
      error: expect.stringContaining('not a stage'),
    });
    const feedback = (patch: Record<string, unknown>) =>
      parseModelFeedback(
        JSON.stringify({ ...JSON.parse(SAMPLE_FEEDBACK.split('\n')[0]), ...patch })
      );
    expect(feedback({ image: 'feedback/../../x.png' })).toEqual({
      error: 'image: not a path inside the job',
    });
    expect(feedback({ marks: [{ view: 'iso', shape: 'point', point: [2, 0] }] })).toEqual({
      error: 'marks[0].point[0]: outside 0..1',
    });
    expect(feedback({ verdict: 'maybe' })).toMatchObject({
      error: expect.stringContaining('verdict'),
    });
  });

  it('describes a mark inside its own tile', () => {
    const j = parseModelJob(JSON.stringify(SAMPLE_JOB)) as ModelJob;
    // reference | iso / front: iso is row 0 right, front row 1 left.
    expect(describeMark({ view: 'iso', shape: 'point', point: [0.55, 0.45] }, j, 3)).toBe(
      'iso: point, bottom left'
    );
    expect(describeMark({ view: 'iso', shape: 'point', point: [0.55, 0.45] }, j, 99)).toBe(
      'iso: point, middle center of the sheet'
    );
    expect(
      describeMark(
        {
          view: 'front',
          shape: 'path',
          path: [
            [0.05, 0.55],
            [0.45, 0.95],
          ],
        },
        j,
        3
      )
    ).toBe('front: stroke, top left → bottom right');
    const arrow = { view: 'iso', shape: 'arrow', from: [0.55, 0.05], to: [0.95, 0.45] } as const;
    expect(describeMark(arrow, j, 3)).toBe('iso: arrow from top left pointing at bottom right');
    const line = { ...JSON.parse(SAMPLE_FEEDBACK.split('\n')[0]), marks: [arrow] };
    expect(parseModelFeedback(JSON.stringify(line))).toMatchObject({ marks: [arrow] });
  });
});

/**
 * The example the panel's specs carry too (the same literal):
 * `packages/editor-core/src/core/model-jobs-format.test-helpers.ts`.
 */
const SAMPLE_JOB = {
  v: 1,
  id: 'tower',
  title: 'Tower',
  status: 'running',
  target: 'res://scenes/prefabs/tower.prefab',
  node: null,
  reference: 'reference.png',
  referenceSha256: 'ab',
  referenceBackground: null,
  views: 'iso,front',
  size: 512,
  stages: ['blockout', 'structure', 'form', 'material', 'bake'],
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:10:00.000Z',
  result: null,
  wait: { pid: 4242, since: '2026-11-16T10:10:00.000Z', expiresAt: '2026-11-16T10:19:00.000Z' },
  feedback: { 'f-1763287800000-k3x9': { deliveredAt: '2026-11-16T10:06:00.000Z', addressedBy: 3 } },
  passes: [
    {
      seq: 3,
      stage: 'form',
      at: '2026-11-16T10:08:00.000Z',
      note: 'lathe for the tower body',
      forced: null,
      params: {
        target: 'res://scenes/prefabs/tower.prefab',
        node: null,
        views: 'iso,front',
        size: 512,
        lights: 'auto',
        background: '#8f9aa6',
        frames: 2,
        referenceSha256: 'ab',
        referenceBackground: null,
      },
      sheet: {
        file: 'passes/03-form/sheet.png',
        views: ['reference', 'iso', 'front'],
        tile: 512,
        cols: 2,
      },
      report: 'passes/03-form/report.json',
      metrics: {
        luminanceP50: 0.33,
        nearBlack: 0.02,
        saturationMedian: 0.41,
        silhouetteIoU: 0.71,
        saturationRatio: null,
        triangles: 1840,
        drawCalls: 1,
        notCompared: null,
      },
    },
  ],
};

const SAMPLE_FEEDBACK = `{"v":1,"id":"f-1763287800000-k3x9","at":"2026-11-16T10:05:00.000Z","pass":3,"text":"roof too flat","verdict":"changes","marks":[{"view":"front","shape":"rect","rect":[0.1,0.55,0.3,0.2]},{"view":"iso","shape":"point","point":[0.7,0.2]},{"view":"iso","shape":"path","path":[[0.6,0.1],[0.8,0.3]]}],"image":"feedback/f-1763287800000-k3x9.png"}
{"v":1,"id":"f-1763287900000-p2q1","at":"2026-11-16T10:20:00.000Z","pass":3,"text":"","verdict":"accept","marks":[]}
`;
