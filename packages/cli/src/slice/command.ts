import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { decodePng, encodePng, type RgbaImage } from '../image/png.ts';
import {
  clearHaze,
  contentBox,
  crop,
  extractBlob,
  findBlobs,
  flatBackground,
  frameBlobs,
  gridCells,
  hasTransparency,
  keyOut,
  placeOnCanvas,
  readingOrder,
  SOLID_ALPHA,
  type Box,
} from '../image/sheet.ts';
import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';

/**
 * `pix3 slice <sheet.png> --grid CxR | --blobs …` — a generated sheet cut into frame PNGs, in
 * reading order; `--anim <slug>` also writes (or updates one clip of) a sequence-mode
 * `.pix3anim`. Plain Node: the PNG codec is `../image/png.ts`, the pixel rules `../image/sheet.ts`.
 */

interface SliceArgs {
  readonly sheet: string;
  readonly grid: { readonly cols: number; readonly rows: number } | null;
  /** `auto`: alpha when the sheet has it, else the border colour; or an explicit `#rrggbb`. */
  readonly key: 'auto' | readonly [number, number, number];
  readonly join: number;
  readonly count?: number;
  readonly names?: readonly string[];
  readonly pad: number;
  readonly out?: string;
  readonly anim?: string;
  readonly clip?: string;
  readonly fps: number;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

type Parsed = SliceArgs | { readonly help: true } | { readonly error: string };

const VALUE_FLAGS = new Set([
  'grid',
  'key',
  'join',
  'count',
  'names',
  'pad',
  'out',
  'anim',
  'clip',
  'fps',
]);
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

const wholeNumber = (text: string, min: number, max: number): number | null => {
  const value = Number(text);
  return /^\d+$/.test(text) && value >= min && value <= max ? value : null;
};

const parseSliceArgs = (argv: readonly string[]): Parsed => {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') return { error: `--${name} needs a value.` };
      values.set(name, value);
    } else if (['blobs', 'force', 'dry-run', 'json'].includes(name) && eq < 0) {
      switches.add(name);
    } else {
      return { error: `unknown option ${arg}.` };
    }
  }
  if (positionals.length !== 1) return { error: 'name one sheet PNG.' };
  const gridText = values.get('grid');
  if ((gridText === undefined) === !switches.has('blobs')) {
    return { error: 'say how to cut: --grid <cols>x<rows> or --blobs.' };
  }
  let grid: SliceArgs['grid'] = null;
  if (gridText !== undefined) {
    const match = /^(\d+)x(\d+)$/i.exec(gridText);
    const cols = match ? wholeNumber(match[1], 1, 256) : null;
    const rows = match ? wholeNumber(match[2], 1, 256) : null;
    if (cols === null || rows === null) {
      return { error: `--grid takes <cols>x<rows> (1..256 each), not "${gridText}".` };
    }
    grid = { cols, rows };
    for (const blobOnly of ['join', 'count', 'names']) {
      if (values.has(blobOnly)) return { error: `--${blobOnly} goes with --blobs, not --grid.` };
    }
  }
  const keyText = values.get('key') ?? 'auto';
  let key: SliceArgs['key'] = 'auto';
  if (keyText !== 'auto') {
    const hex = /^#?([0-9a-f]{6})$/i.exec(keyText);
    if (!hex) return { error: `--key takes auto or #rrggbb, not "${keyText}".` };
    const n = parseInt(hex[1], 16);
    key = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const numberFlag = (
    name: string,
    fallback: number,
    min: number,
    max: number
  ): number | string => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    return (
      wholeNumber(text, min, max) ?? `--${name} takes a whole number ${min}..${max}, not "${text}".`
    );
  };
  const join = numberFlag('join', 10, 0, 500);
  const pad = numberFlag('pad', 2, 0, 256);
  const fps = numberFlag('fps', 12, 1, 120);
  const countValue = values.has('count') ? numberFlag('count', 0, 1, 10000) : undefined;
  for (const value of [join, pad, fps, countValue])
    if (typeof value === 'string') return { error: value };
  const names = values
    .get('names')
    ?.split(',')
    .map(name => name.trim());
  if (names && names.some(name => !SLUG.test(name))) {
    return { error: '--names takes file names a-z, 0-9, - and _, comma-separated.' };
  }
  if (names && countValue !== undefined && countValue !== names.length) {
    return { error: `--count ${countValue} disagrees with ${names.length} --names.` };
  }
  const anim = values.get('anim');
  const clip = values.get('clip');
  for (const [flag, slug] of [
    ['anim', anim],
    ['clip', clip],
  ] as const) {
    if (slug !== undefined && !SLUG.test(slug)) {
      return { error: `--${flag} takes a-z, 0-9, - and _ (it names files), not "${slug}".` };
    }
  }
  if (anim !== undefined && names) return { error: '--names and --anim exclude each other.' };
  if (anim === undefined && (clip !== undefined || values.has('fps'))) {
    return { error: '--clip and --fps go with --anim.' };
  }
  return {
    sheet: positionals[0],
    grid,
    key,
    join: join as number,
    count: names?.length ?? (countValue as number | undefined),
    names,
    pad: pad as number,
    out: values.get('out'),
    anim,
    clip,
    fps: fps as number,
    force: switches.has('force'),
    dryRun: switches.has('dry-run'),
    json: switches.has('json'),
  };
};

