// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  aggregateGrid,
  formatGridHuman,
  gridCombos,
  parseSeedList,
  parseSizeList,
  runPool,
  type GridRun,
} from './grid.ts';

const run = (verdict: GridRun['verdict'], game: unknown, seed = 0): GridRun => ({
  combo: { index: seed, label: `seed=${seed}`, seed },
  verdict,
  game,
  errors: [],
});

describe('run grid', () => {
  it('parses seeds and sizes as lists and ranges', () => {
    expect(parseSeedList('1..3,7')).toEqual(
      [1, 2, 3, 7].map(seed => ({ value: seed, label: `seed=${seed}` }))
    );
    expect(parseSeedList('3..1')).toMatchObject({ error: expect.stringContaining('--seed') });
    expect(parseSeedList('x')).toMatchObject({ error: expect.any(String) });
    expect(parseSizeList('390x844@3, 360x640')).toEqual([
      { value: { width: 390, height: 844, scale: 3 }, label: 'size=390x844@3' },
      { value: { width: 360, height: 640 }, label: 'size=360x640' },
    ]);
    expect(parseSizeList('390x844@0')).toMatchObject({ error: expect.any(String) });
  });

  it('enumerates every combination, labelled by the axes that vary', () => {
    const combos = gridCombos({
      seed: [
        { value: 1, label: 'seed=1' },
        { value: 2, label: 'seed=2' },
      ],
      locale: [
        { value: 'ru', label: 'locale=ru' },
        { value: 'en', label: 'locale=en' },
      ],
      size: [{ value: { width: 390, height: 844 }, label: 'size=390x844' }],
    });
    expect(combos.map(combo => combo.label)).toEqual([
      'locale=ru seed=1',
      'locale=ru seed=2',
      'locale=en seed=1',
      'locale=en seed=2',
    ]);
    expect(combos[3]).toMatchObject({ seed: 2, locale: 'en', size: { width: 390, height: 844 } });
    expect(gridCombos({})).toEqual([{ index: 0, label: 'run' }]);
  });

  it('aggregates numbers (min/median/p90/max) and the shares of strings and booleans', () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
      run(
        n % 4 === 0 ? 'fail' : 'pass',
        { score: n, result: n > 7 ? 'win' : 'lose', units: [1, 2] },
        n
      )
    );
    runs.push(run('error', null, 11));
    const aggregate = aggregateGrid(runs);
    expect(aggregate.runs).toBe(11);
    expect(aggregate.verdicts).toEqual({ error: 0.0909091, fail: 0.181818, pass: 0.727273 });
    expect(aggregate.numbers['gameState.score']).toEqual({
      n: 10,
      min: 1,
      median: 5.5,
      max: 10,
      p90: 9.1,
    });
    expect(aggregate.numbers['gameState.units.length']).toMatchObject({ min: 2, max: 2 });
    expect(aggregate.outcomes['gameState.result']).toEqual({ lose: 0.7, win: 0.3 });
    const lines = formatGridHuman(runs, aggregate);
    expect(lines[0]).toBe('grid: 11 run(s)');
    expect(lines).toContain('  gameState.result: lose 70%, win 30%');
  });

  it('runs at most N jobs at a time, results in job order', async () => {
    let running = 0;
    let peak = 0;
    const results = await runPool(5, 2, async index => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5 - index));
      running -= 1;
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });
});
