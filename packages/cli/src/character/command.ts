import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';
import {
  CharacterCompileError,
  compileCharacter,
  readPngSize,
  scanNumberedSequences,
  type CharacterClipSpec,
  type CharacterCompileSpec,
  type CompiledCharacter,
  type SourceFrameFile,
} from './compiler.ts';

/**
 * `pix3 character-compile <spec> [--project <dir>] [--dry-run] [--force] [--json]` — a 2D
 * character (variant × state flipbook) from frame PNGs: one `.pix3anim` with clips named
 * `<variant>.<state>`, the frames copied beside it under the managed-sprite-folder names, and a
 * prefab whose root is an `AnimatedSprite2D` carrying `core:CharacterVisual2D` (plan §F.5 (в)).
 *
 * The spec file (YAML or JSON) names the clips; frame paths are relative to the spec file. Writes
 * are all or nothing: an existing file with other bytes is refused (exit 1, nothing written)
 * unless `--force`; a file that already has exactly these bytes is left alone.
 */

export interface CharacterCompileIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface Args {
  readonly spec?: string;
  readonly project?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

const parseArgs = (argv: readonly string[]): Args | { error: string } => {
  let spec: string | undefined;
  let project: string | undefined;
  let dryRun = false;
  let force = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--project' || arg.startsWith('--project=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) return { error: '--project needs a value' };
      project = value;
    } else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (spec === undefined) spec = arg;
    else return { error: `one spec at a time (got ${spec} and ${arg})` };
  }
  return { spec, project, dryRun, force, json, help };
};

// --- the spec file ----------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_KEYS = [
  'name',
  'slug',
  'anchor',
  'defaultVariant',
  'defaultState',
  'separator',
  'spriteDirectory',
  'prefabDirectory',
  'clips',
];
const CLIP_KEYS = ['variant', 'state', 'fps', 'loop', 'frames', 'sequence'];

export const slugOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const optionalString = (data: Json, key: string, where: string): string | undefined => {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new CharacterCompileError(`${where}${key} must be a string.`);
  return value;
};

/** Measure one frame file (spec-relative path): exists, is a PNG. */
const measure = (specDir: string, path: string, where: string): SourceFrameFile => {
  const absolute = resolve(specDir, path);
  if (!existsSync(absolute)) throw new CharacterCompileError(`${where}: ${path} does not exist.`);
  const size = readPngSize(readFileSync(absolute));
  if (!size) {
    throw new CharacterCompileError(`${where}: ${path} is not a PNG (frames must be PNG files).`);
  }
  return { path: relative(specDir, absolute).split(sep).join('/'), ...size };
};

/** Every numbered file `<dir>/<stem><n>.png` of a `sequence: <dir>/<stem>`, in numeric order. */
const readSequence = (
  specDir: string,
  sequence: string,
  where: string,
  warnings: string[]
): SourceFrameFile[] => {
  // `art/attack`, `art/attack_` and `art/attack-` all name `art/attack_01.png …` (the scan
  // strips the separator before the number).
  const key = sequence
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/[ _\-.]+$/, '');
  const slash = key.lastIndexOf('/');
  const directory = slash >= 0 ? key.slice(0, slash) : '';
  const absoluteDir = resolve(specDir, directory || '.');
  if (!existsSync(absoluteDir)) {
    throw new CharacterCompileError(`${where}: folder ${directory || '.'} does not exist.`);
  }
  const files = readdirSync(absoluteDir)
    .filter(name => name.toLowerCase().endsWith('.png'))
    .map(name => ({ path: directory ? `${directory}/${name}` : name, width: 0, height: 0 }));
  const found = scanNumberedSequences(files).sequences.find(s => s.key === key);
  if (!found) {
    throw new CharacterCompileError(
      `${where}: no numbered PNGs ${key}<n>.png (sequences there: ${
        scanNumberedSequences(files)
          .sequences.map(s => s.key)
          .join(', ') || 'none'
      }).`
    );
  }
  if (found.duplicates.length > 0) {
    throw new CharacterCompileError(
      `${where}: ${key} has frame number(s) ${found.duplicates.join(', ')} more than once — rename one.`
    );
  }
  if (found.gaps.length > 0) {
    warnings.push(`${where}: ${key} skips frame number(s) ${found.gaps.join(', ')}.`);
  }
  return found.frames.map(frame => measure(specDir, frame.path, where));
};

export interface LoadedSpec {
  readonly spec: CharacterCompileSpec;
  /** Findings while reading the frames (gaps in a sequence). */
  readonly warnings: readonly string[];
}

