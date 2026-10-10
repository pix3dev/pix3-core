import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';

/**
 * `pix3 gap "<summary>"` (plan §G.3 «Чего не хватает?», §G.4 item 1): the coding agent records
 * what Pix3 did not have when it needed it — a capability, a bridge tool, a node type, a doc —
 * so the gaps of real sessions can be counted. Append-only JSONL in the project,
 * `.pix3/gaps.jsonl`, one object per line:
 *
 *   {ts, agent?, kind, summary, detail?, context?}
 *
 * A CLI command, not a bridge tool: every coding agent has a shell, it works without the editor
 * open (and on a Remote SSH host, where the project is), and the bridge's tool table stays what
 * the editor does (decision A25 in `.plans/agent-bridge.md`). `pix3 gap --list` reads it back.
 */

export const GAPS_FILE = join('.pix3', 'gaps.jsonl');
/** What was missing. The kit lists exactly these (drift spec in `kit.spec.ts`). */
export const GAP_KINDS = ['capability', 'tool', 'node', 'doc', 'other'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

const SUMMARY_MAX = 200;
const DETAIL_MAX = 4000;
const CONTEXT_MAX = 500;

export interface Gap {
  readonly ts: string;
  readonly agent?: string;
  readonly kind: GapKind;
  readonly summary: string;
  readonly detail?: string;
  readonly context?: string;
}

export interface GapIo {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
}

interface GapArgs {
  readonly list: boolean;
  readonly json: boolean;
  readonly summary?: string;
  readonly kind: GapKind;
  readonly detail?: string;
  readonly context?: string;
  readonly agent?: string;
  readonly projectDir?: string;
}

const isKind = (value: string): value is GapKind =>
  (GAP_KINDS as readonly string[]).includes(value);

export const parseGapArgs = (argv: readonly string[]): GapArgs | { error: string } => {
  const out: { -readonly [K in keyof GapArgs]: GapArgs[K] } = {
    list: false,
    json: false,
    kind: 'other',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | { error: string } => {
      const next = argv[++i];
      return next === undefined ? { error: `${arg} needs a value` } : next;
    };
    if (arg === '--list') out.list = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--kind' || arg === '--detail' || arg === '--context' || arg === '--agent') {
      const v = value();
      if (typeof v !== 'string') return v;
      if (arg === '--kind') {
        if (!isKind(v)) return { error: `--kind is one of ${GAP_KINDS.join(', ')}, not "${v}"` };
        out.kind = v;
      } else out[arg.slice(2) as 'detail' | 'context' | 'agent'] = v;
    } else if (arg === '--project') {
      const v = value();
      if (typeof v !== 'string') return v;
      out.projectDir = v;
    } else if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    else if (out.summary === undefined) out.summary = arg;
    else return { error: 'one summary only — quote it ("…"); put the rest in --detail' };
  }
  return out;
};

/** The coding agent running this, when its environment says so. */
export const detectAgent = (env: NodeJS.ProcessEnv): string | undefined => {
  if (env.CLAUDECODE === '1') return 'claude-code';
  if (Object.keys(env).some(key => key.startsWith('CODEX_'))) return 'codex';
  return undefined;
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The record for `args`, or why it cannot be one. */
export const buildGap = (
  args: GapArgs,
  env: NodeJS.ProcessEnv,
  now: Date
): Gap | { error: string } => {
  const summary = oneLine(args.summary ?? '');
  if (!summary) return { error: 'say what was missing: pix3 gap "<summary>" --kind <kind>' };
  if (summary.length > SUMMARY_MAX) {
    return {
      error: `the summary is one line of at most ${SUMMARY_MAX} characters; put the rest in --detail`,
    };
  }
  if ((args.detail?.length ?? 0) > DETAIL_MAX)
    return { error: `--detail is at most ${DETAIL_MAX} characters` };
  const context = args.context === undefined ? undefined : oneLine(args.context);
  if ((context?.length ?? 0) > CONTEXT_MAX)
    return { error: `--context is at most ${CONTEXT_MAX} characters` };
  const agent = args.agent ?? detectAgent(env);
  return {
    ts: now.toISOString(),
    ...(agent ? { agent } : {}),
    kind: args.kind,
    summary,
    ...(args.detail?.trim() ? { detail: args.detail.trim() } : {}),
    ...(context ? { context } : {}),
  };
};

/** Every well-formed record of the file, oldest first (a broken line is skipped). */
export const readGaps = (root: string): Gap[] => {
  let text: string;
  try {
    text = readFileSync(join(root, GAPS_FILE), 'utf8');
  } catch {
    return [];
  }
  const out: Gap[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const gap = JSON.parse(line) as Gap;
      if (typeof gap.summary === 'string' && typeof gap.kind === 'string') out.push(gap);
    } catch {
      // a torn or hand-edited line
    }
  }
  return out;
};

export const runGapCli = (argv: readonly string[], io: GapIo): number => {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(COMMAND_USAGE.gap);
    return 0;
  }
  const parsed = parseGapArgs(argv);
  if ('error' in parsed) {
    io.stderr(`pix3 gap: ${parsed.error}\n\n${COMMAND_USAGE.gap}`);
    return 1;
  }
  const start = parsed.projectDir ? resolve(io.cwd, parsed.projectDir) : io.cwd;
  const root = parsed.projectDir ? start : findProjectRoot(start);
  if (!root || !existsSync(join(root, PROJECT_MANIFEST_FILE))) {
    io.stderr(`pix3 gap: no ${PROJECT_MANIFEST_FILE} in ${start} or any parent folder.\n`);
    return 2;
  }
  if (parsed.list) {
    const gaps = readGaps(root);
    if (parsed.json) io.stdout(`${JSON.stringify(gaps, null, 2)}\n`);
    else if (!gaps.length) io.stdout(`No gaps recorded (${GAPS_FILE}).\n`);
    else {
      for (const gap of gaps) {
        io.stdout(
          `${gap.ts}  ${gap.kind.padEnd(10)} ${gap.agent ? `[${gap.agent}] ` : ''}${gap.summary}\n`
        );
      }
    }
    return 0;
  }
  const gap = buildGap(parsed, io.env ?? process.env, (io.now ?? (() => new Date()))());
  if ('error' in gap) {
    io.stderr(`pix3 gap: ${gap.error}\n`);
    return 1;
  }
  const path = join(root, GAPS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  // One write of one line with O_APPEND: concurrent agents never interleave within a record.
  appendFileSync(path, `${JSON.stringify(gap)}\n`);
  io.stdout(
    parsed.json
      ? `${JSON.stringify(gap)}\n`
      : `Recorded in ${GAPS_FILE}: [${gap.kind}] ${gap.summary}\n`
  );
  return 0;
};
