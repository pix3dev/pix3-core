// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  diffGolden,
  formatGoldenHuman,
  goldenArgsOf,
  goldenOf,
  gridGoldenOf,
  readGolden,
  settleGolden,
  type GoldenArgs,
} from './golden.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pix3-golden-spec-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const args = (tolerance?: string, write = false): GoldenArgs => {
  const parsed = goldenArgsOf('golden.json', write, tolerance);
  if (!parsed || 'error' in parsed) throw new Error('bad golden args');
  return parsed;
};
const state = (gameState: unknown) => goldenOf(gameState, undefined);

describe('golden', () => {
  it('checks the flags: --write and --tolerance go with --golden, tolerance paths are rooted', () => {
    expect(goldenArgsOf(undefined, false, undefined)).toBeNull();
    expect(goldenArgsOf(undefined, true, undefined)).toEqual({
      error: '--write goes with --golden <file.json>',
    });
    expect(goldenArgsOf('--write', false, undefined)).toMatchObject({ error: expect.any(String) });
    expect(goldenArgsOf('g.json', false, 'score=0.1')).toMatchObject({
      error: expect.stringContaining('under gameState, analytics or aggregate'),
    });
    expect(goldenArgsOf('g.json', false, 'gameState.score=-1')).toMatchObject({
      error: expect.any(String),
    });
    expect(args('gameState.score.avg=0.01, gameState.units=0.5').tolerance).toEqual(
      new Map([
        ['gameState.score.avg', 0.01],
        ['gameState.units', 0.5],
      ])
    );
  });

  it('diffs at full depth with gameState predicate paths; numbers exact unless tolerated', () => {
    const expected = state({
      score: { avg: 1.5, best: 9 },
      waves: [{ n: 1 }, { n: 2 }],
      won: true,
    });
    const actual = state({
      score: { avg: 1.504, best: 9 },
      waves: [{ n: 1 }, { n: 3 }],
      won: false,
    });
    expect(diffGolden(expected, actual, new Map())).toEqual([
      { path: 'gameState.score.avg', expected: 1.5, actual: 1.504 },
      { path: 'gameState.waves.1.n', expected: 2, actual: 3 },
      { path: 'gameState.won', expected: true, actual: false },
    ]);
    // A tolerance covers its path and everything under it, numbers only.
    expect(
      diffGolden(expected, actual, args('gameState.score=0.01,gameState.waves=5').tolerance)
    ).toEqual([{ path: 'gameState.won', expected: true, actual: false }]);
    // The longest tolerated prefix wins.
    expect(
      diffGolden(expected, actual, args('gameState=1,gameState.score.avg=0.001').tolerance)
    ).toEqual([
      { path: 'gameState.score.avg', expected: 1.5, actual: 1.504 },
      { path: 'gameState.won', expected: true, actual: false },
    ]);
  });

  it('matches arrays by a unique id whatever their order; absent sides are left out', () => {
    const expected = state({
      units: [
        { id: 'a', hp: 3 },
        { id: 'b', hp: 5 },
      ],
    });
    const actual = state({
      units: [
        { id: 'c', hp: 1 },
        { id: 'b', hp: 4 },
        { id: 'a', hp: 3 },
      ],
    });
    expect(diffGolden(expected, actual, new Map())).toEqual([
      { path: 'gameState.units.1.hp', expected: 5, actual: 4 },
      { path: 'gameState.units.0', actual: { id: 'c', hp: 1 }, id: 'c' },
    ]);
    // A duplicate id falls back to the index.
    const dup = state({ units: [{ id: 'a' }, { id: 'a', x: 1 }] });
    expect(diffGolden(dup, state({ units: [{ id: 'a', x: 1 }, { id: 'a' }] }), new Map())).toEqual([
      { path: 'gameState.units.0.x', actual: 1 },
      { path: 'gameState.units.1.x', expected: 1 },
    ]);
  });

  it('pins the tracked events by name and props, in order, not by frame', () => {
    const run = goldenOf(
      { level: 2 },
      {
        total: 2,
        dropped: 0,
        events: [
          { name: 'level_start', props: { level: 2 }, frame: 0 },
          { name: 'tap', props: {}, frame: 40 },
        ],
      }
    );
    expect(run.analytics).toEqual([
      { name: 'level_start', props: { level: 2 } },
      { name: 'tap', props: {} },
    ]);
    const diffs = diffGolden(
      { ...run, analytics: [{ name: 'level_start', props: { level: 1 } }] },
      run,
      new Map()
    );
    expect(diffs).toEqual([
      { path: 'analytics.0.props.level', expected: 1, actual: 2 },
      { path: 'analytics.1', actual: { name: 'tap', props: {} } },
    ]);
  });

  it('writes a clean run, refuses a failed or empty one, and reports a mismatch', () => {
    const file = join(scratch, 'golden.json');
    const writing = args(undefined, true);
    expect(settleGolden(writing, scratch, state({ score: 3 }), true, null)).toMatchObject({
      status: 'not-written',
      reason: 'the run failed',
    });
    expect(settleGolden(writing, scratch, state(null), false, null)).toMatchObject({
      status: 'not-written',
    });
    expect(settleGolden(writing, scratch, state({ score: 3 }), false, null)).toEqual({
      file: 'golden.json',
      status: 'written',
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      gameState: { score: 3 },
      analytics: [],
    });

    const golden = readGolden(args(), scratch);
    if ('error' in golden) throw new Error(golden.error);
    expect(settleGolden(args(), scratch, state({ score: 3 }), false, golden)).toEqual({
      file: 'golden.json',
      status: 'match',
    });
    const mismatch = settleGolden(args(), scratch, state({ score: 4 }), false, golden);
    expect(formatGoldenHuman(mismatch)).toEqual([
      'golden: MISMATCH golden.json — 1 path(s) differ (expected → actual)',
      '  gameState.score: 3 → 4',
    ]);

    writeFileSync(file, '[1]');
    expect(readGolden(args(), scratch)).toMatchObject({
      error: expect.stringContaining('not a golden'),
    });
    expect(readGolden(goldenArgsOf('nope.json', false, undefined) as GoldenArgs, scratch)).toEqual({
      error: 'no golden nope.json — record one first with --golden nope.json --write',
    });
  });

  it("pins a grid's aggregate under its own root", () => {
    const tolerant = args('aggregate.numbers=0.5', true);
    const aggregate = { runs: 2, numbers: { 'gameState.score': { min: 1, max: 3 } } };
    expect(settleGolden(tolerant, scratch, gridGoldenOf(aggregate), false, null).status).toBe(
      'written'
    );
    expect(readGolden(args(), scratch)).toMatchObject({ error: expect.any(String) });
    const golden = readGolden(tolerant, scratch, 'grid');
    if ('error' in golden) throw new Error(golden.error);
    const moved = { runs: 2, numbers: { 'gameState.score': { min: 1.4, max: 4 } } };
    const result = settleGolden(
      { ...tolerant, write: false },
      scratch,
      gridGoldenOf(moved),
      false,
      golden
    );
    expect(result).toMatchObject({
      status: 'mismatch',
      diffs: [{ path: 'aggregate.numbers.gameState.score.max', expected: 3, actual: 4 }],
    });
    writeFileSync(join(scratch, 'golden.json'), JSON.stringify({ gameState: 1, analytics: [] }));
    expect(readGolden(tolerant, scratch, 'grid')).toMatchObject({
      error: expect.stringContaining('not a grid golden'),
    });
  });
});