/** Read and check a spec file; frame paths stay relative to its folder. */
export const loadCharacterSpec = (specPath: string): LoadedSpec => {
  let data: unknown;
  try {
    data = parseYaml(readFileSync(specPath, 'utf8'));
  } catch (error) {
    throw new CharacterCompileError(
      `${specPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(data)) throw new CharacterCompileError(`${specPath}: expected a mapping.`);
  const unknown = Object.keys(data).filter(key => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new CharacterCompileError(
      `unknown key(s) ${unknown.join(', ')} (known: ${KNOWN_KEYS.join(', ')}).`
    );
  }
  const name = optionalString(data, 'name', '');
  if (!name?.trim()) throw new CharacterCompileError('name is required.');
  const slug = optionalString(data, 'slug', '') ?? slugOf(name);
  const anchorValue = data.anchor;
  let anchor: { x: number; y: number } | undefined;
  if (anchorValue !== undefined) {
    if (
      !isRecord(anchorValue) ||
      typeof anchorValue.x !== 'number' ||
      typeof anchorValue.y !== 'number'
    )
      throw new CharacterCompileError('anchor must be { x: <number>, y: <number> }.');
    anchor = { x: anchorValue.x, y: anchorValue.y };
  }
  if (!Array.isArray(data.clips) || data.clips.length === 0) {
    throw new CharacterCompileError('clips must be a non-empty list.');
  }
  const specDir = dirname(specPath);
  const warnings: string[] = [];
  const clips: CharacterClipSpec[] = data.clips.map((raw, index) => {
    const where = `clips[${index}]`;
    if (!isRecord(raw)) throw new CharacterCompileError(`${where} must be a mapping.`);
    const unknownClipKeys = Object.keys(raw).filter(key => !CLIP_KEYS.includes(key));
    if (unknownClipKeys.length > 0) {
      throw new CharacterCompileError(
        `${where}: unknown key(s) ${unknownClipKeys.join(', ')} (known: ${CLIP_KEYS.join(', ')}).`
      );
    }
    const state = optionalString(raw, 'state', `${where}.`);
    if (!state?.trim()) throw new CharacterCompileError(`${where}.state is required.`);
    const variant = optionalString(raw, 'variant', `${where}.`) ?? '';
    if (raw.fps !== undefined && typeof raw.fps !== 'number')
      throw new CharacterCompileError(`${where}.fps must be a number.`);
    if (raw.loop !== undefined && typeof raw.loop !== 'boolean')
      throw new CharacterCompileError(`${where}.loop must be true or false.`);
    const hasFrames = raw.frames !== undefined;
    const hasSequence = raw.sequence !== undefined;
    if (hasFrames === hasSequence) {
      throw new CharacterCompileError(`${where}: give exactly one of frames (a list) or sequence.`);
    }
    let frames: SourceFrameFile[];
    if (hasFrames) {
      if (!Array.isArray(raw.frames) || raw.frames.some(f => typeof f !== 'string'))
        throw new CharacterCompileError(`${where}.frames must be a list of paths.`);
      frames = (raw.frames as string[]).map(path => measure(specDir, path, where));
    } else {
      const sequence = optionalString(raw, 'sequence', `${where}.`) ?? '';
      frames = readSequence(specDir, sequence, where, warnings);
    }
    return {
      variant,
      state,
      frames,
      ...(typeof raw.fps === 'number' ? { fps: raw.fps } : {}),
      ...(typeof raw.loop === 'boolean' ? { loop: raw.loop } : {}),
    };
  });
  const spec: CharacterCompileSpec = {
    name,
    slug,
    clips,
    ...(anchor ? { anchor } : {}),
    ...Object.fromEntries(
      ['defaultVariant', 'defaultState', 'separator', 'spriteDirectory', 'prefabDirectory'].flatMap(
        key => {
          const value = optionalString(data as Json, key, '');
          return value === undefined ? [] : [[key, value]];
        }
      )
    ),
  };
  return { spec, warnings };
};

// --- writing ----------------------------------------------------------------------------------

export type CharacterFileAction = 'written' | 'unchanged' | 'replaced' | 'conflict';

export interface CharacterFileOutcome {
  readonly path: string;
  readonly kind: 'animation' | 'prefab' | 'frame';
  readonly action: CharacterFileAction;
}

export interface CharacterCompileReport {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly name: string;
  readonly slug: string;
  readonly animationPath: string;
  readonly prefabPath: string;
  readonly clips: readonly { name: string; frames: number; fps: number; loop: boolean }[];
  readonly files: readonly CharacterFileOutcome[];
  readonly warnings: readonly string[];
  /** Why nothing was written (`ok: false`). */
  readonly error?: string;
}

const writeAtomic = (path: string, bytes: Uint8Array | string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
};

const sameBytes = (path: string, bytes: Uint8Array): boolean => {
  if (!existsSync(path)) return false;
  return Buffer.compare(readFileSync(path), Buffer.from(bytes)) === 0;
};

export interface CompileIntoProjectOptions {
  readonly projectRoot: string;
  readonly specPath: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

/** Compile the spec and write it into the project (all or nothing). */
export const compileCharacterIntoProject = (
  options: CompileIntoProjectOptions
): CharacterCompileReport => {
  const { spec, warnings: readWarnings } = loadCharacterSpec(options.specPath);
  const compiled: CompiledCharacter = compileCharacter(spec);
  const specDir = dirname(options.specPath);
  const root = resolve(options.projectRoot);

  const planned: { path: string; kind: CharacterFileOutcome['kind']; bytes: Uint8Array }[] = [
    { path: compiled.animationPath, kind: 'animation', bytes: Buffer.from(compiled.animationJson) },
    { path: compiled.prefabPath, kind: 'prefab', bytes: Buffer.from(compiled.prefabYaml) },
    ...compiled.frameFiles.map(file => ({
      path: file.targetPath,
      kind: 'frame' as const,
      bytes: readFileSync(resolve(specDir, file.sourcePath)),
    })),
  ];
  const files: CharacterFileOutcome[] = planned.map(file => {
    const target = join(root, file.path);
    const action: CharacterFileAction = !existsSync(target)
      ? 'written'
      : sameBytes(target, file.bytes)
        ? 'unchanged'
        : options.force
          ? 'replaced'
          : 'conflict';
    return { path: file.path, kind: file.kind, action };
  });
  const conflicts = files.filter(file => file.action === 'conflict');
  const base = {
    dryRun: options.dryRun ?? false,
    name: spec.name.trim(),
    slug: spec.slug.trim(),
    animationPath: compiled.animationPath,
    prefabPath: compiled.prefabPath,
    clips: compiled.animation.clips.map(clip => ({
      name: clip.name,
      frames: clip.frames.length,
      fps: clip.fps,
      loop: clip.loop,
    })),
    warnings: [...readWarnings, ...compiled.warnings],
  };
  if (conflicts.length > 0) {
    return {
      ...base,
      ok: false,
      files,
      error: `${conflicts.length} file(s) exist with other content; nothing was written (--force replaces them).`,
    };
  }
  if (!options.dryRun) {
    for (const [index, file] of planned.entries()) {
      if (files[index].action === 'written' || files[index].action === 'replaced') {
        writeAtomic(join(root, file.path), file.bytes);
      }
    }
  }
  return { ...base, ok: true, files };
};

// --- output -----------------------------------------------------------------------------------

export const formatCharacterReport = (report: CharacterCompileReport): string => {
  const lines: string[] = [];
  const frames = report.clips.reduce((sum, clip) => sum + clip.frames, 0);
  lines.push(
    `pix3 character-compile: ${report.name} (${report.slug}) — ${report.clips.length} clip(s), ${frames} frame(s)${report.dryRun ? ' — dry run, nothing written' : ''}`
  );
  for (const clip of report.clips) {
    lines.push(
      `  clip ${clip.name.padEnd(20)} ${clip.frames} frame(s), ${clip.fps} fps, ${clip.loop ? 'loop' : 'once'}`
    );
  }
  const verb: Record<CharacterFileAction, string> = {
    written: report.dryRun ? 'would write' : 'wrote',
    replaced: report.dryRun ? 'would replace' : 'replaced',
    unchanged: 'current',
    conflict: 'EXISTS',
  };
  for (const file of report.files) {
    lines.push(
      `  ${verb[file.action].padEnd(13)} ${file.path}${file.action === 'conflict' ? '  (other content; --force replaces it)' : ''}`
    );
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  if (report.error) lines.push(`error: ${report.error}`);
  else if (!report.dryRun) {
    lines.push(
      `Next: instance it in a scene (\`instance: res://${report.prefabPath}\`), drive it from a script with core:CharacterVisual2D's playState / setVariant, then pix3 check.`
    );
  }
  return `${lines.join('\n')}\n`;
};

export const runCharacterCompileCli = async (
  argv: readonly string[],
  io: CharacterCompileIo
): Promise<number> => {
  const args = parseArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 character-compile: ${args.error}\n\n${COMMAND_USAGE['character-compile']}`);
    return 2;
  }
  if (args.help) {
    io.stdout(COMMAND_USAGE['character-compile']);
    return 0;
  }
  if (!args.spec) {
    io.stderr(
      `pix3 character-compile: name the spec file.\n\n${COMMAND_USAGE['character-compile']}`
    );
    return 2;
  }
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  if (!root || !existsSync(join(root, PROJECT_MANIFEST_FILE))) {
    io.stderr(
      `pix3 character-compile: no ${PROJECT_MANIFEST_FILE} in ${args.project ? root : `${io.cwd} or above`} — run inside a project or pass --project <dir>.\n`
    );
    return 2;
  }
  const specPath = isAbsolute(args.spec) ? args.spec : resolve(io.cwd, args.spec);
  if (!existsSync(specPath)) {
    io.stderr(`pix3 character-compile: ${args.spec} does not exist.\n`);
    return 2;
  }
  let report: CharacterCompileReport;
  try {
    report = compileCharacterIntoProject({
      projectRoot: root,
      specPath,
      dryRun: args.dryRun,
      force: args.force,
    });
  } catch (error) {
    if (!(error instanceof CharacterCompileError)) throw error;
    if (args.json) io.stdout(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    else io.stderr(`pix3 character-compile: ${error.message}\n`);
    return 1;
  }
  io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatCharacterReport(report));
  return report.ok ? 0 : 1;
};
