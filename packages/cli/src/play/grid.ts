/**
 * The run grid of `pix3 play` (and of `pix3 smoke` with a bot): list values for `--seed 1..50`,
 * `--config`, `--bot-args`, `--size`, `--locale`, `--storage` make one run per combination, each a
 * fresh load; the report is a row per combination and an aggregate over the game's
 * `registerGameDebug` snapshots — min / median / max / p90 of every number, the share of every
 * value of a string or boolean — which `--golden` pins (`gridGoldenOf`). {@link runGrid} is the
 * whole grid but the run itself, which each command brings (a page in Chrome, a worker in Node).
 * No imports from the runtime: both commands load this file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CliIo } from '../io.ts';
import type { SmokeAnalytics } from '../smoke/report.ts';
import {
  diffGolden,
  formatGoldenHuman,
  goldenFailed,
  goldenOf,
  gridGoldenOf,
  settleGolden,
  type GoldenArgs,
  type readGolden,
} from '../golden.ts';

/** One axis value as the command line gave it, and the label the table shows. */
export interface GridValue<T> {
  readonly value: T;
  readonly label: string;
}

/** The axes; an absent axis is the single-run value (no label). */
export interface GridAxes {
  readonly seed?: readonly GridValue<number>[];
  readonly config?: readonly GridValue<Record<string, unknown>>[];
  readonly botArgs?: readonly GridValue<Record<string, unknown>>[];
  readonly size?: readonly GridValue<{ width: number; height: number; scale?: number }>[];
  readonly locale?: readonly GridValue<string>[];
  readonly storage?: readonly GridValue<unknown>[];
}

export type GridAxis = keyof GridAxes;

/** One combination: a value per given axis, and its label (`seed=3 locale=ru`). */
export interface GridCombo {
  readonly index: number;
  readonly label: string;
  readonly seed?: number;
  readonly config?: Record<string, unknown>;
  readonly botArgs?: Record<string, unknown>;
  readonly size?: { width: number; height: number; scale?: number };
  readonly locale?: string;
  readonly storage?: unknown;
}

/** The axis order of a combination's label and of the enumeration (the last varies fastest). */
const AXES: readonly GridAxis[] = ['config', 'botArgs', 'size', 'locale', 'storage', 'seed'];

/** A grid worth the name: some axis has more than one value. */
export const isGrid = (axes: GridAxes): boolean => AXES.some(axis => (axes[axis]?.length ?? 0) > 1);

/** Every combination, in a stable order. */
export const gridCombos = (axes: GridAxes): GridCombo[] => {
  let combos: Array<Record<string, unknown> & { labels: string[] }> = [{ labels: [] }];
  for (const axis of AXES) {
    const values = axes[axis] as readonly GridValue<unknown>[] | undefined;
    if (!values || values.length === 0) continue;
    const named = values.length > 1;
    combos = combos.flatMap(combo =>
      values.map(entry => ({
        ...combo,
        [axis]: entry.value,
        labels: named ? [...combo.labels, entry.label] : combo.labels,
      }))
    );
  }
  return combos.map(({ labels, ...combo }, index) => ({
    ...(combo as Omit<GridCombo, 'index' | 'label'>),
    index,
    label: labels.join(' ') || 'run',
  }));
};

/** `1..50`, `3,7,9` or `4` → the seeds, or the error line. */
export const parseSeedList = (text: string): GridValue<number>[] | { error: string } => {
  const error = { error: '--seed takes a whole number, a list 1,2,5 or a range 1..50' };
  const seeds: number[] = [];
  for (const part of text.split(',')) {
    const range = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (to < from || to - from > 10_000) return error;
      for (let seed = from; seed <= to; seed += 1) seeds.push(seed);
    } else if (/^\s*-?\d+\s*$/.test(part)) seeds.push(Number(part));
    else return error;
  }
  return seeds.map(seed => ({ value: seed, label: `seed=${seed}` }));
};

