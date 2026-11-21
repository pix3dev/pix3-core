import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { SmokeAnalytics } from './smoke/report.ts';

/**
 * `--golden <file.json> [--write] [--tolerance 'path=eps,…']` for `pix3 play` and `pix3 smoke`:
 * a seeded fixed-step run's end state pinned in a file and compared on every later run.
 *
 * The file is `{ "gameState": <the registerGameDebug snapshot>, "analytics": [{name, props}] }`.
 * Paths are the `gameState` predicate paths of `pix3_game_run` (`resolveJsonPath`: dot segments, a
 * number indexes an array) rooted at the file: `gameState.score.best`, `analytics.2.props.level`.
 * Arrays whose items all carry a unique scalar `id` are matched by it (order ignored; the path
 * names the golden's index, the entry the id). Equality is exact except under a `--tolerance`
 * path, which covers that path and everything below it, numbers only.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface GoldenArgs {
  readonly file: string;
  readonly write: boolean;
  /** Path → the largest allowed |expected − actual|. */
  readonly tolerance: ReadonlyMap<string, number>;
}

export interface GoldenDiff {
  readonly path: string;
  /** Absent: the golden has nothing here. */
  readonly expected?: Json;
  /** Absent: the run has nothing here. */
  readonly actual?: Json;
  /** The `id` an id-matched array item was paired by. */
  readonly id?: string | number;
}

export type GoldenResult =
  | { readonly file: string; readonly status: 'match' | 'written' }
  | {
      readonly file: string;
      readonly status: 'mismatch';
      readonly diffs: readonly GoldenDiff[];
      /** Differences past the reported ones. */
      readonly more?: number;
    }
  | { readonly file: string; readonly status: 'not-written'; readonly reason: string };

interface GoldenFile {
  readonly gameState: Json;
  /** `{ name, props }` per tracked event, in order. */
  readonly analytics: Json[];
}

/** Differences a result lists; the rest is counted. */
const MAX_DIFFS = 50;
const ROOTS = ['gameState', 'analytics'];

const isPlainObject = (value: unknown): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `--golden` / `--write` / `--tolerance` as given → the checked args, null without --golden. */
export const goldenArgsOf = (
  file: string | undefined,
  write: boolean,
  tolerance: string | undefined
): GoldenArgs | null | { error: string } => {
  if (file === undefined || file.startsWith('--')) {
    if (file !== undefined)
      return { error: '--golden needs a file: --golden design/tests/golden/round.json' };
    if (write || tolerance !== undefined)
      return { error: `${write ? '--write' : '--tolerance'} goes with --golden <file.json>` };
    return null;
  }
  const map = new Map<string, number>();
  for (const part of (tolerance ?? '').split(',').filter(item => item.trim())) {
    const match = /^\s*([^=\s]+)\s*=\s*(\S+)\s*$/.exec(part);
    const eps = Number(match?.[2]);
    if (!match || !Number.isFinite(eps) || eps < 0 || !ROOTS.includes(match[1].split('.')[0])) {
      return {
        error: `--tolerance takes path=eps pairs under gameState or analytics, e.g. --tolerance 'gameState.score.avg=0.01,gameState.units=0.5' (got ${part.trim()})`,
      };
    }
    map.set(match[1], eps);
  }
  return { file, write, tolerance: map };
};

/** The golden to compare with, read before the run; an error line when it cannot be. */
export const readGolden = (args: GoldenArgs, cwd: string): GoldenFile | { error: string } => {
  const path = resolve(cwd, args.file);
  if (!existsSync(path))
    return {
      error: `no golden ${args.file} — record one first with --golden ${args.file} --write`,
    };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { error: `${args.file} is not JSON: ${(error as Error).message}` };
  }
  if (!isPlainObject(data) || !('gameState' in data) || !Array.isArray(data.analytics ?? [])) {
    return {
      error: `${args.file} is not a golden: { "gameState": …, "analytics": [{ "name", "props" }] } (write one with --write)`,
    };
  }
  return {
    gameState: data.gameState,
    analytics: (data.analytics ?? []) as Json[],
  };
};

/** What a run is pinned by: its end snapshot and, in order, the events it tracked (no frames). */
export const goldenOf = (gameState: unknown, analytics: SmokeAnalytics | undefined): GoldenFile =>
  JSON.parse(
    JSON.stringify({
      gameState: gameState ?? null,
      analytics: (analytics?.events ?? []).map(event => ({ name: event.name, props: event.props })),
    })
  ) as GoldenFile;

