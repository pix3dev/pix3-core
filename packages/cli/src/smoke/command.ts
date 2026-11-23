import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parse as parseYaml } from 'yaml';

import { describeUnsynced, syncEditor } from '../editor-sync.ts';
import type { CliIo } from '../io.ts';
import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { cliPackageRoot, resolveEsbuild } from '../package-root.ts';
import { ProjectFiles, toProjectPath } from '../validate/project.ts';
import { isRecord } from '../validate/yaml-doc.ts';
import { SMOKE_WORKER_FILE, withSmokeBundle } from './entry.ts';
import {
  analyticsSummary,
  hapticsSummary,
  isSmokeFailure,
  type SmokeFailure,
  type SmokeFailureCode,
  type SmokeJob,
  type SmokeOutcome,
  type SmokeReport,
  type SmokeRunSet,
  type SmokeCommand,
  type SmokeRunOverrides,
} from './report.ts';
import { runtimeVersionMismatch } from '../version-gate.ts';
import { parseAdsArg, parseStorageArg } from '../play/command.ts';
import {
  gridCombos,
  isGrid,
  jsonLabel,
  parseObjectList,
  parseSeedList,
  parseSizeList,
  runGrid,
  type GridAxes,
  type GridCombo,
  type GridPlay,
  type GridValue,
} from '../play/grid.ts';
import {
  formatGoldenHuman,
  goldenArgsOf,
  goldenFailed,
  goldenOf,
  readGolden,
  settleGolden,
  type GoldenArgs,
} from '../golden.ts';
import {
  formatReplayHuman,
  projectHash,
  readReplayFile,
  settleReplay,
  stampBuild,
  type ReplayReport,
} from '../replay-file.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { selectSmokeScenes, type SmokeSelection } from './select-scenes.ts';

/**
 * `pix3 smoke [scene] [--changed|--all] [--frames N] [--timeout S] [--json] [--project <dir>]` —
 * run the game headless in Node for N fixed 1/60 s frames and report what threw. With no scene it
 * runs several, one after another (`select-scenes.ts` decides which).
 *
 * This file is plain Node (no runtime import): it resolves the project and the scene, then runs the
 * game in a worker thread from the smoke bundle (`entry.ts`, `worker.ts`, `smoke.ts`) under a
 * wall-clock timeout. Exit codes: 0 = ran clean, 1 = at least one error, 2 = could not run.
 */

export type SmokeIo = CliIo;

interface SmokeArgs {
  readonly scene?: string;
  readonly changed: boolean;
  readonly all: boolean;
  readonly frames: number;
  readonly timeoutSec: number;
  readonly json: boolean;
  readonly sync: boolean;
  readonly project?: string;
  readonly help: boolean;
  readonly commands: readonly SmokeCommand[];
  readonly run?: SmokeRunOverrides;
  /** `--golden <file> [--write] [--tolerance …]`: the run's end pinned in a file (`golden.ts`). */
  readonly golden: GoldenArgs | null;
  /** `--record <file> [--every N]`: write the run as a `.pix3replay`. */
  readonly record?: { readonly file: string; readonly every?: number };
  /** `--replay <file>`: play a recording back instead of a scene. */
  readonly replay?: string;
  /** `--bot <name>`: `design/tests/bots/<name>.ts` on `direct-action`. */
  readonly bot?: string;
  /** List values (`--seed 1..50`, …): the axes of a grid; a single run's are folded into `run`. */
  readonly axes: GridAxes;
  readonly grid: boolean;
  readonly parallel: number;
  readonly checkDeterminism: boolean;
}

const DEFAULT_FRAMES = 120;
/** With a bot: two minutes of game time, as `pix3 play --bot`; the run ends at the verdict. */
const DEFAULT_BOT_FRAMES = 7200;
const DEFAULT_BOT_TIMEOUT_SEC = 120;
const DEFAULT_TIMEOUT_SEC = 20;

/**
 * `name`, `name@frame` (frame ≥ 1; default 1) and either followed by a JSON object of args after a
 * space — `swap@30 {"from":[2,3],"to":[2,4]}`: a game command dispatched before that frame.
 */
