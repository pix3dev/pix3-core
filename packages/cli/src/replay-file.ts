import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The CLI's side of `.pix3replay` files (`pix3 smoke --record/--replay`, `pix3 play
 * --record/--replay`): the build hash the header carries, the bits of the header a command needs
 * before the game runs, and what a divergence leaves on disk. The format itself — reading,
 * checking, recording and replaying — is the runtime's (`core/RunTape.ts`), run in the smoke worker
 * or on the page; this file only reads the header line.
 */

/** Folders a project's build does not come from. */
const SKIPPED = new Set(['node_modules', 'dist', '.git', '.pix3']);

/** A hash of the project's files (code, scenes, assets, manifest) — what the recording ran. */
export const projectHash = (root: string): string => {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(full);
      } else if (entry.isFile() && !entry.name.endsWith('.pix3replay')) {
        hash.update(relative(root, full).split(sep).join('/'));
        hash.update('\0');
        hash.update(readFileSync(full));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
};

/** A recording's text with the header's `build` set. */
export const stampBuild = (text: string, build: string): string => {
  const newline = text.indexOf('\n');
  const header = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as Record<string, unknown>;
  return `${JSON.stringify({ ...header, build })}${newline < 0 ? '' : text.slice(newline)}`;
};

export interface ReplayFileHeader {
  readonly scene: string;
  readonly build: string | null;
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  /** The last recorded tick (0 when the file has no readable end line: the runtime says why). */
  readonly end: number;
}

/** Read a recording's header (and end) for the command; the runtime checks the rest. */
export const readReplayFile = (
  path: string
): { text: string; header: ReplayFileHeader } | { error: string } => {
  if (!existsSync(path)) return { error: `no file ${path}` };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter(line => line.trim() !== '');
  let header: Record<string, unknown> | null = null;
  try {
    header = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  } catch {
    header = null;
  }
  const viewport = header?.viewport as ReplayFileHeader['viewport'] | undefined;
  if (
    header?.type !== 'header' ||
    typeof header.scene !== 'string' ||
    !viewport ||
    !(viewport.width > 0 && viewport.height > 0 && viewport.dpr > 0)
  ) {
    return {
      error: `${path} is not a Pix3 recording: its first line is not a header with a scene and a viewport`,
    };
  }
  let end = 0;
  try {
    const last = JSON.parse(lines.at(-1) ?? '') as { type?: unknown; tick?: unknown };
    if (last.type === 'end' && typeof last.tick === 'number') end = last.tick;
  } catch {
    end = 0;
  }
  return {
    text,
    header: {
      scene: header.scene,
      build: typeof header.build === 'string' ? header.build : null,
      viewport,
      end,
    },
  };
};

/** A replay's outcome, as the runtime reports it (`RunTapeReplayResult`). */
export interface ReplayOutcome {
  readonly ok: boolean;
  readonly ticks: number;
  readonly end: number;
  readonly checkpoints: number;
  readonly divergence: {
    readonly from: number;
    readonly to: number;
    readonly paths: readonly string[];
    readonly morePaths: number;
    readonly likelyLoad: boolean;
    readonly recorded?: unknown;
    readonly replayed?: unknown;
  } | null;
  readonly stopped: string | null;
  readonly notes: readonly string[];
}

/** What a report carries: the snapshots moved to files beside the recording, and the build check. */
export interface ReplayReport extends ReplayOutcome {
  readonly file: string;
  /** The recording was made on other project files than these (null when it does not say). */
  readonly buildChanged: boolean | null;
  /** On a divergence: the two checkpoints, written next to the recording. */
  readonly snapshots?: { readonly recorded: string; readonly replayed: string };
  /** `pix3 play --replay`: the page at the divergence. */
  readonly screenshot?: string;
}

export const settleReplay = (
  outcome: ReplayOutcome,
  file: string,
  header: ReplayFileHeader,
  build: string
): ReplayReport => {
  const { divergence } = outcome;
  const buildChanged = header.build === null ? null : header.build !== build;
  if (!divergence) return { ...outcome, file, buildChanged };
  const base = file.replace(/\.pix3replay$/, '');
  const snapshots = {
    recorded: `${base}.tick-${divergence.to}.recorded.json`,
    replayed: `${base}.tick-${divergence.to}.replayed.json`,
  };
  writeFileSync(snapshots.recorded, `${JSON.stringify(divergence.recorded, null, 2)}\n`);
  writeFileSync(snapshots.replayed, `${JSON.stringify(divergence.replayed, null, 2)}\n`);
  const { recorded: _recorded, replayed: _replayed, ...rest } = divergence;
  return { ...outcome, divergence: rest, file, buildChanged, snapshots };
};

export const formatReplayHuman = (replay: ReplayReport): string[] => {
  const lines: string[] = [];
  const { divergence } = replay;
  if (divergence) {
    lines.push(
      `replay ${replay.file}: DIVERGED between tick ${divergence.from} and ${divergence.to}${divergence.likelyLoad ? ' (likely load timing: a load or a scene change in that interval)' : ''}`
    );
    lines.push(
      `  differs at: ${divergence.paths.join(', ')}${divergence.morePaths ? ` … and ${divergence.morePaths} more` : ''}`
    );
    if (replay.snapshots)
      lines.push(`  snapshots: ${replay.snapshots.recorded}, ${replay.snapshots.replayed}`);
    if (replay.screenshot) lines.push(`  screenshot: ${replay.screenshot}`);
    if (divergence.to - divergence.from > 1)
      lines.push('  for the exact tick, record again with --every 1');
  } else if (replay.stopped) {
    lines.push(
      `replay ${replay.file}: STOPPED at tick ${replay.ticks} of ${replay.end} — ${replay.stopped}`
    );
  } else {
    lines.push(
      `replay ${replay.file}: MATCH — ${replay.ticks} tick(s), ${replay.checkpoints} checkpoint(s)`
    );
  }
  if (replay.buildChanged)
    lines.push('  note: the recording was made on other project files (build hash differs)');
  for (const note of replay.notes) lines.push(`  note: ${note}`);
  return lines;
};
