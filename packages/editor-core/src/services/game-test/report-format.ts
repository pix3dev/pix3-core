import type { Json } from '@/core/agent-introspection';

/* What the game-test tools put in a verdict: Json diffs, scalars and error text, one copy. */

/** Max scalar paths a game-snapshot diff reports (payload discipline). */
const MAX_GAME_DIFF_PATHS = 20;

const isPlainObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Short display form of a Json scalar for one-line verdicts. */
export const fmtScalar = (value: Json): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

/**
 * Dot-path diff between two Json snapshots down to `depth` object levels; scalar (and array)
 * leaves that differ become `path -> [before, after]`. Capped so a big game snapshot can't blow
 * up the tool payload. Shared by the input harness (`pix3_game_run` steps) and the test runner.
 */
export function diffJsonPaths(before: Json, after: Json, depth = 2): Record<string, [Json, Json]> {
  const out: Record<string, [Json, Json]> = {};
  const walk = (a: Json, b: Json, path: string, d: number): void => {
    if (Object.keys(out).length >= MAX_GAME_DIFF_PATHS) return;
    if (d > 0 && isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key] ?? null, b[key] ?? null, path ? `${path}.${key}` : key, d - 1);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[path || '(root)'] = [a, b];
    }
  };
  walk(before, after, '', depth);
  return out;
}

/** Error text for a note, without leaking a stack into a tool result. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
