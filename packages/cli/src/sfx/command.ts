import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';
import {
  encodeWav16,
  mutateSfx,
  renderSfx,
  resolveSfx,
  SAMPLE_RATE,
  SFX_PRESET_NAMES,
  type SfxParams,
} from './synth.ts';

/**
 * `pix3 sfx <preset|"text"> [--out audio/x.wav] [--seed n] [--json]` — a sound effect without the
 * editor. Offline, no network, no key, no native module; see `synth.ts`.
 */

export type SfxIo = CliIo;

export interface SfxResult {
  /** As written, relative to the current folder, forward slashes. */
  readonly path: string;
  /** `res://…` when the file landed inside a Pix3 project, else null. */
  readonly res: string | null;
  readonly durationMs: number;
  readonly preset: string;
  readonly seed: number | null;
  readonly modifiers: readonly string[];
  readonly bytes: number;
  readonly peak: number;
  readonly params: SfxParams;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

const roundedParams = (params: SfxParams): SfxParams => {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'number' ? round(value) : value;
  }
  return out as unknown as SfxParams;
};

interface SfxArgs {
  readonly text: string;
  readonly out?: string;
  readonly seed: number | null;
  readonly json: boolean;
}

type Parsed = SfxArgs | { readonly help: true } | { readonly error: string; readonly usage?: true };

/** `--help` answers wherever it stands, unless an argument before it was already wrong. */
const parseSfxArgs = (argv: readonly string[]): Parsed => {
  let text: string | undefined;
  let out: string | undefined;
  let seedText: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      json = true;
    } else if (arg === '--out' || arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value.` };
      if (arg === '--out') out = value;
      else seedText = value;
      i++;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice(6);
    } else if (arg.startsWith('--seed=')) {
      seedText = arg.slice(7);
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}.`, usage: true };
    } else {
      text = text === undefined ? arg : `${text} ${arg}`;
    }
  }
  if (text === undefined || text.trim() === '') return { error: 'say which sound.', usage: true };
  let seed: number | null = null;
  if (seedText !== undefined) {
    const parsed = Number(seedText);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
      return { error: `--seed takes a whole number 0..4294967295, not "${seedText}".` };
    }
    seed = parsed;
  }
  if (out !== undefined && !/\.wav$/i.test(out)) {
    return { error: `--out must end in .wav (the only format this writes), got "${out}".` };
  }
  return { text, out, seed, json };
};

/** Render the sound and write the WAV: `--out`, else `audio/<preset>.wav` of the project (or cwd). */
const writeSfx = (args: SfxArgs, cwd: string): SfxResult | { readonly error: string } => {
  const resolved = resolveSfx(args.text);
  if (!resolved) {
    return {
      error: `"${args.text}" names no preset. Use one of ${SFX_PRESET_NAMES.join(', ')}, or words like "coin pickup", "big explosion", "button click".`,
    };
  }
  const { seed } = args;
  const params = seed === null ? resolved.params : mutateSfx(resolved.params, seed);
  const samples = renderSfx(params, seed ?? 1);
  const wav = encodeWav16(samples);
  const target =
    args.out !== undefined
      ? resolve(cwd, args.out)
      : resolve(findProjectRoot(cwd) ?? cwd, 'audio', `${resolved.preset}.wav`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wav);

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const root = findProjectRoot(dirname(target));
  const inProject = root ? relative(root, target) : null;
  return {
    path: relative(cwd, target).split(sep).join('/'),
    res:
      inProject && !inProject.startsWith('..') ? `res://${inProject.split(sep).join('/')}` : null,
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    preset: resolved.preset,
    seed,
    modifiers: resolved.modifiers,
    bytes: wav.byteLength,
    peak: round(peak, 3),
    params: roundedParams(params),
  };
};

const formatSfxHuman = (result: SfxResult): string => {
  const how = [
    result.modifiers.length > 0 ? result.modifiers.join(' ') : null,
    result.seed !== null ? `seed ${result.seed}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    `wrote ${result.path}  ${result.preset}${how ? ` (${how})` : ''}, ${result.durationMs} ms, ${(result.bytes / 1024).toFixed(1)} KiB` +
    `${result.res ? `\n  use it as ${result.res}` : ''}\n`
  );
};

export const runSfx = (argv: readonly string[], io: SfxIo): number => {
  const args = parseSfxArgs(argv);
  if ('help' in args) {
    io.stdout(COMMAND_USAGE.sfx);
    return 0;
  }
  if ('error' in args) {
    io.stderr(`pix3 sfx: ${args.error}\n${args.usage ? `\n${COMMAND_USAGE.sfx}` : ''}`);
    return 2;
  }
  const result = writeSfx(args, io.cwd);
  if ('error' in result) {
    io.stderr(`pix3 sfx: ${result.error}\n`);
    return 2;
  }
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatSfxHuman(result));
  return 0;
};