const parseSmokeCommand = (value: string): SmokeCommand | null => {
  const match = /^([^@\s]+)(?:@(\d+))?(?:\s+([\s\S]+))?$/.exec(value.trim());
  if (!match) return null;
  const frame = match[2] === undefined ? 1 : Number(match[2]);
  if (frame < 1) return null;
  if (match[3] === undefined) return { name: match[1], frame };
  try {
    const args = JSON.parse(match[3]) as unknown;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    return { name: match[1], frame, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
};

const parseSmokeArgs = (argv: readonly string[]): SmokeArgs | { error: string } => {
  let scene: string | undefined;
  let frames = DEFAULT_FRAMES;
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  let json = false;
  let sync = true;
  let changed = false;
  let all = false;
  let project: string | undefined;
  let help = false;
  const commands: SmokeCommand[] = [];
  let run: SmokeRunOverrides | undefined;
  let golden: string | undefined;
  let write = false;
  let tolerance: string | undefined;
  let record: string | undefined;
  let every: number | undefined;
  let replay: string | undefined;
  let framesGiven = false;
  let timeoutGiven = false;
  let bot: string | undefined;
  let seeds: GridValue<number>[] = [];
  let sizes: GridValue<{ width: number; height: number; scale?: number }>[] = [];
  const configs: GridValue<Record<string, unknown>>[] = [];
  const botArgsList: GridValue<Record<string, unknown>>[] = [];
  const locales: GridValue<string>[] = [];
  const storages: GridValue<unknown>[] = [];
  let parallel: number | undefined;
  let checkDeterminism = false;
  const valueOf = (arg: string, index: number): { value?: string; next: number } => {
    const eq = arg.indexOf('=');
    if (eq > 0) return { value: arg.slice(eq + 1), next: index };
    return { value: argv[index + 1], next: index + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split('=')[0];
    if (arg === '--json') json = true;
    else if (arg === '--no-sync') sync = false;
    else if (arg === '--changed') changed = true;
    else if (arg === '--all') all = true;
    else if (arg === '--write') write = true;
    else if (arg === '--check-determinism') checkDeterminism = true;
    else if (
      name === '--bot' ||
      name === '--bot-args' ||
      name === '--locale' ||
      name === '--storage' ||
      name === '--size' ||
      name === '--parallel'
    ) {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value` };
      if (name === '--bot') bot = value;
      else if (name === '--bot-args') {
        const parsed = parseObjectList(value);
        if (!parsed)
          return {
            error: `--bot-args takes a JSON object, e.g. --bot-args '{"target":"lose"}' — or a file holding one or a list of them; repeat it for a grid`,
          };
        for (const args of parsed)
          botArgsList.push({ value: args, label: jsonLabel('bot-args', args, botArgsList.length) });
      } else if (name === '--locale') {
        for (const locale of value.split(',').map(part => part.trim())) {
          if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale))
            return { error: '--locale takes a locale code or a list: --locale ru,en' };
          locales.push({ value: locale, label: `locale=${locale}` });
        }
      } else if (name === '--storage') {
        const parsed = parseStorageArg(value);
        if ('error' in parsed) return parsed;
        storages.push({
          value: parsed.storage,
          label: value.length <= 40 ? `storage=${value}` : `storage#${storages.length + 1}`,
        });
      } else if (name === '--size') {
        const parsed = parseSizeList(value);
        if ('error' in parsed) return parsed;
        sizes = parsed;
      } else {
        parallel = Number(value);
        if (!Number.isInteger(parallel) || parallel < 1)
          return { error: '--parallel takes a whole number of runs at a time ≥ 1' };
      }
    } else if (name === '--record' || name === '--replay' || name === '--every') {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value` };
      if (name === '--record') record = value;
      else if (name === '--replay') replay = value;
      else {
        every = Number(value);
        if (!Number.isInteger(every) || every < 1)
          return { error: '--every takes a whole number of ticks ≥ 1' };
      }
    } else if (name === '--golden' || name === '--tolerance') {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (name === '--golden') golden = value;
      else tolerance = value;
    } else if (arg === '--help' || arg === '-h') help = true;
    else if (name === '--command') {
      const { value, next } = valueOf(arg, i);
      i = next;
      const parsed = value === undefined ? null : parseSmokeCommand(value);
      if (!parsed)
        return {
          error:
            '--command needs name[@frame] [json args], e.g. --command restart@60 or --command \'swap@30 {"x":2}\'',
        };
      commands.push(parsed);
    } else if (name === '--ads') {
      const { value, next } = valueOf(arg, i);
      i = next;
      const parsed = parseAdsArg(value);
      if ('error' in parsed) return parsed;
      run = { ...run, ads: parsed.ads };
    } else if (name === '--seed' || name === '--config') {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (name === '--seed') {
        const parsed = parseSeedList(value ?? '');
        if ('error' in parsed) return parsed;
        seeds = parsed;
      } else {
        const parsed = parseObjectList(value ?? '');
        if (!parsed) {
          return {
            error: `--config takes a JSON object {"<nodeId>": {"<componentId>": {"key": value}}} — or a file holding one or a list of them; repeat it for a grid`,
          };
        }
        for (const config of parsed)
          configs.push({ value: config, label: jsonLabel('config', config, configs.length) });
      }
    } else if (name === '--frames' || name === '--timeout' || name === '--project') {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value` };
      if (name === '--project') project = value;
      else {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0)
          return { error: `${name} needs a positive number` };
        if (name === '--frames') {
          frames = Math.floor(number);
          framesGiven = true;
        } else {
          timeoutSec = number;
          timeoutGiven = true;
        }
      }
    } else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (scene === undefined) scene = arg;
    else return { error: `one scene at a time (got ${scene} and ${arg})` };
  }
  if (changed && all) return { error: '--changed and --all exclude each other' };
  if (scene !== undefined && (changed || all))
    return {
      error: `${changed ? '--changed' : '--all'} picks the scenes; drop ${scene} or the flag`,
    };
  if (every !== undefined && record === undefined)
    return { error: '--every sets the checkpoints of a recording: give it --record <file>' };
  if (record !== undefined && (scene === undefined || replay !== undefined))
    return {
      error: '--record records one run: name its scene (pix3 smoke <scene> --record f.pix3replay)',
    };
  if (replay !== undefined) {
    const extra = [
      scene !== undefined && scene,
      changed && '--changed',
      all && '--all',
      commands.length > 0 && '--command',
      (run || seeds.length + configs.length + locales.length + storages.length > 0) &&
        '--seed/--config/--ads/--locale/--storage',
      bot !== undefined && '--bot',
      framesGiven && '--frames',
      golden !== undefined && '--golden',
    ].filter(Boolean);
    if (extra.length > 0)
      return {
        error: `--replay plays the recording's scene, settings, inputs and length: drop ${extra.join(', ')}`,
      };
  }
  const axes: GridAxes = {
    seed: seeds,
    config: configs,
    botArgs: botArgsList,
    size: sizes,
    locale: locales,
    storage: storages,
  };
  const grid = isGrid(axes) || parallel !== undefined || checkDeterminism;
  if (grid && scene === undefined)
    return {
      error: 'a grid plays one scene: name it (pix3 smoke scenes/main.pix3scene --seed 1..20)',
    };
  if (grid && record !== undefined) return { error: '--record takes one run: drop it from a grid' };
  if (botArgsList.length > 0 && bot === undefined)
    return { error: '--bot-args goes with --bot <name>' };
  if (bot !== undefined && scene === undefined)
    return {
      error: '--bot plays one scene: name it (pix3 smoke scenes/main.pix3scene --bot round)',
    };
  if (bot !== undefined && !framesGiven) frames = DEFAULT_BOT_FRAMES;
  if (bot !== undefined && !timeoutGiven) timeoutSec = DEFAULT_BOT_TIMEOUT_SEC;
  // A single run: the one value of each axis is the run's.
  if (!grid) run = { ...run, ...overridesOf(gridCombos(axes)[0]) };
  if (run && Object.keys(run).length === 0) run = undefined;
  const goldenArgs = goldenArgsOf(golden, write, tolerance);
  if (goldenArgs && 'error' in goldenArgs) return goldenArgs;
  if (goldenArgs && scene === undefined)
    return { error: '--golden pins one run: name its scene (pix3 smoke scenes/main.pix3scene)' };
  for (const command of commands) {
    if (command.frame > frames)
      return { error: `--command ${command.name}@${command.frame} is past --frames ${frames}` };
  }
  return {
    scene,
    changed,
    all,
    frames,
    timeoutSec,
    json,
    sync,
    project,
    help,
    commands,
    golden: goldenArgs,
    ...(run ? { run } : {}),
    ...(record !== undefined ? { record: { file: record, ...(every ? { every } : {}) } } : {}),
    ...(replay !== undefined ? { replay } : {}),
    ...(bot !== undefined ? { bot } : {}),
    axes,
    grid,
    parallel: parallel ?? 1,
    checkDeterminism,
  };
};