export interface SliceFrame {
  /** As written, relative to the current folder, forward slashes. */
  readonly file: string;
  /** Where the frame's content was taken from on the sheet. */
  readonly box: Box;
  readonly width: number;
  readonly height: number;
}

export interface SliceResult {
  readonly sheet: string;
  readonly mode: 'grid' | 'blobs';
  /** `alpha` (the sheet's own transparency), the `#rrggbb` keyed out, or `none`. */
  readonly key: string;
  readonly frames: SliceFrame[];
  /** The `.pix3anim` written (relative to the current folder), with --anim. */
  readonly anim: string | null;
  readonly warnings: string[];
  readonly written: boolean;
}

class SliceError extends Error {}

const hex = (rgb: readonly number[]): string =>
  `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

const toPosix = (path: string): string => path.split(sep).join('/');

/** Frames as images plus where they came from, before naming and layout. */
const cutFrames = (
  image: RgbaImage,
  args: SliceArgs,
  warnings: string[]
): { image: RgbaImage; box: Box }[] => {
  if (args.grid) {
    const frames: { image: RgbaImage; box: Box }[] = [];
    gridCells(image.width, image.height, args.grid.cols, args.grid.rows).forEach((cell, i) => {
      const frame = crop(image, cell);
      clearHaze(frame);
      if (contentBox(frame, SOLID_ALPHA)) frames.push({ image: frame, box: cell });
      else
        warnings.push(
          `cell ${i + 1} (row ${Math.floor(i / args.grid!.cols) + 1}) is empty — skipped`
        );
    });
    return frames;
  }
  const map = findBlobs(image, args.join);
  const kept = frameBlobs(map.blobs, { count: args.count });
  if (args.count !== undefined && kept.length < args.count) {
    throw new SliceError(
      `found ${kept.length} frames, expected ${args.count} — a lower --join keeps nearby pictures apart; check the key (--key).`
    );
  }
  const ordered = readingOrder(kept);
  const largest = Math.max(...ordered.map(blob => blob.solid));
  const frames: { image: RgbaImage; box: Box }[] = [];
  ordered.forEach((blob, i) => {
    const frame = extractBlob(image, map, blob);
    if (!frame) return;
    if (blob.solid < largest / 5) {
      warnings.push(
        `frame ${i + 1} at ${frame.box.x},${frame.box.y} is ${Math.round((blob.solid / largest) * 100)}% of the largest — a part of its neighbour? Raise --join to merge parts, or pass --count.`
      );
    }
    frames.push(frame);
  });
  return frames;
};

/** Every frame padded by `pad`; for an animation, all on one canvas sharing the bottom line. */
const layOut = (frames: readonly { image: RgbaImage }[], args: SliceArgs): RgbaImage[] => {
  if (args.grid) return frames.map(frame => frame.image);
  if (args.anim === undefined) {
    return frames.map(({ image }) =>
      crop(image, {
        x: -args.pad,
        y: -args.pad,
        width: image.width + 2 * args.pad,
        height: image.height + 2 * args.pad,
      })
    );
  }
  const width = Math.max(...frames.map(f => f.image.width)) + 2 * args.pad;
  const height = Math.max(...frames.map(f => f.image.height)) + 2 * args.pad;
  return frames.map(({ image }) => placeOnCanvas(image, width, height, args.pad));
};

interface AnimFile {
  version?: string;
  texturePath?: string;
  clips?: { name?: string }[];
}

/** The `.pix3anim` with this clip added, or replacing the clip of the same name. */
const animWithClip = (
  path: string,
  clip: {
    name: string;
    fps: number;
    frames: { texturePath: string; sourceSize: { width: number; height: number } }[];
  }
): AnimFile => {
  let resource: AnimFile = { version: '1.0.0', texturePath: '', clips: [] };
  if (existsSync(path)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // reported below
    }
    const clips = (parsed as AnimFile | null)?.clips;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (clips !== undefined && !Array.isArray(clips))
    ) {
      throw new SliceError(`${path} is not a .pix3anim JSON object — fix or delete it first.`);
    }
    resource = parsed as AnimFile;
    if (resource.texturePath) {
      throw new SliceError(
        `${path} is a spritesheet-mode resource; slice writes frame files (sequence mode).`
      );
    }
  }
  const clips = (resource.clips ?? []).filter(other => other.name !== clip.name);
  const at = (resource.clips ?? []).findIndex(other => other.name === clip.name);
  clips.splice(at < 0 ? clips.length : at, 0, clip);
  return { ...resource, clips };
};

const slice = (args: SliceArgs, cwd: string): SliceResult => {
  const sheetPath = resolve(cwd, args.sheet);
  let image: RgbaImage;
  try {
    image = decodePng(readFileSync(sheetPath));
  } catch (error) {
    throw new SliceError(
      `${args.sheet}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const warnings: string[] = [];
  let key = 'alpha';
  if (args.key !== 'auto') {
    keyOut(image, args.key, { near: 30, far: 78, fromBorder: false });
    key = hex(args.key);
  } else if (!hasTransparency(image)) {
    const background = flatBackground(image);
    if (background) {
      // The backdrop's own noise sets the threshold: a generator's flat fill varies by a few
      // units, and art close to it (a shadow on a dark backdrop) must survive.
      const near = Math.min(30, Math.max(8, Math.ceil(background.spread * 2) + 4));
      keyOut(image, background.color, { near, far: near + 24, fromBorder: true });
      key = hex(background.color);
    } else {
      key = 'none';
      warnings.push(
        'the sheet is opaque and its border is not one flat colour — nothing keyed out; --key #rrggbb names the background'
      );
    }
  }
  const cut = cutFrames(image, args, warnings);
  if (cut.length === 0) throw new SliceError(`no frames found on ${args.sheet} (key ${key}).`);
  const images = layOut(cut, args);

  const stem = basename(sheetPath, extname(sheetPath));
  const projectRoot = findProjectRoot(cwd);
  const dir = resolve(
    cwd,
    args.out ??
      (args.anim ? join(projectRoot ?? cwd, 'sprites', args.anim) : join(dirname(sheetPath), stem))
  );
  const clipName = args.clip ?? args.anim;
  const digits = args.anim ? 4 : Math.max(2, String(images.length).length);
  const files = images.map((_, i) =>
    join(
      dir,
      `${args.names?.[i] ?? `${clipName ?? stem}_${String(i + 1).padStart(digits, '0')}`}.png`
    )
  );
  const animPath = args.anim ? join(dir, `${args.anim}.pix3anim`) : null;
  let anim: AnimFile | null = null;
  if (animPath) {
    const root = findProjectRoot(dir);
    if (!root)
      throw new SliceError(
        `--anim needs the frames inside a Pix3 project (res:// paths); ${dir} is not.`
      );
    const res = (file: string): string => `res://${toPosix(relative(root, file))}`;
    anim = animWithClip(animPath, {
      name: clipName!,
      fps: args.fps,
      frames: images.map((frame, i) => ({
        texturePath: res(files[i]),
        sourceSize: { width: frame.width, height: frame.height },
      })),
    });
  }
  const existing = files.filter(file => existsSync(file));
  if (existing.length > 0 && !args.force && !args.dryRun) {
    throw new SliceError(
      `${existing.length} frame file(s) exist (${toPosix(relative(cwd, existing[0]))}${existing.length > 1 ? ', …' : ''}) — --force replaces them.`
    );
  }
  if (!args.dryRun) {
    mkdirSync(dir, { recursive: true });
    images.forEach((frame, i) => writeFileSync(files[i], encodePng(frame)));
    if (animPath && anim) writeFileSync(animPath, `${JSON.stringify(anim, null, 2)}\n`);
  }
  return {
    sheet: toPosix(relative(cwd, sheetPath)),
    mode: args.grid ? 'grid' : 'blobs',
    key,
    frames: images.map((frame, i) => ({
      file: toPosix(relative(cwd, files[i])),
      box: cut[i].box,
      width: frame.width,
      height: frame.height,
    })),
    anim: animPath ? toPosix(relative(cwd, animPath)) : null,
    warnings,
    written: !args.dryRun,
  };
};

const formatHuman = (result: SliceResult): string => {
  const lines = [
    `${result.written ? 'wrote' : 'would write'} ${result.frames.length} frame(s) from ${result.sheet} (${result.mode}, key ${result.key})`,
    ...result.frames.map(
      (f, i) =>
        `  ${String(i + 1).padStart(3)}. ${f.file}  ${f.width}x${f.height}  from ${f.box.x},${f.box.y} ${f.box.width}x${f.box.height}`
    ),
  ];
  if (result.anim) lines.push(`  animation ${result.anim}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  return `${lines.join('\n')}\n`;
};

export const runSliceCli = (argv: readonly string[], io: CliIo): number => {
  const args = parseSliceArgs(argv);
  if ('help' in args) {
    io.stdout(COMMAND_USAGE.slice);
    return 0;
  }
  if ('error' in args) {
    io.stderr(`pix3 slice: ${args.error}\n\n${COMMAND_USAGE.slice}`);
    return 2;
  }
  try {
    const result = slice(args, io.cwd);
    io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
    return 0;
  } catch (error) {
    if (!(error instanceof SliceError)) throw error;
    io.stderr(`pix3 slice: ${error.message}\n`);
    return 1;
  }
};