/** The id an array is matched by: every item an object with a unique string or number `id`. */
const idsOf = (items: readonly Json[]): (string | number)[] | null => {
  const ids = items.map(item =>
    isPlainObject(item) && (typeof item.id === 'string' || typeof item.id === 'number')
      ? item.id
      : null
  );
  if (ids.length === 0 || ids.some(id => id === null)) return null;
  return new Set(ids).size === ids.length ? (ids as (string | number)[]) : null;
};

/** Every difference between the golden and the run, in walk order. */
export const diffGolden = (
  expected: GoldenFile,
  actual: GoldenFile,
  tolerance: ReadonlyMap<string, number>
): GoldenDiff[] => {
  const diffs: GoldenDiff[] = [];
  const epsilonAt = (path: string): number | undefined => {
    let best: string | undefined;
    for (const key of tolerance.keys()) {
      if ((path === key || path.startsWith(`${key}.`)) && key.length > (best?.length ?? -1))
        best = key;
    }
    return best === undefined ? undefined : tolerance.get(best);
  };
  const walk = (
    a: Json | undefined,
    b: Json | undefined,
    path: string,
    id?: string | number
  ): void => {
    const tag = id === undefined ? {} : { id };
    if (a === undefined || b === undefined) {
      diffs.push({
        path,
        ...(a !== undefined ? { expected: a } : {}),
        ...(b !== undefined ? { actual: b } : {}),
        ...tag,
      });
      return;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) > (epsilonAt(path) ?? 0))
        diffs.push({ path, expected: a, actual: b, ...tag });
      return;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], `${path}.${key}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const idsA = idsOf(a);
      const idsB = idsOf(b);
      if (idsA && idsB) {
        idsA.forEach((key, index) => {
          const at = idsB.indexOf(key);
          walk(a[index], at < 0 ? undefined : b[at], `${path}.${index}`, key);
        });
        idsB.forEach((key, index) => {
          if (!idsA.includes(key)) walk(undefined, b[index], `${path}.${index}`, key);
        });
        return;
      }
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        walk(a[index], b[index], `${path}.${index}`);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push({ path, expected: a, actual: b, ...tag });
  };
  walk(expected.gameState, actual.gameState, 'gameState');
  walk(expected.analytics, actual.analytics, 'analytics');
  return diffs;
};

/**
 * After the run: `--write` records it (only a clean run with something to pin), else it is
 * compared with `golden` (read by `readGolden` before the run).
 */
export const settleGolden = (
  args: GoldenArgs,
  cwd: string,
  run: GoldenFile,
  runFailed: boolean,
  golden: GoldenFile | null
): GoldenResult => {
  if (args.write) {
    if (runFailed) return { file: args.file, status: 'not-written', reason: 'the run failed' };
    if (run.gameState === null && run.analytics.length === 0) {
      return {
        file: args.file,
        status: 'not-written',
        reason: 'nothing to pin: the game has no registerGameDebug snapshot and tracked no event',
      };
    }
    const path = resolve(cwd, args.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
    return { file: args.file, status: 'written' };
  }
  const diffs = diffGolden(golden ?? { gameState: null, analytics: [] }, run, args.tolerance);
  if (diffs.length === 0) return { file: args.file, status: 'match' };
  return {
    file: args.file,
    status: 'mismatch',
    diffs: diffs.slice(0, MAX_DIFFS),
    ...(diffs.length > MAX_DIFFS ? { more: diffs.length - MAX_DIFFS } : {}),
  };
};

const shown = (value: Json | undefined): string => {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

/** The report lines: a verdict, then `path: expected → actual` per difference. */
export const formatGoldenHuman = (result: GoldenResult): string[] => {
  if (result.status === 'not-written')
    return [`golden: NOT WRITTEN ${result.file} — ${result.reason}`];
  if (result.status !== 'mismatch')
    return [`golden: ${result.status.toUpperCase()} ${result.file}`];
  const total = result.diffs.length + (result.more ?? 0);
  return [
    `golden: MISMATCH ${result.file} — ${total} path(s) differ (expected → actual)`,
    ...result.diffs.map(
      diff =>
        `  ${diff.path}${diff.id !== undefined ? ` (id ${JSON.stringify(diff.id)})` : ''}: ${shown(diff.expected)} → ${shown(diff.actual)}`
    ),
    ...(result.more ? [`  … ${result.more} more`] : []),
  ];
};

/** A golden that mismatched, or one asked to be written and refused, fails the command. */
export const goldenFailed = (result: GoldenResult | null): boolean =>
  result !== null && (result.status === 'mismatch' || result.status === 'not-written');