/** A combination's `RunOverrides` (seed, config, locale, save); `bot.args` and the canvas aside. */
const overridesOf = (combo: GridCombo): SmokeRunOverrides => ({
  ...(combo.seed !== undefined ? { seed: combo.seed } : {}),
  ...(combo.config !== undefined ? { config: combo.config as SmokeRunOverrides['config'] } : {}),
  ...(combo.locale !== undefined ? { locale: combo.locale } : {}),
  ...(combo.storage !== undefined
    ? { storage: combo.storage as SmokeRunOverrides['storage'] }
    : {}),
});

const failure = (code: SmokeFailureCode, reason: string, scene?: string): SmokeFailure => ({
  ok: false,
  code,
  reason,
  ...(scene ? { scene } : {}),
});

interface ManifestBits {
  readonly defaultScene?: string;
  readonly viewport: { width: number; height: number };
  readonly autoloads: unknown;
}

const readManifest = (root: string): ManifestBits => {
  const fallback: ManifestBits = {
    viewport: { width: 1920, height: 1080 },
    autoloads: [],
  };
  try {
    const data = parseYaml(readFileSync(join(root, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    if (!isRecord(data)) return fallback;
    const size = isRecord(data.viewportBaseSize) ? data.viewportBaseSize : {};
    const width = typeof size.width === 'number' && size.width > 0 ? size.width : 1920;
    const height = typeof size.height === 'number' && size.height > 0 ? size.height : 1080;
    const defaultScene =
      typeof data.defaultExportScenePath === 'string' && data.defaultExportScenePath.trim()
        ? (toProjectPath(data.defaultExportScenePath) ?? undefined)
        : undefined;
    return {
      viewport: { width, height },
      autoloads: data.autoloads ?? [],
      ...(defaultScene ? { defaultScene } : {}),
    };
  } catch {
    return fallback;
  }
};

/** Project-relative path of the scene the argument names, or a failure. */
export const resolveSmokeScene = (
  project: ProjectFiles,
  cwd: string,
  requested: string
): string | SmokeFailure => {
  const candidates: string[] = [];
  const stripped = requested.replace(/^res:\/\//i, '').replace(/^\/+/, '');
  candidates.push(stripped.split(sep).join('/'));
  const fromCwd = project.relativeOf(isAbsolute(requested) ? requested : resolve(cwd, requested));
  if (fromCwd) candidates.push(fromCwd);
  const found = candidates.find(candidate => project.has(candidate));
  if (!found)
    return failure(
      'E_SMOKE_NO_SCENE',
      `${requested} is not a file in the project (${project.root}).`
    );
  if (!found.endsWith('.pix3scene'))
    return failure('E_SMOKE_NO_SCENE', `${found} is not a .pix3scene.`);
  return found;
};

export interface RunSmokeOptions {
  readonly projectRoot: string;
  readonly frames?: number;
  readonly timeoutSec?: number;
  readonly cwd?: string;
  /** `--command`: game commands dispatched before the given frames. */
  readonly commands?: readonly SmokeCommand[];
  /** `--seed` / `--config`: the run's `scene.random` seed and component config overrides. */
  readonly run?: SmokeRunOverrides;
  /** `--record`: record the run (the report's `recording` is the file's text). */
  readonly record?: { readonly every?: number };
  /** `--replay`: a recording's text, and the canvas it was made on. */
  readonly replay?: { readonly text: string; readonly canvas: { width: number; height: number } };
  /** `--bot`: the policy (`design/tests/bots/<name>.ts`) and its `bot.args`. */
  readonly bot?: { readonly name: string; readonly args?: Record<string, unknown> };
  /** `--size`: the canvas in CSS px (default: the design viewport). */
  readonly canvas?: { readonly width: number; readonly height: number };
}

export interface RunOneSmokeOptions extends RunSmokeOptions {
  /** The scene to run (res://, project-relative or a path). */
  readonly scene: string;
}

export interface RunSmokeSetOptions extends RunSmokeOptions {
  /** `--changed`: only the scenes changed files reach. */
  readonly changedOnly?: boolean;
  /** `--all`: every top-level scene. */
  readonly all?: boolean;
  /** Test seam for the git answer (null = no git); default asks git. */
  readonly changedFiles?: readonly string[] | null;
}

/** Run one smoke job in a worker from the bundle in `bundleDir`. */
const runInWorker = (bundleDir: string, job: SmokeJob, timeoutSec: number): Promise<SmokeOutcome> =>
  new Promise(resolveOutcome => {
    let settled = false;
    const worker = new Worker(pathToFileURL(join(bundleDir, SMOKE_WORKER_FILE)), {
      workerData: job,
      stdout: true,
      stderr: true,
    });
    // A script writing to process.stdout directly must not interleave with the report.
    worker.stdout.resume();
    worker.stderr.resume();
    const settle = (outcome: SmokeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => {
      settle(
        failure(
          'E_SMOKE_TIMEOUT',
          `the run did not finish within ${timeoutSec} s (a script stuck in a loop, or a scene too heavy for ${job.frames} frames; try --frames or --timeout).`,
          job.scene
        )
      );
    }, timeoutSec * 1000);
    worker.once('message', (outcome: SmokeOutcome) => settle(outcome));
    worker.once('error', (error: unknown) =>
      settle(
        failure(
          'E_SMOKE_CRASH',
          `the smoke worker crashed: ${error instanceof Error ? error.message : String(error)}`,
          job.scene
        )
      )
    );
    worker.once('exit', code =>
      settle(
        failure(
          'E_SMOKE_CRASH',
          `the smoke worker exited (code ${code}) without a report.`,
          job.scene
        )
      )
    );
  });

interface Prepared {
  readonly root: string;
  readonly project: ProjectFiles;
  readonly manifest: ManifestBits;
}

const prepare = (projectRoot: string): Prepared | SmokeFailure => {
  const root = resolve(projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return failure('E_SMOKE_NO_PROJECT', `${root} is not a folder.`);
  }
  // The version gate: a run on another engine than the game ships says nothing about the game.
  const mismatch = runtimeVersionMismatch(root);
  if (mismatch) return failure('E_RUNTIME_VERSION', `${mismatch.message} Fix: ${mismatch.fix}.`);
  return { root, project: new ProjectFiles(root), manifest: readManifest(root) };
};

const jobFor = (prepared: Prepared, scene: string, options: RunSmokeOptions): SmokeJob => ({
  projectRoot: prepared.root,
  scene,
  frames: options.frames ?? DEFAULT_FRAMES,
  ...(options.commands?.length ? { commands: options.commands } : {}),
  ...(options.run ? { run: options.run } : {}),
  ...(options.record ? { record: options.record } : {}),
  ...(options.canvas ? { canvas: options.canvas } : {}),
  ...(options.replay ? { replay: options.replay.text, canvas: options.replay.canvas } : {}),
  ...(options.bot
    ? {
        bot: {
          name: options.bot.name,
          file: `${BOT_DIR}/${options.bot.name}.ts`,
          ...(options.bot.args ? { args: options.bot.args } : {}),
        },
      }
    : {}),
  viewport: prepared.manifest.viewport,
  autoloads: prepared.manifest.autoloads,
  esbuildSpecifier: resolveEsbuild(),
  fallbackResolveDir: cliPackageRoot(),
});

const BOT_DIR = 'design/tests/bots';

/** Run each scene in its own worker, one after another, from one smoke bundle. */
const runScenes = async (
  prepared: Prepared,
  scenes: readonly string[],
  options: RunSmokeOptions
): Promise<SmokeOutcome[]> => {
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  try {
    return await withSmokeBundle(async dir => {
      const outcomes: SmokeOutcome[] = [];
      for (const scene of scenes) {
        outcomes.push(await runInWorker(dir, jobFor(prepared, scene, options), timeoutSec));
      }
      return outcomes;
    });
  } catch (error) {
    const reason = `could not build or load the smoke bundle: ${error instanceof Error ? error.message : String(error)}`;
    return scenes.map(scene => failure('E_SMOKE_BUNDLE', reason, scene));
  }
};

/** Run one named scene headless; the outcome is the report (or why it could not run). */
export const runSmoke = async (options: RunOneSmokeOptions): Promise<SmokeOutcome> => {
  const prepared = prepare(options.projectRoot);
  if ('code' in prepared) return prepared;
  const scene = resolveSmokeScene(prepared.project, options.cwd ?? prepared.root, options.scene);
  if (typeof scene !== 'string') return scene;
  const [outcome] = await runScenes(prepared, [scene], options);
  return outcome;
};

/** Which scenes a run with no scene argument covers (see `select-scenes.ts`). */
export const selectScenesFor = (options: RunSmokeSetOptions): SmokeSelection | SmokeFailure => {
  const prepared = prepare(options.projectRoot);
  return 'code' in prepared ? prepared : selectFor(prepared, options);
};

const selectFor = (
  prepared: Prepared,
  options: RunSmokeSetOptions
): SmokeSelection | SmokeFailure => {
  const selection = selectSmokeScenes(prepared.project, {
    manifestDefault: prepared.manifest.defaultScene,
    changedOnly: options.changedOnly,
    all: options.all,
    ...(options.changedFiles !== undefined ? { changedFiles: options.changedFiles } : {}),
  });
  return 'error' in selection ? failure('E_SMOKE_NO_SCENE', selection.error) : selection;
};

/** No scene argument: run every selected scene; `ok` only when each ran clean. */
export const runSmokeSet = async (
  options: RunSmokeSetOptions
): Promise<SmokeRunSet | SmokeFailure> => {
  const prepared = prepare(options.projectRoot);
  if ('code' in prepared) return prepared;
  const selection = selectFor(prepared, options);
  if ('code' in selection) return selection;
  const runs = await runScenes(prepared, selection.scenes, options);
  return {
    ok: runs.every(run => !isSmokeFailure(run) && run.errors.length === 0),
    selection: selection.mode,
    reason: selection.reason,
    ...(selection.changed ? { changed: selection.changed } : {}),
    runs,
  };
};

// --- Output --------------------------------------------------------------------------------------

/** Stack lines with the project root stripped, the engine's own frames dropped past the first few. */
const trimStack = (stack: string | undefined, root: string, maxLines: number): string[] => {
  if (!stack) return [];
  const rootUrl = pathToFileURL(root).href;
  return stack
    .split('\n')
    .slice(1)
    .map(line =>
      line
        .trim()
        .replaceAll(`${rootUrl}/`, '')
        .replaceAll(`${root}${sep}`, '')
        .replaceAll(`${root}/`, '')
    )
    .filter(line => line.startsWith('at '))
    .slice(0, maxLines);
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Longest `game` snapshot printed by the human report; `--json` always carries it whole. */
const SNAPSHOT_HUMAN_LIMIT = 4000;

export const formatGameSnapshot = (snapshot: unknown): string => {
  const compact = JSON.stringify(snapshot) ?? 'null';
  if (compact.length <= 120) return compact;
  const pretty = JSON.stringify(snapshot, null, 2) ?? 'null';
  const shown =
    pretty.length > SNAPSHOT_HUMAN_LIMIT
      ? `${pretty.slice(0, SNAPSHOT_HUMAN_LIMIT)}\n… (${pretty.length - SNAPSHOT_HUMAN_LIMIT} more characters; pix3 smoke --json has it whole)`
      : pretty;
  return `\n${shown
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')}`;
};

export const formatSmokeHuman = (outcome: SmokeOutcome, root: string): string => {
  if (isSmokeFailure(outcome)) {
    return `pix3 smoke${outcome.scene ? ` ${outcome.scene}` : ''}: could not run — ${outcome.code}: ${outcome.reason}\n`;
  }
  const report: SmokeReport = outcome;
  const lines: string[] = [];
  const t = report.timingsMs;
  lines.push(
    `pix3 smoke ${report.scene} — ${report.frames}/${report.framesRequested} frames at 1/60 s: ${plural(report.errors.length, 'error')}, ${plural(report.warnings.length, 'warning')}`
  );
  lines.push(
    `  first frame ${report.firstFrameOk ? 'ok' : 'NOT ok'} · nodes ${report.nodes.start} → ${report.nodes.end} · scripts ${report.scripts.length}`
  );
  lines.push(
    `  compile ${t.compile} ms · load+onStart ${t.load} ms · frame 1 ${t.firstFrame} ms · step mean ${t.step.mean} / p95 ${t.step.p95} / max ${t.step.max} ms · total ${t.total} ms`
  );
  if (report.game) {
    // The snapshot is the one line of the report that says what the game DID (score, phase,
    // ready flag); it used to be cut at 160 characters, which on a real game ended mid-key.
    // Printed whole, pretty when it does not fit a line, capped only far beyond any HUD.
    lines.push(
      `  game "${report.game.name}" snapshot: ${formatGameSnapshot(report.game.snapshot)}`
    );
  }
  if (report.analytics) lines.push(`  ${analyticsSummary(report.analytics)}`);
  if (report.haptics) lines.push(`  ${hapticsSummary(report.haptics)}`);
  if (report.bot) {
    const { name, done, error } = report.bot;
    lines.push(
      error
        ? `  bot ${name} (direct-action): CRASHED — ${error.message}`
        : done
          ? `  bot ${name} (direct-action): ${done.pass ? 'PASS' : 'FAIL'} at frame ${done.frame} — ${done.reason}`
          : `  bot ${name} (direct-action): no verdict in ${report.bot.frames ?? 0} frame(s)`
    );
    for (const entry of (report.bot.log ?? []).slice(-8))
      lines.push(`    [${entry.frame}] ${entry.kind}: ${entry.message}`);
  }
  if (report.errors.length > 0) {
    lines.push('errors:');
    for (const error of report.errors) {
      const where = [
        error.script,
        error.nodeName ? `on "${error.nodeName}"` : error.nodeId ? `on ${error.nodeId}` : undefined,
        error.phase ? `(${error.phase})` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `  frame ${error.frame}  ${error.code}${where ? ` ${where}` : ''}: ${error.message}`
      );
      if (error.domAccess && error.domAccess.length > 0) {
        lines.push(`      missing browser API read just before: ${error.domAccess.join(', ')}`);
      }
      for (const line of trimStack(error.stack, root, 3)) lines.push(`      ${line}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of report.warnings) {
      lines.push(
        `  ${warning.frame !== undefined ? `frame ${warning.frame}  ` : ''}${warning.code}: ${warning.message}${warning.count ? ` (×${warning.count})` : ''}`
      );
    }
  }
  if (report.notes.length > 0) {
    lines.push('notes:');
    for (const note of report.notes) lines.push(`  ${note}`);
  }
  return `${lines.join('\n')}\n`;
};

/** `extra`: fields the command adds to one report (`golden`). */
export const formatSmokeJson = (
  outcome: SmokeOutcome,
  root: string,
  extra: Record<string, unknown> = {}
): string => {
  if (isSmokeFailure(outcome)) return `${JSON.stringify(outcome, null, 2)}\n`;
  return `${JSON.stringify(
    {
      ...outcome,
      ...extra,
      errors: outcome.errors.map(error => ({
        ...error,
        ...(error.stack ? { stack: trimStack(error.stack, root, 12).join('\n') } : {}),
      })),
    },
    null,
    2
  )}\n`;
};

export const smokeExitCode = (outcome: SmokeOutcome): number =>
  isSmokeFailure(outcome) ? 2 : outcome.errors.length > 0 ? 1 : 0;

/** The worst run decides: 2 if any could not run, else 1 if any reported errors, else 0. */
export const smokeSetExitCode = (set: SmokeRunSet): number =>
  set.runs.reduce((worst, run) => Math.max(worst, smokeExitCode(run)), 0);

const runStatus = (run: SmokeOutcome): string => {
  if (isSmokeFailure(run)) return `could not run (${run.code})`;
  const parts = [plural(run.errors.length, 'error'), plural(run.warnings.length, 'warning')];
  return `${run.errors.length > 0 ? 'FAILED' : 'ok'} — ${run.frames} frames, ${parts.join(', ')}`;
};

export const formatSmokeSetHuman = (set: SmokeRunSet, root: string): string => {
  const lines: string[] = [];
  lines.push(`pix3 smoke: ${plural(set.runs.length, 'scene')} — ${set.reason}`);
  for (const run of set.runs) {
    lines.push(`  ${(run.scene ?? '?').padEnd(32)} ${runStatus(run)}`);
  }
  const details = set.runs.filter(
    run =>
      isSmokeFailure(run) ||
      run.errors.length > 0 ||
      run.warnings.length > 0 ||
      set.runs.length === 1
  );
  for (const run of details) lines.push('', formatSmokeHuman(run, root).trimEnd());
  if (set.runs.length > 1 && details.length === 0) {
    lines.push('Run one scene for its details: pix3 smoke <scene>.');
  }
  return `${lines.join('\n')}\n`;
};

export const formatSmokeSetJson = (set: SmokeRunSet, root: string): string =>
  `${JSON.stringify(
    { ...set, runs: set.runs.map(run => JSON.parse(formatSmokeJson(run, root)) as unknown) },
    null,
    2
  )}\n`;

export const runSmokeCli = async (argv: readonly string[], io: SmokeIo): Promise<number> => {
  const args = parseSmokeArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 smoke: ${args.error}\n\n${COMMAND_USAGE.smoke}`);
    return 2;
  }
  if (args.help) {
    io.stdout(COMMAND_USAGE.smoke);
    return 0;
  }
  const golden =
    args.golden && !args.golden.write
      ? readGolden(args.golden, io.cwd, args.grid ? 'grid' : 'run')
      : null;
  if (golden && 'error' in golden) {
    io.stderr(`pix3 smoke: ${golden.error}\n`);
    return 2;
  }
  const replayPath = args.replay !== undefined ? resolve(io.cwd, args.replay) : null;
  const replayFile = replayPath ? readReplayFile(replayPath) : null;
  if (replayFile && 'error' in replayFile) {
    io.stderr(`pix3 smoke: ${replayFile.error}\n`);
    return 2;
  }
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  const shownRoot = root ?? io.cwd;
  if (args.bot !== undefined && root && !existsSync(join(root, BOT_DIR, `${args.bot}.ts`))) {
    io.stderr(`pix3 smoke: no bot policy ${join(root, BOT_DIR, `${args.bot}.ts`)}\n`);
    return 2;
  }
  const singleBotArgs = args.axes.botArgs?.[0]?.value;
  const singleSize = args.axes.size?.[0]?.value;
  const common = {
    frames: replayFile ? Math.max(1, replayFile.header.end) : args.frames,
    timeoutSec: args.timeoutSec,
    cwd: io.cwd,
    commands: args.commands,
    run: args.run,
    ...(args.record ? { record: { every: args.record.every } } : {}),
    ...(replayFile
      ? { replay: { text: replayFile.text, canvas: replayFile.header.viewport } }
      : {}),
    ...(args.bot !== undefined
      ? { bot: { name: args.bot, ...(singleBotArgs ? { args: singleBotArgs } : {}) } }
      : {}),
    ...(singleSize ? { canvas: { width: singleSize.width, height: singleSize.height } } : {}),
  };
  // Files are the truth only once the editor has written them (plan §B.6): a dev server with an
  // editor tab (`.pix3/dev.json`) flushes before the scene is read.
  const synced = root
    ? await syncEditor(root, { noSync: !args.sync })
    : { status: 'skipped' as const };
  let outcome: SmokeOutcome | SmokeRunSet;
  if (!root) {
    outcome = failure(
      'E_SMOKE_NO_PROJECT',
      `no pix3project.yaml in ${io.cwd} or above — run inside a project or pass --project <dir>.`
    );
  } else if (synced.status === 'unsynced') {
    outcome = failure('E_EDITOR_UNSYNCED', describeUnsynced(synced), args.scene);
  } else if (args.grid) {
    return smokeGrid(root, args, { projectRoot: root, ...common }, io, golden);
  } else if (args.scene !== undefined || replayFile) {
    const scene = args.scene ?? replayFile!.header.scene;
    outcome = await runSmoke({ projectRoot: root, scene, ...common });
  } else {
    outcome = await runSmokeSet({
      projectRoot: root,
      changedOnly: args.changed,
      all: args.all,
      ...common,
    });
  }
  if ('runs' in outcome) {
    io.stdout(
      args.json ? formatSmokeSetJson(outcome, shownRoot) : formatSmokeSetHuman(outcome, shownRoot)
    );
    return smokeSetExitCode(outcome);
  }
  // The recording to its file, the replay's snapshots beside it; neither text stays in the report.
  let replayReport: ReplayReport | null = null;
  let recorded: { file: string; ticks: number } | null = null;
  if (!isSmokeFailure(outcome) && root) {
    const { recording, replay, ...rest } = outcome;
    const build = recording !== undefined || replay ? projectHash(root) : '';
    if (recording !== undefined && args.record) {
      const file = resolve(io.cwd, args.record.file);
      writeFileSync(file, stampBuild(recording, build));
      recorded = { file, ticks: outcome.frames };
    }
    if (replay && replayFile && replayPath)
      replayReport = settleReplay(replay, replayPath, replayFile.header, build);
    outcome = rest;
  }
  // A run that could not happen (exit 2) has no end to compare.
  const botFailed =
    !isSmokeFailure(outcome) && outcome.bot !== undefined && smokeVerdict(outcome) !== 'pass';
  const goldenResult =
    args.golden && !isSmokeFailure(outcome)
      ? settleGolden(
          args.golden,
          io.cwd,
          goldenOf(outcome.game?.snapshot, outcome.analytics),
          outcome.errors.length > 0 || botFailed,
          golden
        )
      : null;
  if (args.json) {
    io.stdout(
      formatSmokeJson(outcome, shownRoot, {
        ...(goldenResult ? { golden: goldenResult } : {}),
        ...(replayReport ? { replay: replayReport } : {}),
        ...(recorded ? { recorded } : {}),
      })
    );
  } else {
    io.stdout(formatSmokeHuman(outcome, shownRoot));
    if (goldenResult) io.stdout(`${formatGoldenHuman(goldenResult).join('\n')}\n`);
    if (replayReport) io.stdout(`${formatReplayHuman(replayReport).join('\n')}\n`);
    if (recorded) io.stdout(`recorded ${recorded.ticks} tick(s): ${recorded.file}\n`);
  }
  const exit = smokeExitCode(outcome);
  return exit === 0 &&
    (botFailed || goldenFailed(goldenResult) || (replayReport && !replayReport.ok))
    ? 1
    : exit;
};

/** A run's verdict as a grid counts it: a policy's pass / fail / crash, or the game's error. */
const smokeVerdict = (outcome: SmokeOutcome): GridPlay['verdict'] => {
  if (isSmokeFailure(outcome) || outcome.errors.length > 0) return 'error';
  if (outcome.bot?.error) return 'crash';
  return !outcome.bot || outcome.bot.done?.pass === true ? 'pass' : 'fail';
};

/**
 * `pix3 smoke <scene>` with list values: every combination a worker of its own (a fresh game),
 * `--parallel` at a time, from one bundle — the grid of `pix3 play`, in Node.
 */
const smokeGrid = async (
  root: string,
  args: SmokeArgs,
  common: RunSmokeOptions,
  io: SmokeIo,
  golden: Exclude<ReturnType<typeof readGolden>, { error: string }> | null
): Promise<number> => {
  const refuse = (failed: SmokeFailure): number => {
    io.stderr(`pix3 smoke: ${failed.code}: ${failed.reason}\n`);
    return 2;
  };
  const prepared = prepare(root);
  if ('code' in prepared) return refuse(prepared);
  const scene = resolveSmokeScene(prepared.project, io.cwd, args.scene ?? '');
  if (typeof scene !== 'string') return refuse(scene);
  return withSmokeBundle(dir =>
    runGrid({
      combos: gridCombos(args.axes),
      parallel: args.parallel,
      checkDeterminism: args.checkDeterminism,
      io,
      json: args.json,
      golden: args.golden,
      goldenRead: golden,
      play: async combo => {
        const options: RunSmokeOptions = {
          ...common,
          run: { ...common.run, ...overridesOf(combo) },
          ...(combo.size ? { canvas: { width: combo.size.width, height: combo.size.height } } : {}),
          ...(common.bot && combo.botArgs ? { bot: { ...common.bot, args: combo.botArgs } } : {}),
        };
        const outcome = await runInWorker(
          dir,
          jobFor(prepared, scene, options),
          common.timeoutSec ?? DEFAULT_TIMEOUT_SEC
        );
        if (isSmokeFailure(outcome))
          return { verdict: 'error', game: null, errors: [`${outcome.code}: ${outcome.reason}`] };
        return {
          verdict: smokeVerdict(outcome),
          frames: outcome.bot?.frames ?? outcome.frames,
          game: outcome.game?.snapshot ?? null,
          ...(outcome.analytics ? { analytics: outcome.analytics } : {}),
          ...(outcome.haptics ? { haptics: outcome.haptics } : {}),
          errors: [
            ...outcome.errors.map(error => `frame ${error.frame} ${error.code}: ${error.message}`),
            ...(outcome.bot?.error ? [outcome.bot.error.message] : []),
          ],
        };
      },
    })
  );
};

/** For specs: a report's error list as `frame code script: message` lines. */
export const errorSummary = (outcome: SmokeOutcome): string[] =>
  isSmokeFailure(outcome)
    ? [`${outcome.code}: ${outcome.reason}`]
    : outcome.errors.map(
        e => `${e.frame} ${e.code}${e.script ? ` ${e.script}` : ''}: ${e.message}`
      );