/** `390x844@3,360x640` → the sizes (the scale optional), or the error line. */
export const parseSizeList = (
  text: string
): GridValue<{ width: number; height: number; scale?: number }>[] | { error: string } => {
  const sizes: GridValue<{ width: number; height: number; scale?: number }>[] = [];
  for (const part of text.split(',')) {
    const match = /^\s*(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?\s*$/.exec(part);
    if (!match || (match[3] !== undefined && !(Number(match[3]) > 0))) {
      return {
        error:
          '--size takes WIDTHxHEIGHT in CSS px with an optional @scale, or a list: --size 390x844@3,360x640@2',
      };
    }
    sizes.push({
      value: {
        width: Number(match[1]),
        height: Number(match[2]),
        ...(match[3] !== undefined ? { scale: Number(match[3]) } : {}),
      },
      label: `size=${part.trim()}`,
    });
  }
  return sizes;
};

/** One JSON object, a list of them, or a file holding either; null when it is none of those. */
export const parseObjectList = (text: string): Record<string, unknown>[] | null => {
  let source = text.trim();
  if (!source.startsWith('{') && !source.startsWith('[')) {
    try {
      source = readFileSync(resolve(text), 'utf8');
    } catch {
      return null;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return list.length > 0 && list.every(isObject) ? list : null;
};

/** A JSON object's label: itself when short, else `<name>#<n>`. */
export const jsonLabel = (name: string, value: unknown, index: number): string => {
  const text = JSON.stringify(value);
  return text.length <= 40 ? `${name}=${text}` : `${name}#${index + 1}`;
};

/** The numeric shape of one combination's run, as the table and the aggregate read it. */
export interface GridRun {
  readonly combo: GridCombo;
  /** The run's verdict: `pass`, `fail`, `crash` (the policy threw), `error` (the page did). */
  readonly verdict: 'pass' | 'fail' | 'crash' | 'error';
  /** The bot's frame at the end, when a bot played. */
  readonly frames?: number;
  /** The game's `registerGameDebug` snapshot at the end, or null. */
  readonly game: unknown;
  /** What went wrong, in one line each. */
  readonly errors: readonly string[];
  /** `--check-determinism`: the paths the second run ended differently on (none = same). */
  readonly determinism?: { readonly same: boolean; readonly paths: readonly string[] };
}

export interface NumberStats {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly p90: number;
}

export interface GridAggregate {
  readonly runs: number;
  /** Share of each verdict over all runs. */
  readonly verdicts: Readonly<Record<string, number>>;
  /** Every number in the snapshots, by `gameState` path. */
  readonly numbers: Readonly<Record<string, NumberStats>>;
  /** Every string or boolean, by path: the share of each value over the runs that had it. */
  readonly outcomes: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Linear interpolation between the closest ranks (the spreadsheet PERCENTILE). */
const percentile = (sorted: readonly number[], q: number): number => {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};

/** Six significant digits: an aggregate must not differ in the 15th digit between machines. */
const round = (value: number): number => Number(value.toPrecision(6));

/**
 * Leaves of a snapshot by path (`gameState.score.best`), objects only: an array's items by index
 * mean nothing across runs (a different count shifts them), so arrays count by their length.
 */
const leaves = (value: unknown, path: string, into: Map<string, unknown>): void => {
  if (Array.isArray(value)) into.set(`${path}.length`, value.length);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, into);
  } else into.set(path, value);
};

export const aggregateGrid = (runs: readonly GridRun[]): GridAggregate => {
  const share = (counts: Map<string, number>, total: number): Record<string, number> =>
    Object.fromEntries(
      [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => [key, round(n / total)])
    );
  const verdicts = new Map<string, number>();
  const numbers = new Map<string, number[]>();
  const values = new Map<string, Map<string, number>>();
  for (const run of runs) {
    verdicts.set(run.verdict, (verdicts.get(run.verdict) ?? 0) + 1);
    if (run.game === null || run.game === undefined) continue;
    const found = new Map<string, unknown>();
    leaves(run.game, 'gameState', found);
    for (const [path, leaf] of found) {
      if (typeof leaf === 'number' && Number.isFinite(leaf)) {
        numbers.set(path, [...(numbers.get(path) ?? []), leaf]);
      } else if (typeof leaf === 'string' || typeof leaf === 'boolean') {
        const counts = values.get(path) ?? new Map<string, number>();
        counts.set(String(leaf), (counts.get(String(leaf)) ?? 0) + 1);
        values.set(path, counts);
      }
    }
  }
  const byPath = <T>(map: Map<string, T>): [string, T][] =>
    [...map].sort(([a], [b]) => a.localeCompare(b));
  return {
    runs: runs.length,
    verdicts: share(verdicts, runs.length || 1),
    numbers: Object.fromEntries(
      byPath(numbers).map(([path, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        return [
          path,
          {
            n: sorted.length,
            min: round(sorted[0]),
            median: round(percentile(sorted, 0.5)),
            max: round(sorted[sorted.length - 1]),
            p90: round(percentile(sorted, 0.9)),
          },
        ];
      })
    ),
    outcomes: Object.fromEntries(
      byPath(values).map(([path, counts]) => {
        const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
        return [path, share(counts, total)];
      })
    ),
  };
};

const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;

/** The table and the aggregate, for people. */
export const formatGridHuman = (runs: readonly GridRun[], aggregate: GridAggregate): string[] => {
  const width = Math.max(...runs.map(run => run.combo.label.length), 3);
  const lines = [`grid: ${runs.length} run(s)`];
  for (const run of runs) {
    const state = run.game === null || run.game === undefined ? '' : JSON.stringify(run.game);
    const same = run.determinism
      ? run.determinism.same
        ? ' same-twice'
        : ` DIFFERS-TWICE (${run.determinism.paths.slice(0, 3).join(', ')}${run.determinism.paths.length > 3 ? ', …' : ''})`
      : '';
    lines.push(
      `  ${run.combo.label.padEnd(width)}  ${run.verdict.toUpperCase().padEnd(5)}${run.frames !== undefined ? ` f${run.frames}` : ''}${same}  ${state.length > 100 ? `${state.slice(0, 99)}…` : state}`
    );
    for (const error of run.errors.slice(0, 3)) lines.push(`      error: ${error}`);
  }
  lines.push(
    `aggregate: ${Object.entries(aggregate.verdicts)
      .map(([verdict, share]) => `${verdict} ${percent(share)}`)
      .join(', ')}`
  );
  for (const [path, stats] of Object.entries(aggregate.numbers)) {
    lines.push(
      `  ${path}: min ${stats.min}, median ${stats.median}, p90 ${stats.p90}, max ${stats.max} (n=${stats.n})`
    );
  }
  for (const [path, shares] of Object.entries(aggregate.outcomes)) {
    lines.push(
      `  ${path}: ${Object.entries(shares)
        .map(([value, share]) => `${value} ${percent(share)}`)
        .join(', ')}`
    );
  }
  return lines;
};

/** Run `jobs` with at most `parallel` at a time; results in job order. */
export const runPool = async <T>(
  count: number,
  parallel: number,
  job: (index: number) => Promise<T>
): Promise<T[]> => {
  const results: T[] = new Array<T>(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next++;
      results[index] = await job(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, count) }, worker));
  return results;
};

/** One run of a combination, as the command played it. */
export interface GridPlay {
  readonly verdict: GridRun['verdict'];
  readonly frames?: number;
  readonly game: unknown;
  readonly analytics?: SmokeAnalytics;
  readonly errors: readonly string[];
}

/**
 * The grid: every combination played (`again` on the second play of `--check-determinism`, the
 * two ends compared by their golden paths), `parallel` at a time; a combination whose play throws
 * is that combination's error. Writes the table and the aggregate (or `--json`), settles
 * `--golden` over the aggregate, and answers the exit code: 1 when a run errored or crashed, a
 * combination ended differently twice or the golden differs — a lost round is a result.
 */
export const runGrid = async (options: {
  readonly combos: readonly GridCombo[];
  readonly parallel: number;
  readonly checkDeterminism: boolean;
  readonly play: (combo: GridCombo, again: boolean) => Promise<GridPlay>;
  readonly io: CliIo;
  readonly json: boolean;
  readonly golden: GoldenArgs | null;
  readonly goldenRead: Exclude<ReturnType<typeof readGolden>, { error: string }> | null;
}): Promise<number> => {
  const { combos, io } = options;
  const playCombo = async (combo: GridCombo): Promise<GridRun> => {
    const first = await options.play(combo, false);
    let determinism: GridRun['determinism'];
    if (options.checkDeterminism) {
      const second = await options.play(combo, true);
      const paths = diffGolden(
        goldenOf(first.game, first.analytics),
        goldenOf(second.game, second.analytics),
        new Map()
      ).map(diff => diff.path);
      determinism = { same: paths.length === 0, paths };
    }
    return {
      combo,
      verdict: first.verdict,
      ...(first.frames !== undefined ? { frames: first.frames } : {}),
      game: first.game,
      errors: first.errors,
      ...(determinism ? { determinism } : {}),
    };
  };
  const runs = await runPool(combos.length, options.parallel, index =>
    playCombo(combos[index]).catch(
      (error: Error): GridRun => ({
        combo: combos[index],
        verdict: 'error',
        game: null,
        errors: [error.message],
      })
    )
  );
  const aggregate = aggregateGrid(runs);
  const broken = runs.some(
    run => run.verdict === 'error' || run.verdict === 'crash' || run.determinism?.same === false
  );
  const goldenResult = options.golden
    ? settleGolden(options.golden, io.cwd, gridGoldenOf(aggregate), broken, options.goldenRead)
    : null;
  if (options.json) {
    const rows = runs.map(({ combo: { index: _index, label, ...axes }, ...run }) => ({
      label,
      ...axes,
      ...run,
      game: run.game ?? null,
    }));
    io.stdout(
      `${JSON.stringify(
        { runs: rows, aggregate, ...(goldenResult ? { golden: goldenResult } : {}) },
        null,
        2
      )}\n`
    );
  } else {
    const lines = formatGridHuman(runs, aggregate);
    if (goldenResult) lines.push(...formatGoldenHuman(goldenResult));
    io.stdout(`${lines.join('\n')}\n`);
  }
  return broken || goldenFailed(goldenResult) ? 1 : 0;
};
