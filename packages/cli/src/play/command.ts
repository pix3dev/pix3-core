import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { resolveEsbuild, withCommandBundle } from '../package-root.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { findChrome, needsNoSandbox, describeChromeNotFound } from '../editor/chrome.ts';
import { readDevInfo } from '../editor/dev-server.ts';
import { PipeChrome, type CdpEvent } from './chrome-pipe.ts';
import { formatProfileHuman, type PlayProfile } from './profile-report.ts';
import { formatTreeHuman, type PlayTree } from './tree-report.ts';
import {
  analyticsSummary,
  hapticsSummary,
  type SmokeAnalytics,
  type SmokeHaptics,
} from '../smoke/report.ts';
import {
  formatReplayHuman,
  projectHash,
  readReplayFile,
  settleReplay,
  stampBuild,
  type ReplayOutcome,
  type ReplayReport,
} from '../replay-file.ts';
import {
  gridCombos,
  isGrid,
  jsonLabel,
  parseObjectList,
  parseSeedList,
  parseSizeList,
  runGrid,
  runPool,
  type GridAxes,
  type GridCombo,
  type GridPlay,
  type GridValue,
} from './grid.ts';
import {
  formatScreensHuman,
  loadScreens,
  screensSheetHtml,
  selectScreens,
  type ScreenPicture,
  type ScreenState,
  type ScreensReport,
} from './screens.ts';
import { ProjectFiles } from '../validate/project.ts';
import { resolveLocalization } from '../validate/localization-plan.ts';
import {
  formatGoldenHuman,
  goldenArgsOf,
  goldenFailed,
  goldenOf,
  readGolden,
  settleGolden,
  type GoldenArgs,
  type GoldenResult,
} from '../golden.ts';

/**
 * `pix3 play` — the game's own page (the dev server, or a built `dist/index.html` as it ships) in
 * a private headless Chrome at a phone's size, optionally driven by a bot policy: what the editor
 * does for a scene, done to the real page — the build included. No editor, no MCP, no human.
 */

interface PlayArgs {
  readonly target?: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scene?: string;
  readonly bot?: string;
  /** `--run '<json>'`: one `pix3_game_run` on the page (its params, as JSON). */
  readonly gameRun: Record<string, unknown> | null;
  /** Emulated `env(safe-area-inset-*)` in CSS px (a notch and a home indicator). */
  readonly safeArea: { top: number; right: number; bottom: number; left: number } | null;
  /** Shade the unsafe bands on the pictures (default with --safe-area; --no-safe-area-overlay). */
  readonly safeAreaOverlay: boolean;
  /** A test run's `RunOverrides` for the game, injected as `__PIX3_RUN__` (dev and dist). */
  readonly run: {
    seed?: number;
    locale?: string;
    reducedMotion?: boolean;
    storage?: 'memory' | { snapshot: Record<string, unknown> };
    ads?: AdRunOutcome | AdRunOutcome[];
    config?: Record<string, unknown>;
    record?: { every?: number };
    /** `--replay`: the recording's text; the page sets the run up from it. */
    replay?: string;
  } | null;
  /** `--record <file> [--every N]`: the run written as a `.pix3replay` (dev server only). */
  readonly record?: { readonly file: string; readonly every?: number };
  /** `--replay <file>`: play a recording back on the page (dev server only). */
  readonly replay?: string;
  /** `bot.args` for the policy, as one JSON object. */
  readonly botArgs: Record<string, unknown>;
  readonly seconds: number;
  /** With a bot: the budget in game frames (1/60 s each), whatever the page's frame rate. */
  readonly frames: number;
  readonly screenshot?: string;
  /** Where `bot.screenshot(name)` pictures go (default beside --screenshot, else .pix3/screenshots). */
  readonly shots?: string;
  readonly json: boolean;
  /** Measure the run: frame / logic / render times, FrameProfiler activities, renderer counters. */
  readonly profile: boolean;
  /** Read the live object tree at the end of the run. */
  readonly tree: boolean;
  /** `--golden <file> [--write] [--tolerance …]`: the run's end pinned in a file (`golden.ts`). */
  readonly golden: GoldenArgs | null;
  readonly project?: string;
  /** List values (`--seed 1..50`, `--size a,b`, …): one run per combination (`grid.ts`). */
  readonly grid: GridAxes | null;
  /** `--parallel N`: grid runs at a time (default 1). */
  readonly parallel: number;
  /** `--check-determinism`: every combination twice, the two ends compared. */
  readonly checkDeterminism: boolean;
  /**
   * `--screens [--only a,b]`: the gallery of `design/tests/screens.ts` (`screens.ts`), a picture
   * per state × `--locale` (`all` = the project's) × `--size`.
   */
  readonly screens: {
    readonly only: readonly string[];
    readonly locales: readonly GridValue<string>[] | 'all';
    readonly sizes: readonly GridValue<{ width: number; height: number; scale?: number }>[];
  } | null;
}

const DEFAULT_SIZE = { width: 390, height: 844 };
/** A bot's game-frame budget: two minutes of game time. */
const DEFAULT_BOT_FRAMES = 7200;
/** A bot run's wall-clock safety net. */
const DEFAULT_BOT_WALL_SECONDS = 300;

const STORAGE_HINT =
  '--storage takes memory, a snapshot {"version":N,"data":{…}} (what scene.storage.export() returns) or a file holding one';

/** `--storage memory | '<json>' | <file>` → `RunOverrides.storage`, or the error line. */
export const parseStorageArg = (
  value: string
): { storage: NonNullable<NonNullable<PlayArgs['run']>['storage']> } | { error: string } => {
  if (value === 'memory') return { storage: 'memory' };
  let text = value.trim();
  if (!text.startsWith('{')) {
    try {
      text = readFileSync(resolve(value), 'utf8');
    } catch {
      return { error: `${STORAGE_HINT} (no file ${value})` };
    }
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(text);
  } catch {
    snapshot = undefined;
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return isObject(snapshot) && isObject(snapshot.data)
    ? { storage: { snapshot } }
    : { error: STORAGE_HINT };
};

type AdRunOutcome = 'reward' | 'skip' | 'unavailable';
const AD_OUTCOMES: readonly string[] = ['reward', 'skip', 'unavailable'];

/**
 * `--ads reward | skip | unavailable | <a,b,…>` → `RunOverrides.ads` (one for every show, or one per
 * show in order), or the error line. Shared with `pix3 smoke`.
 */
export const parseAdsArg = (
  value: string | undefined
): { ads: AdRunOutcome | AdRunOutcome[] } | { error: string } => {
  const parts = (value ?? '').split(',').map(part => part.trim());
  if (parts.some(part => !AD_OUTCOMES.includes(part))) {
    return {
      error: '--ads takes reward, skip or unavailable, or a list by show order: reward,skip',
    };
  }
  const outcomes = parts as AdRunOutcome[];
  return { ads: outcomes.length === 1 ? outcomes[0] : outcomes };
};

/** Exported for the spec. */
export const parsePlayArgs = (argv: readonly string[]): PlayArgs | { error: string } | 'help' => {
  let target: string | undefined;
  let scale: number | undefined;
  let scene: string | undefined;
  let bot: string | undefined;
  let gameRun: Record<string, unknown> | null = null;
  let safeArea: PlayArgs['safeArea'] = null;
  let safeAreaOverlay = true;
  let reducedMotion = false;
  let seeds: GridValue<number>[] = [];
  let sizes: GridValue<{ width: number; height: number; scale?: number }>[] = [];
  const configs: GridValue<Record<string, unknown>>[] = [];
  const botArgsList: GridValue<Record<string, unknown>>[] = [];
  const locales: GridValue<string>[] = [];
  const storages: GridValue<NonNullable<NonNullable<PlayArgs['run']>['storage']>>[] = [];
  let parallel: number | undefined;
  let checkDeterminism = false;
  let screens = false;
  let localeAll = false;
  let only: string[] = [];
  let ads: NonNullable<PlayArgs['run']>['ads'];
  let seconds: number | undefined;
  let frames: number | undefined;
  let screenshot: string | undefined;
  let shots: string | undefined;
  let json = false;
  let profile = false;
  let tree = false;
  let golden: string | undefined;
  let write = false;
  let tolerance: string | undefined;
  let project: string | undefined;
  let record: string | undefined;
  let every: number | undefined;
  let replay: string | undefined;
  const given = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg];
    const value = (): string | undefined => inline ?? argv[++i];
    given.add(flag);
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--json') json = true;
    else if (flag === '--profile') profile = true;
    else if (flag === '--tree') tree = true;
    else if (flag === '--write') write = true;
    else if (flag === '--golden') golden = value();
    else if (flag === '--record') record = value();
    else if (flag === '--replay') replay = value();
    else if (flag === '--every') {
      every = Number(value());
      if (!Number.isInteger(every) || every < 1)
        return { error: '--every takes a whole number of ticks ≥ 1' };
    } else if (flag === '--tolerance') tolerance = value();
    else if (flag === '--size') {
      const parsed = parseSizeList(value() ?? '');
      if ('error' in parsed) return parsed;
      sizes = parsed;
    } else if (flag === '--locale') {
      const text = value() ?? '';
      if (text === 'all') {
        localeAll = true;
        continue;
      }
      for (const locale of text.split(',').map(part => part.trim())) {
        if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale))
          return { error: '--locale takes a locale code or a list: --locale ru,en' };
        locales.push({ value: locale, label: `locale=${locale}` });
      }
    } else if (flag === '--parallel') {
      parallel = Number(value());
      if (!Number.isInteger(parallel) || parallel < 1)
        return { error: '--parallel takes a whole number of runs at a time ≥ 1' };
    } else if (flag === '--check-determinism') checkDeterminism = true;
    else if (flag === '--screens') screens = true;
    else if (flag === '--only') {
      only = (value() ?? '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
      if (only.length === 0) return { error: '--only takes screen names: --only menu,result' };
    } else if (flag === '--scale') scale = Number(value());
    else if (flag === '--scene') scene = value();
    else if (flag === '--bot') bot = value();
    else if (flag === '--run') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value() ?? '');
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          error: `--run takes the params of pix3_game_run as one JSON object, e.g. --run '{"until":[{"kind":"frames","n":60}]}'`,
        };
      }
      gameRun = parsed as Record<string, unknown>;
    } else if (flag === '--safe-area') {
      const parts = (value() ?? '').split(',').map(Number);
      if (parts.length !== 4 || !parts.every(n => Number.isFinite(n) && n >= 0)) {
        return {
          error: '--safe-area takes top,right,bottom,left in CSS px, e.g. --safe-area 47,0,34,0',
        };
      }
      safeArea = { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
    } else if (flag === '--no-safe-area-overlay') safeAreaOverlay = false;
    else if (flag === '--reduced-motion') reducedMotion = true;
    else if (flag === '--storage') {
      const text = value() ?? '';
      const parsed = parseStorageArg(text);
      if ('error' in parsed) return parsed;
      storages.push({
        value: parsed.storage,
        label: text.length <= 40 ? `storage=${text}` : `storage#${storages.length + 1}`,
      });
    } else if (flag === '--ads') {
      const parsed = parseAdsArg(value());
      if ('error' in parsed) return parsed;
      ads = parsed.ads;
    } else if (flag === '--seed') {
      const parsed = parseSeedList(value() ?? '');
      if ('error' in parsed) return parsed;
      seeds = parsed;
    } else if (flag === '--config') {
      const parsed = parseObjectList(value() ?? '');
      if (!parsed) {
        return {
          error: `--config takes a JSON object {"<nodeId>": {"<componentId>": {"key": value}}}, e.g. --config '{"game-root":{"rules":{"moves":3}}}' — or a file holding one or a list of them; repeat it for a grid`,
        };
      }
      for (const config of parsed)
        configs.push({ value: config, label: jsonLabel('config', config, configs.length) });
    } else if (flag === '--bot-args') {
      const parsed = parseObjectList(value() ?? '');
      if (!parsed) {
        return {
          error: `--bot-args takes a JSON object, e.g. --bot-args '{"target":"lose"}' — or a file holding one or a list of them; repeat it for a grid`,
        };
      }
      for (const args of parsed)
        botArgsList.push({ value: args, label: jsonLabel('bot-args', args, botArgsList.length) });
    } else if (flag === '--seconds') seconds = Number(value());
    else if (flag === '--frames') frames = Number(value());
    else if (flag === '--screenshot') screenshot = value();
    else if (flag === '--shots') shots = value();
    else if (flag === '--project') project = value();
    else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (target === undefined) target = arg;
    else return { error: `one target at a time (got ${target} and ${arg})` };
  }
  if (bot && gameRun) {
    return {
      error: '--bot and --run are two runs: give one (a policy in --run is {"bot":{"name":…}})',
    };
  }
  if (every !== undefined && record === undefined)
    return { error: '--every sets the checkpoints of a recording: give it --record <file>' };
  if (record !== undefined && replay !== undefined)
    return { error: '--record and --replay are two runs: give one' };
  if (replay !== undefined) {
    const extra = [
      '--bot',
      '--run',
      '--seed',
      '--locale',
      '--config',
      '--ads',
      '--storage',
      '--reduced-motion',
      '--golden',
      '--scene',
      '--size',
      '--scale',
    ].filter(flag => given.has(flag));
    if (extra.length > 0)
      return {
        error: `--replay plays the recording's scene, settings, inputs and screen: drop ${extra.join(', ')}`,
      };
  }
  if (only.length > 0 && !screens) return { error: '--only picks screens: give it --screens' };
  if (localeAll && !screens)
    return { error: '--locale all is for --screens; a run or a grid takes codes: --locale ru,en' };
  if (screens) {
    // A screen's state is its entry in screens.ts; the command line only multiplies it.
    const owned = [
      '--bot',
      '--run',
      '--bot-args',
      '--seed',
      '--config',
      '--storage',
      '--scene',
      '--golden',
      '--record',
      '--replay',
      '--screenshot',
      '--profile',
      '--tree',
      '--check-determinism',
    ].filter(flag => given.has(flag));
    if (owned.length > 0)
      return {
        error: `--screens sets each state from design/tests/screens.ts: drop ${owned.join(', ')} (put it in a screen's overrides, scene or policy)`,
      };
  }
  const driven = bot !== undefined || gameRun !== null || replay !== undefined;
  const axes: GridAxes = {
    seed: seeds,
    config: configs,
    botArgs: botArgsList,
    size: sizes,
    locale: locales,
    storage: storages,
  };
  const grid =
    !screens && (isGrid(axes) || parallel !== undefined || checkDeterminism) ? axes : null;
  if (grid) {
    if (!bot && !gameRun)
      return {
        error:
          'a grid (list values, --parallel, --check-determinism) compares fixed-step runs: give it --bot <name> or --run',
      };
    const single = ['--record', '--replay', '--screenshot', '--profile', '--tree'].filter(flag =>
      given.has(flag)
    );
    if (single.length > 0)
      return { error: `${single.join(', ')} take(s) one run: drop it from a grid` };
  }
  const goldenArgs = goldenArgsOf(golden, write, tolerance);
  if (goldenArgs && 'error' in goldenArgs) return goldenArgs;
  // Only a fixed-step run ends the same way twice: a page left to itself runs in real time.
  if (goldenArgs && !driven)
    return {
      error: '--golden pins a fixed-step run: give it --bot <name> (and --seed N) or --run',
    };
  // A bot run paints every frame: at DPR 3 a headless page took 5–6 minutes a round
  // (core-tests/game13), so a bot defaults to 2; --scale 3 for the final pictures.
  scale ??= driven || screens ? 2 : 3;
  if (!Number.isFinite(scale) || scale <= 0) return { error: '--scale takes a positive number' };
  // With a bot the budget is game frames: a headless page at --scale 3 paints ~8 fps, and 60 wall
  // seconds were ~8 s of a fixed-tick game — a round never finished (core-tests/game9). Seconds
  // stay as the wall-clock safety net.
  // A screen without a policy: how long the page runs before its picture.
  const budget = seconds ?? (driven ? DEFAULT_BOT_WALL_SECONDS : screens ? 2 : 3);
  if (!Number.isFinite(budget) || budget <= 0)
    return { error: '--seconds takes a positive number' };
  const frameBudget = frames ?? DEFAULT_BOT_FRAMES;
  if (!Number.isInteger(frameBudget) || frameBudget <= 0)
    return { error: '--frames takes a positive whole number of game frames (60 = 1 s)' };
  const first = sizes[0]?.value;
  const base: PlayArgs = {
    target,
    width: first?.width ?? DEFAULT_SIZE.width,
    height: first?.height ?? DEFAULT_SIZE.height,
    scale: first?.scale ?? scale,
    scene,
    bot,
    gameRun,
    botArgs: {},
    safeArea,
    safeAreaOverlay,
    run:
      reducedMotion || ads !== undefined || record !== undefined
        ? {
            ...(reducedMotion ? { reducedMotion } : {}),
            ...(ads !== undefined ? { ads } : {}),
            ...(record !== undefined ? { record: every ? { every } : {} } : {}),
          }
        : null,
    seconds: budget,
    frames: frameBudget,
    screenshot,
    shots,
    json,
    profile,
    tree,
    golden: goldenArgs,
    project,
    ...(record !== undefined ? { record: { file: record, ...(every ? { every } : {}) } } : {}),
    ...(replay !== undefined ? { replay } : {}),
    grid,
    parallel: parallel ?? 1,
    checkDeterminism,
    screens: screens ? { only, locales: localeAll ? 'all' : locales, sizes } : null,
  };
  // A single run is the grid's one combination.
  return grid || screens ? base : argsForCombo(base, gridCombos(axes)[0]);
};

/** The run of one grid combination: its size, `bot.args` and `RunOverrides` over the base. */
const argsForCombo = (base: PlayArgs, combo: GridCombo): PlayArgs => {
  const run = {
    ...base.run,
    ...(combo.seed !== undefined ? { seed: combo.seed } : {}),
    ...(combo.locale !== undefined ? { locale: combo.locale } : {}),
    ...(combo.config !== undefined ? { config: combo.config } : {}),
    ...(combo.storage !== undefined
      ? { storage: combo.storage as NonNullable<PlayArgs['run']>['storage'] }
      : {}),
  };
  return {
    ...base,
    ...(combo.size
      ? {
          width: combo.size.width,
          height: combo.size.height,
          scale: combo.size.scale ?? base.scale,
        }
      : {}),
    botArgs: combo.botArgs ?? base.botArgs,
    run: Object.keys(run).length > 0 ? run : null,
  };
};

/** The page to open: an explicit URL or file, `dist`, else the running dev server, else `dist`. */
const resolveTarget = (
  args: PlayArgs,
  root: string | null,
  cwd: string
): string | { error: string } => {
  const withParam = (url: string, name: string, value: string | undefined): string =>
    value === undefined
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
  // --seed / --config / --reduced-motion / --storage are injected into the page before it loads (`__PIX3_RUN__`), dev and dist
  // alike — not in the URL.
  const withScene = (url: string): string => withParam(url, 'scene', args.scene);
  const dist = root ? join(root, 'dist', 'index.html') : null;
  if (args.target && /^(https?|file):/.test(args.target)) return withScene(args.target);
  if (args.target && args.target !== 'dist' && args.target !== 'dev') {
    const file = isAbsolute(args.target) ? args.target : resolve(cwd, args.target);
    const html = file.endsWith('.html') ? file : join(file, 'index.html');
    return existsSync(html) ? pathToFileURL(html).href : { error: `${html} does not exist` };
  }
  if (args.target !== 'dist') {
    const info = root ? readDevInfo(root) : null;
    if (info) return withScene(`${info.publicUrl ?? info.url}?clean`);
    if (args.target === 'dev') {
      return {
        error: 'no dev server is running for this project (`npm run dev`, or `npx pix3 editor`)',
      };
    }
  }
  if (dist && existsSync(dist)) {
    if (args.scene) return { error: '--scene needs the dev server: a build boots its entry scene' };
    return pathToFileURL(dist).href;
  }
  return {
    error:
      'nothing to play: no dev server is running and there is no dist/index.html (`npm run build`)',
  };
};

/**
 * The page's unsafe bands (`--safe-area`) shaded over everything, for one picture: a notch and a
 * home indicator are nothing on a headless page, and core-tests/game18 checked by arithmetic that
 * no HUD sat under them. Fixed divs above the canvas, gone again after the capture; they take no
 * pointer events and the game never sees them.
 */
export const safeAreaOverlayScript = (
  insets: NonNullable<PlayArgs['safeArea']>,
  show: boolean
): string => {
  if (!show) return `document.getElementById('__pix3_safe_area__')?.remove(), true`;
  const band = (side: string, size: number): string =>
    size > 0
      ? `<div style="position:fixed;${side}:0;${side === 'top' || side === 'bottom' ? `left:0;right:0;height:${size}px` : `top:0;bottom:0;width:${size}px`};background:rgba(255,0,170,0.35);border-${{ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side]}:1px dashed rgba(255,0,170,0.9)"></div>`
      : '';
  const html = [
    band('top', insets.top),
    band('right', insets.right),
    band('bottom', insets.bottom),
    band('left', insets.left),
  ].join('');
  return `(() => { const host = document.createElement('div'); host.id = '__pix3_safe_area__'; host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'; host.innerHTML = ${JSON.stringify(html)}; (document.body || document.documentElement).appendChild(host); return true; })()`;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface PlayReport {
  readonly url: string;
  readonly size: string;
  readonly status: string;
  readonly frames: number;
  readonly errors: string[];
  readonly bot?: Record<string, unknown>;
  /** `--run`: the page's `game_run` answer — the same report `pix3_game_run` gives. */
  readonly run?: Record<string, unknown>;
  readonly game: unknown;
  readonly screenshot?: string;
  /** The sounds the game asked for: how many, and the last ones with their frames. */
  readonly sounds?: { requested: number; last: { sound: string; frame: number }[] };
  /** What the game tracked through `scene.analytics` (absent when nothing). */
  readonly analytics?: SmokeAnalytics;
  /** Every `scene.haptics` call: counts by kind and result, the last 500 with frames. */
  readonly haptics?: SmokeHaptics;
  /** The pictures the policy took with `bot.screenshot(name)`, in order. */
  readonly screenshots?: readonly { name: string; frame: number; path: string }[];
  /** `--profile`: the measured window (`packages/vite-plugin/player/debug/profile.ts`). */
  readonly profile?: PlayProfile | { error: string };
  /** `--tree`: the live object tree at the end (`packages/vite-plugin/player/debug/tree.ts`). */
  readonly tree?: PlayTree | { error: string };
  /** `--golden`: matched, written, or the paths that differ. */
  readonly golden?: GoldenResult;
  /** `--record`: the file written and the ticks in it. */
  readonly recorded?: { readonly file: string; readonly ticks: number };
  /** `--replay`: how the recording played back on the page. */
  readonly replay?: ReplayReport;
}

/** How often the CLI asks the page whether the policy is done or wants a picture. */
const POLL_MS = 50;
/** How often a bot run reports its frame on stderr. */
const PROGRESS_MS = 15_000;

export const runPlayCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parsePlayArgs(argv);
  if (parsed === 'help') {
    io.stdout(COMMAND_USAGE.play);
    return 0;
  }
  if ('error' in parsed) {
    io.stderr(`pix3 play: ${parsed.error}\n\n${COMMAND_USAGE.play}`);
    return 2;
  }
  // A replay plays the recording's scene on its screen, with its settings (`__PIX3_RUN__.replay`).
  const replayPath = parsed.replay !== undefined ? resolve(io.cwd, parsed.replay) : null;
  const replayFile = replayPath ? readReplayFile(replayPath) : null;
  if (replayFile && 'error' in replayFile) {
    io.stderr(`pix3 play: ${replayFile.error}\n`);
    return 2;
  }
  const args: PlayArgs = replayFile
    ? {
        ...parsed,
        width: replayFile.header.viewport.width,
        height: replayFile.header.viewport.height,
        scale: replayFile.header.viewport.dpr,
        scene: replayFile.header.scene,
        run: { replay: replayFile.text },
      }
    : parsed;
  const env = io.env ?? process.env;
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  const url = resolveTarget(args, root, io.cwd);
  if (typeof url !== 'string') {
    io.stderr(`pix3 play: ${url.error}\n`);
    return 2;
  }
  if ((args.record || replayFile) && url.startsWith('file:')) {
    io.stderr(
      `pix3 play: --${args.record ? 'record' : 'replay'} needs the dev server (\`npm run dev\`): a build carries no recorder\n`
    );
    return 2;
  }
  // The policy a run plays: checked here, compiled only for a page that cannot import it itself
  // (a build — the dev page takes it from `virtual:pix3/bot-policies`, as the editor does).
  const policyName = args.bot ?? botNameOf(args.gameRun);
  const policyFile = policyName
    ? join(root ?? io.cwd, 'design', 'tests', 'bots', `${policyName}.ts`)
    : null;
  if (policyFile && !existsSync(policyFile)) {
    io.stderr(`pix3 play: no bot policy ${policyFile}\n`);
    return 2;
  }
  const golden =
    args.golden && !args.golden.write
      ? readGolden(args.golden, io.cwd, args.grid ? 'grid' : 'run')
      : null;
  if (golden && 'error' in golden) {
    io.stderr(`pix3 play: ${golden.error}\n`);
    return 2;
  }
  const screens = args.screens ? await loadGallery(args.screens, root ?? io.cwd) : null;
  if (screens && 'error' in screens) {
    io.stderr(`pix3 play: ${screens.error}\n`);
    return 2;
  }
  const chromePath = findChrome(env);
  if (!chromePath) {
    io.stderr(`pix3 play: ${describeChromeNotFound()}\n`);
    return 2;
  }

  const chrome = PipeChrome.launch(chromePath.path, {
    noSandbox: needsNoSandbox(chromePath.path, env),
  });
  let scripts: Promise<PageScripts> | null = null;
  const context: PlayContext = {
    io,
    url,
    root,
    policyName,
    policyFile,
    replayFile,
    replayPath,
    tag: '',
    // Built once for every run of a grid.
    pageScripts: () =>
      (scripts ??= withCommandBundle(
        'play',
        'page-debug.js',
        async outdir => (await import('./bundle.ts')).buildPlayBundle(outdir),
        async dir => {
          const bundle = await import('./bundle.ts');
          return { host: bundle.readPlayHost(dir), debug: bundle.readPlayDebug(dir) };
        }
      )),
  };
  try {
    if (screens) return await playScreens(chrome, args, screens, context);
    if (args.grid) return await playGrid(chrome, args, args.grid, context, golden);
    const { report, failed } = await playOnce(chrome, args, context);
    const goldenResult = args.golden
      ? settleGolden(args.golden, io.cwd, goldenOf(report.game, report.analytics), failed, golden)
      : null;
    const full: PlayReport = { ...report, ...(goldenResult ? { golden: goldenResult } : {}) };
    if (args.json) io.stdout(`${JSON.stringify(full, null, 2)}\n`);
    else io.stdout(formatPlayHuman(full));
    return failed || goldenFailed(goldenResult) ? 1 : 0;
  } catch (error) {
    io.stderr(`pix3 play: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await chrome.close();
  }
};

type ReplayFileRead = Exclude<ReturnType<typeof readReplayFile>, { error: string }>;
type GoldenRead = Exclude<ReturnType<typeof readGolden>, { error: string }>;

/** A file-name-safe form of a combination's label. */
const slug = (label: string): string =>
  label
    .replace(/[^A-Za-z0-9_.=-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'run';

/** A run's verdict in the grid's table. */
const verdictOf = (report: PlayReport, failed: boolean): GridPlay['verdict'] => {
  if (report.status !== 'running' || report.errors.length > 0) return 'error';
  if (report.bot?.error !== undefined) return 'crash';
  if (report.run && report.run.ok !== true) return 'error';
  return failed ? 'fail' : 'pass';
};

/**
 * The grid: every combination a fresh load in a browser context of its own, `--parallel` at a
 * time; with `--check-determinism` each one twice and the two ends compared. Exit 1 when a run
 * errored or crashed, a combination ended differently twice, or the aggregate's golden differs —
 * a lost round (`done(false)`) is a result the aggregate counts, not a failure.
 */
const playGrid = async (
  chrome: PipeChrome,
  args: PlayArgs,
  axes: GridAxes,
  context: PlayContext,
  golden: GoldenRead | null
): Promise<number> => {
  const { io, root } = context;
  const combos = gridCombos(axes);
  const shotsRoot = resolve(
    io.cwd,
    args.shots ?? join(root ?? io.cwd, '.pix3', 'screenshots', `grid-${Date.now()}`)
  );
  const once = async (
    combo: GridCombo,
    pass: number
  ): Promise<{ report: PlayReport; failed: boolean }> => {
    const browserContext = await chrome.createContext();
    try {
      return await playOnce(
        chrome,
        { ...argsForCombo(args, combo), shots: join(shotsRoot, slug(combo.label)) },
        { ...context, browserContext, tag: ` [${combo.label}${pass > 0 ? ' again' : ''}]` }
      );
    } finally {
      await chrome.closeContext(browserContext).catch(() => undefined);
    }
  };
  return runGrid({
    combos,
    parallel: args.parallel,
    checkDeterminism: args.checkDeterminism,
    io,
    json: args.json,
    golden: args.golden,
    goldenRead: golden,
    play: async (combo, again) => {
      const { report, failed } = await once(combo, again ? 1 : 0);
      const frames = report.bot?.frames;
      return {
        verdict: verdictOf(report, failed),
        ...(typeof frames === 'number' ? { frames } : {}),
        game: report.game,
        ...(report.analytics ? { analytics: report.analytics } : {}),
        ...(report.haptics ? { haptics: report.haptics } : {}),
        errors: [
          ...report.errors,
          ...(report.bot?.error
            ? [String((report.bot.error as { message?: string }).message)]
            : []),
          ...(report.run && report.run.ok !== true
            ? [`${String(report.run.reason)}: ${String(report.run.detail ?? '')}`]
            : []),
        ],
      };
    },
  });
};

interface Gallery {
  readonly jobs: readonly { readonly screen: ScreenState; readonly combo: GridCombo }[];
  readonly policyFileOf: (screen: ScreenState) => string | null;
}

/** The pictures `--screens` takes: the listed states × locale × size, every policy found. */
const loadGallery = async (
  gallery: NonNullable<PlayArgs['screens']>,
  root: string
): Promise<Gallery | { error: string }> => {
  const loaded = await loadScreens(root);
  const screens = 'error' in loaded ? loaded : selectScreens(loaded, gallery.only);
  if ('error' in screens) return screens;
  const policyFileOf = (screen: ScreenState): string | null =>
    screen.policy ? join(root, 'design', 'tests', 'bots', `${screen.policy}.ts`) : null;
  for (const screen of screens) {
    const policyFile = policyFileOf(screen);
    if (policyFile && !existsSync(policyFile))
      return { error: `screen ${screen.name}: no bot policy ${policyFile}` };
  }
  const locales =
    gallery.locales === 'all'
      ? (resolveLocalization(new ProjectFiles(root))?.locales ?? []).map(value => ({
          value,
          label: `locale=${value}`,
        }))
      : gallery.locales;
  const combos = gridCombos({ locale: locales, size: gallery.sizes });
  return {
    jobs: screens.flatMap(screen => combos.map(combo => ({ screen, combo }))),
    policyFileOf,
  };
};

/**
 * `--screens`: every state of `design/tests/screens.ts` (or `--only` these) × locale × size, each
 * a fresh load in a browser context of its own with the state's `RunOverrides` (the locale axis
 * over the state's own), its scene and its policy (played to `done(true)`); the picture is the page
 * at the end. Then the contact sheet, drawn by the same Chrome, and `screens.json`. Exit 1 when a
 * picture errored (a page error, a policy that did not reach `done(true)`), 2 when the list is
 * unusable.
 */
const playScreens = async (
  chrome: PipeChrome,
  args: PlayArgs,
  gallery: Gallery,
  context: PlayContext
): Promise<number> => {
  const { io } = context;
  const root = context.root ?? io.cwd;
  const out = resolve(
    io.cwd,
    args.shots ?? join(root, '.pix3', 'screenshots', `screens-${Date.now()}`)
  );
  mkdirSync(out, { recursive: true });
  const { jobs, policyFileOf } = gallery;
  const pictures = await runPool(
    jobs.length,
    args.parallel,
    async (index): Promise<ScreenPicture> => {
      const { screen, combo } = jobs[index];
      const runArgs = argsForCombo({ ...args, scene: screen.scene, bot: screen.policy }, combo);
      const size = `${runArgs.width}x${runArgs.height}@${runArgs.scale}`;
      const stem = slug([screen.name, combo.locale, size].filter(Boolean).join('.'));
      const file = join(out, `${stem}.png`);
      const base: Omit<ScreenPicture, 'status' | 'errors' | 'shots'> = {
        screen: screen.name,
        ...(combo.locale ? { locale: combo.locale } : {}),
        size,
      };
      const broken = (error: string): ScreenPicture => ({
        ...base,
        status: 'error',
        errors: [error],
        shots: [],
      });
      const url = resolveTarget(runArgs, context.root, io.cwd);
      if (typeof url !== 'string') return broken(url.error);
      const browserContext = await chrome.createContext();
      try {
        const { report, failed } = await playOnce(
          chrome,
          {
            ...runArgs,
            run: { ...(screen.overrides as PlayArgs['run']), ...runArgs.run },
            screenshot: file,
            shots: join(out, stem),
            // A policy's wall-clock net; --seconds is how long a page without one runs.
            ...(screen.policy ? { seconds: DEFAULT_BOT_WALL_SECONDS } : {}),
          },
          {
            ...context,
            url,
            browserContext,
            policyName: screen.policy,
            policyFile: policyFileOf(screen),
            tag: ` [${[screen.name, combo.label === 'run' ? '' : combo.label].filter(Boolean).join(' ')}]`,
          }
        );
        const crash = report.bot?.error as { message?: string } | undefined;
        const done = report.bot?.done as { pass?: boolean; reason?: string } | undefined;
        const errors = [
          ...report.errors,
          ...(report.status !== 'running' ? [`the game is ${report.status}`] : []),
          ...(crash ? [`policy ${screen.policy}: ${crash.message ?? 'crashed'}`] : []),
          ...(screen.policy && !crash && done?.pass !== true
            ? [
                `policy ${screen.policy} ${done ? `ended done(false): ${done.reason ?? ''}` : `did not call done() within ${args.frames} frames`}`,
              ]
            : []),
        ];
        return {
          ...base,
          ...(report.screenshot ? { file: report.screenshot } : {}),
          status: failed || errors.length > 0 ? 'error' : 'ok',
          errors,
          shots: report.screenshots ?? [],
        };
      } catch (error) {
        return broken((error as Error).message);
      } finally {
        await chrome.closeContext(browserContext).catch(() => undefined);
      }
    }
  );
  const html = join(out, 'index.html');
  writeFileSync(
    html,
    screensSheetHtml(pictures, path =>
      relative(out, path).split(sep).map(encodeURIComponent).join('/')
    )
  );
  const sheet = join(out, 'sheet.png');
  const sheetError = await drawSheet(chrome, html, sheet).catch((error: Error) => error.message);
  const report: ScreensReport = {
    out,
    html,
    ...(sheetError ? {} : { sheet }),
    pictures,
  };
  writeFileSync(join(out, 'screens.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout(formatScreensHuman(report));
  if (sheetError) io.stderr(`pix3 play: the contact sheet was not drawn: ${sheetError}\n`);
  return pictures.some(picture => picture.status === 'error') ? 1 : 0;
};

/** Chrome's longest screenshot side; a taller sheet is drawn scaled down to it. */
const MAX_SHEET_PX = 16_000;

/** `index.html` of the gallery photographed whole, at 1 CSS px a pixel (or scaled to fit). */
const drawSheet = async (chrome: PipeChrome, html: string, png: string): Promise<null> => {
  const session = await chrome.openPage();
  try {
    await chrome.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      session
    );
    await chrome.send('Page.navigate', { url: pathToFileURL(html).href }, session);
    type Size = { width: number; height: number };
    let size = null as Size | null;
    for (const deadline = Date.now() + 20_000; !size && Date.now() < deadline; ) {
      await sleep(100);
      size = (await chrome
        .evaluate(
          session,
          `document.readyState === 'complete' && [...document.images].every(i => i.complete) ? { width: document.body.scrollWidth, height: document.body.scrollHeight } : null`
        )
        .catch(() => null)) as Size | null;
    }
    if (!size) throw new Error('the sheet page did not load in 20 s');
    const scale = Math.min(1, MAX_SHEET_PX / Math.max(size.width, size.height));
    const shot = (await chrome.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale },
      },
      session
    )) as { data?: string };
    writeFileSync(png, Buffer.from(shot.data ?? '', 'base64'));
    return null;
  } finally {
    await chrome.send('Page.close', {}, session).catch(() => undefined);
  }
};

interface PageScripts {
  readonly host: string;
  readonly debug: string;
}

/** What every run of one `pix3 play` shares. */
interface PlayContext {
  readonly io: CliIo;
  readonly url: string;
  readonly root: string | null;
  readonly policyName: string | undefined;
  readonly policyFile: string | null;
  readonly replayFile: ReplayFileRead | null;
  readonly replayPath: string | null;
  /** ` [seed=3]` in a grid's progress lines. */
  readonly tag: string;
  /** `browserContextId`: the run's own browser context (a grid's fresh load). */
  readonly browserContext?: string;
  readonly pageScripts: () => Promise<PageScripts>;
}

/**
 * One load of the page and one run on it: the report (golden aside) and whether it failed.
 * Throws only when Chrome itself does.
 */
const playOnce = async (
  chrome: PipeChrome,
  args: PlayArgs,
  context: PlayContext
): Promise<{ report: PlayReport; failed: boolean }> => {
  const { io, url, root, policyName, policyFile, replayFile, replayPath, tag } = context;
  const errors: string[] = [];
  const session = await chrome.openPage(context.browserContext);
  const unlisten = chrome.onEvent((event: CdpEvent) => {
    if (event.sessionId !== session) return;
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails as {
        text?: string;
        exception?: { description?: string };
      };
      errors.push(details.exception?.description ?? details.text ?? 'an uncaught exception');
    } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      const parts = (event.params.args as Array<{ value?: unknown; description?: string }>) ?? [];
      errors.push(parts.map(part => String(part.value ?? part.description ?? '')).join(' '));
    }
  });
  try {
    await chrome.send('Runtime.enable', {}, session);
    const overlay = args.safeArea && args.safeAreaOverlay ? args.safeArea : null;
    /** One PNG of the page, the unsafe bands shaded on it when --safe-area is given. */
    const capture = async (): Promise<Buffer> => {
      if (overlay) await chrome.evaluate(session, safeAreaOverlayScript(overlay, true));
      try {
        const shot = (await chrome.send('Page.captureScreenshot', { format: 'png' }, session)) as {
          data?: string;
        };
        return Buffer.from(shot.data ?? '', 'base64');
      } finally {
        if (overlay) await chrome.evaluate(session, safeAreaOverlayScript(overlay, false));
      }
    };
    await chrome.send(
      'Emulation.setDeviceMetricsOverride',
      { width: args.width, height: args.height, deviceScaleFactor: args.scale, mobile: true },
      session
    );
    if (args.safeArea) {
      // The page's real `env(safe-area-inset-*)`, so the player measures it as on a phone.
      await chrome
        .send('Emulation.setSafeAreaInsetsOverride', { insets: args.safeArea }, session)
        .catch((error: Error) => {
          throw new Error(
            `--safe-area needs a Chrome whose DevTools protocol has Emulation.setSafeAreaInsetsOverride (${error.message})`
          );
        });
    }
    await chrome.send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
      session
    );
    await chrome.send('Page.enable', {}, session);
    if (args.run) {
      // A test run's seed and config, there before the player reads them (`devRunOverrides`):
      // the build carries no test settings of its own, so dist plays the same seeded round
      // (core-tests/game12, game13 added "weak move" test modes to their games for want of it).
      await chrome.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `globalThis.__PIX3_RUN__ = ${JSON.stringify(args.run)};` },
        session
      );
    }
    await chrome.send('Page.navigate', { url }, session);

    // Booted when the player says so (`__PIX3_PLAYER__.status`), within 20 s.
    let status = 'booting';
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      await sleep(200);
      status = String(
        (await chrome
          .evaluate(session, 'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.status : "no-player"')
          .catch(() => 'loading')) ?? 'loading'
      );
      if (status === 'running' || status === 'failed') break;
    }

    let botReport: Record<string, unknown> | undefined;
    let profile: PlayReport['profile'];
    const shots: { name: string; frame: number; path: string }[] = [];
    const driven = status === 'running' && (args.bot !== undefined || args.gameRun !== null);
    const pageScripts =
      status === 'running' && (args.profile || args.tree || driven)
        ? await context.pageScripts()
        : null;
    /**
     * The profile starts once the game runs as it will for the whole window: after the bot set
     * its fixed-tick time mode. Its warm-up second is excluded inside the page.
     */
    const startProfile = async (): Promise<void> => {
      if (!args.profile || !pageScripts) return;
      try {
        await chrome.evaluate(session, pageScripts.debug);
        await chrome.evaluate(session, 'window.__PIX3_PAGE_DEBUG_HOST__.startPageProfile(), true');
      } catch (error) {
        profile = { error: (error as Error).message };
      }
    };
    const stopProfile = async (): Promise<void> => {
      if (!args.profile || profile) return;
      profile = (await chrome
        .evaluate(
          session,
          'window.__PIX3_PAGE_PROFILE__ ? JSON.parse(JSON.stringify(window.__PIX3_PAGE_PROFILE__.stop())) : null'
        )
        .catch((error: Error) => ({ error: error.message }))) as PlayReport['profile'];
      // The page reloaded under the run (Vite's full reload): the profile went with it.
      profile ??= { error: 'the page reloaded during the run and took the profile with it' };
    };
    /**
     * `__PIX3_PLAYER__.tools` on the page: the dev page imports the test host itself
     * (`loadTools()`); a build gets the CLI's IIFE and the policy compiled here. A sentence when
     * the page cannot have them.
     */
    const installTools = async (): Promise<string | null> => {
      const answer = String(
        await chrome.evaluate(
          session,
          `(async () => { const p = window.__PIX3_PLAYER__; if (p.tools) return 'ok'; if (!p.loadTools) return 'inject'; try { await p.loadTools(); return 'ok'; } catch (error) { return 'error: ' + ((error && error.message) || error); } })()`,
          60_000
        )
      );
      if (answer === 'ok') return null;
      if (answer !== 'inject') return answer.replace(/^error: /, '');
      if (!pageScripts) return 'the page tools could not be built';
      let policy = '';
      if (policyFile) {
        const esbuild = resolveEsbuild();
        if (!esbuild) return 'esbuild is not installed (npm install), so the policy cannot compile';
        try {
          policy = await (await import('./bundle.ts')).compilePolicy(esbuild, policyFile);
        } catch (error) {
          return `the policy does not compile: ${(error as Error).message}`;
        }
      }
      await chrome.evaluate(session, pageScripts.host);
      if (policy) await chrome.evaluate(session, policy);
      const key = JSON.stringify(`/design/tests/bots/${policyName}.ts`);
      await chrome.evaluate(
        session,
        `window.__PIX3_PAGE_TEST_HOST__.installPageTools({ botPolicies: () => (window.__PIX3_BOT_POLICY__ ? { [${key}]: window.__PIX3_BOT_POLICY__ } : {}) }), true`
      );
      return null;
    };
    const toolsError = driven ? await installTools() : null;
    /** One page tool call, its answer as plain JSON; a throw becomes a refusal. */
    const callTool = async (name: string, params: unknown): Promise<Record<string, unknown>> =>
      (await chrome.evaluate(
        session,
        `window.__PIX3_PLAYER__.tools.call(${JSON.stringify(name)}, ${JSON.stringify(params)}).then(r => JSON.parse(JSON.stringify(r)), e => ({ ok: false, reason: 'error', detail: String((e && e.message) || e) }))`,
        60_000
      )) as Record<string, unknown>;
    let runReport: Record<string, unknown> | undefined;
    const started = Date.now();
    let replayOutcome: ReplayOutcome | null = null;
    let replayShot: string | undefined;
    /**
     * `--replay`: the page steps the recording (`window.__PIX3_RUN_TAPE__`, `player/dev/run-tape.ts`);
     * on a divergence it stays on that tick, and the picture is taken there.
     */
    const driveReplay = async (): Promise<ReplayOutcome> => {
      const refused = (await chrome.evaluate(
        session,
        '(() => { const t = window.__PIX3_RUN_TAPE__; if (!t) return ["the page set no replay up (is the dev server\'s player older than this CLI?)"]; if (t.errors) return t.errors; t.start(); return null; })()'
      )) as string[] | null;
      const stoppedWith = (stopped: string): ReplayOutcome => ({
        ok: false,
        ticks: 0,
        end: replayFile!.header.end,
        checkpoints: 0,
        divergence: null,
        stopped,
        notes: [],
      });
      if (refused) return stoppedWith(`not replayable: ${refused.join('; ')}`);
      let lastProgress = Date.now();
      for (const deadline = Date.now() + args.seconds * 1000; Date.now() < deadline; ) {
        await sleep(POLL_MS);
        const poll = (await chrome
          .evaluate(
            session,
            '(() => { const t = window.__PIX3_RUN_TAPE__; return t ? { tick: t.tick, result: t.result ? JSON.parse(JSON.stringify(t.result)) : null } : { gone: true }; })()'
          )
          .catch(() => ({}))) as { gone?: boolean; tick?: number; result?: ReplayOutcome | null };
        if (poll.gone) return stoppedWith('the page reloaded during the replay');
        if (poll.result) {
          if (poll.result.divergence && replayPath) {
            await chrome.evaluate(session, 'window.__PIX3_PLAYER__.runner.renderOnce(), true');
            replayShot = `${replayPath.replace(/\.pix3replay$/, '')}.tick-${poll.result.divergence.to}.png`;
            writeFileSync(replayShot, await capture());
          }
          return poll.result;
        }
        if (Date.now() - lastProgress >= PROGRESS_MS) {
          lastProgress = Date.now();
          io.stderr(`pix3 play: replay at tick ${poll.tick ?? 0} of ${replayFile!.header.end}\n`);
        }
      }
      return stoppedWith(`the replay did not end within --seconds ${args.seconds}`);
    };
    if (toolsError && args.bot) {
      botReport = { name: args.bot, error: { message: toolsError } };
    } else if (toolsError) {
      runReport = { ok: false, reason: 'no_tools', detail: toolsError };
    }
    const botStart =
      !toolsError && driven && args.bot
        ? await callTool('bot_start', { name: args.bot, args: args.botArgs })
        : null;
    if (botStart && botStart.ok !== true) {
      botReport = {
        name: args.bot,
        error: { message: String(botStart.detail ?? 'did not start') },
      };
    } else if (botStart) {
      await startProfile();
      // One evaluate per poll: whether the policy is done, and the next picture it asked for
      // (`bot.screenshot`) — the page holds the game paused on that frame until `resume()`.
      const shotDir = resolve(
        io.cwd,
        args.shots ??
          join(
            args.screenshot
              ? dirname(args.screenshot)
              : join(root ?? io.cwd, '.pix3', 'screenshots'),
            `play-${Date.now()}`
          )
      );
      let gone = false;
      let lastProgress = Date.now();
      for (const deadline = Date.now() + args.seconds * 1000; Date.now() < deadline; ) {
        await sleep(POLL_MS);
        const poll = (await chrome.evaluate(
          session,
          '(() => { const b = window.__PIX3_PAGE_BOT__; if (!b) return { gone: true }; return { finished: b.finished, frame: b.frame, shot: b.takeShot() }; })()'
        )) as {
          gone?: boolean;
          finished?: boolean;
          frame?: number;
          shot?: { name: string; frame: number } | null;
        } | null;
        // The page reloaded under the bot (Vite's full reload after a project file changed, a
        // navigation): the policy went with it (core-tests/game14 read a TypeError on `finished`).
        if (poll?.gone) {
          gone = true;
          break;
        }
        // A heartbeat for whoever waits on a long round: a bot that loops shows itself here.
        if (Date.now() - lastProgress >= PROGRESS_MS) {
          lastProgress = Date.now();
          io.stderr(
            `pix3 play${tag}: bot ${args.bot} at frame ${poll?.frame ?? 0} of ${args.frames} (${Math.round((Date.now() - started) / 1000)} s)\n`
          );
        }
        if (poll?.shot) {
          const png = await capture();
          const path = join(shotDir, `${poll.shot.name}.png`);
          mkdirSync(shotDir, { recursive: true });
          writeFileSync(path, png);
          shots.push({ name: poll.shot.name, frame: poll.shot.frame, path });
          await chrome.evaluate(session, 'window.__PIX3_PAGE_BOT__.resume()');
          continue;
        }
        if (poll?.finished || (poll?.frame ?? 0) >= args.frames) break;
      }
      if (!gone) await stopProfile();
      botReport = gone
        ? {
            name: args.bot,
            error: {
              message:
                'the page reloaded during the run and took the bot with it — Vite reloads the dev page when a project file changes (or the page navigated); run again once the files are quiet, or play dist',
            },
          }
        : ((await chrome.evaluate(session, 'window.__PIX3_PAGE_BOT__.stop()')) as Record<
            string,
            unknown
          >);
    } else if (!toolsError && driven && args.gameRun) {
      // Started without waiting on it: a run lasts minutes, and the page may reload under it.
      await chrome.evaluate(
        session,
        `(() => { window.__PIX3_PAGE_RUN__ = { done: false }; window.__PIX3_PLAYER__.tools.call('game_run', ${JSON.stringify(args.gameRun)}).then(result => { window.__PIX3_PAGE_RUN__ = { done: true, result: JSON.parse(JSON.stringify(result)) }; }, error => { window.__PIX3_PAGE_RUN__ = { done: true, result: { ok: false, reason: 'error', detail: String((error && error.stack) || error) } }; }); return true; })()`
      );
      await startProfile();
      let lastProgress = Date.now();
      const poll = async (): Promise<{ gone?: boolean; done?: boolean; result?: unknown }> =>
        ((await chrome
          .evaluate(
            session,
            '(() => { const r = window.__PIX3_PAGE_RUN__; return r ? { done: r.done, result: r.done ? r.result : undefined } : { gone: true }; })()'
          )
          // A busy page can miss an answer; only a page without the run is a reloaded one.
          .catch(() => ({}))) ?? {}) as {
          gone?: boolean;
          done?: boolean;
          result?: unknown;
        };
      let last: Awaited<ReturnType<typeof poll>> = {};
      for (const deadline = Date.now() + args.seconds * 1000; Date.now() < deadline; ) {
        await sleep(POLL_MS);
        last = await poll();
        if (last.gone || last.done) break;
        if (Date.now() - lastProgress >= PROGRESS_MS) {
          lastProgress = Date.now();
          io.stderr(
            `pix3 play${tag}: game_run running (${Math.round((Date.now() - started) / 1000)} s)\n`
          );
        }
      }
      if (!last.gone && !last.done) {
        // Out of wall time: cancel, so the page lets go of its input and pause, then read it.
        await callTool('game_cancel', {}).catch(() => null);
        for (let tries = 0; tries < 40 && !last.done && !last.gone; tries += 1) {
          await sleep(POLL_MS);
          last = await poll();
        }
      }
      if (!last.gone) await stopProfile();
      runReport = last.gone
        ? {
            ok: false,
            reason: 'page_reloaded',
            detail:
              'the page reloaded during the run and took it with it — Vite reloads the dev page when a project file changes (or the page navigated); run again once the files are quiet, or play dist',
          }
        : ((last.result as Record<string, unknown> | undefined) ?? {
            ok: false,
            reason: 'timeout',
            detail: `the run did not end within --seconds ${args.seconds}`,
          });
    } else if (status === 'running' && replayFile) {
      replayOutcome = await driveReplay();
    } else if (status === 'running' && !driven) {
      await startProfile();
      await sleep(args.seconds * 1000);
      await stopProfile();
    }
    if (args.profile && status === 'running') {
      profile ??= { error: 'the page reloaded during the run and took the profile with it' };
    } else if (args.profile) {
      profile = { error: `nothing measured: the game is ${status}` };
    }

    // `--record`: the page's recording, ended here, to its file with the project's build hash.
    let recorded: { file: string; ticks: number } | undefined;
    if (args.record && status === 'running') {
      const text = await chrome
        .evaluate(
          session,
          'window.__PIX3_RUN_TAPE__ && window.__PIX3_RUN_TAPE__.finish ? window.__PIX3_RUN_TAPE__.finish() : null'
        )
        .catch(() => null);
      if (typeof text === 'string' && root) {
        const file = resolve(io.cwd, args.record.file);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, stampBuild(text, projectHash(root)));
        const end = /"type":"end","tick":(\d+)/.exec(text.slice(text.lastIndexOf('{')));
        recorded = { file, ticks: Number(end?.[1] ?? 0) };
      } else {
        errors.push(
          'the page recorded nothing: it reloaded during the run, or its player is older than this CLI'
        );
      }
    }
    const replayReport: ReplayReport | undefined =
      replayOutcome && replayFile && replayPath && root
        ? {
            ...settleReplay(replayOutcome, replayPath, replayFile.header, projectHash(root)),
            ...(replayShot ? { screenshot: replayShot } : {}),
          }
        : undefined;
    const frames = Number(
      (await chrome.evaluate(
        session,
        'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.frames : 0'
      )) ?? 0
    );
    const playerErrors = ((await chrome.evaluate(
      session,
      'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.errors : []'
    )) ?? []) as string[];
    for (const error of playerErrors) if (!errors.includes(error)) errors.push(error);
    // A page that says `running` but never advanced its loop is as dead as a black one: the
    // run passes only when frames went by (the release check plays the built page on this).
    // A replay steps the game itself (manual time): the page's own loop stays still.
    if (status === 'running' && frames === 0 && !replayFile)
      errors.push(`the game booted but its loop ran no frame in ${args.seconds} s`);
    // The sounds the game asked for (`scene.audio.requested()`): nobody can listen to a headless
    // page, but which sound a round triggered, and when, is checkable (core-tests/game17).
    const journal = (await chrome
      .evaluate(
        session,
        `(() => { const r = window.__PIX3_PLAYER__ && window.__PIX3_PLAYER__.runner; const root = r && r.getLiveRootNodes()[0]; const a = root && root.scene && root.scene.audio; return a && a.requested ? JSON.parse(JSON.stringify(a.requested())) : null; })()`
      )
      .catch(() => null)) as { total: number; last: { sound: string; frame: number }[] } | null;
    const sounds =
      journal && journal.total > 0 ? { requested: journal.total, last: journal.last } : null;
    // The events the game tracked (`scene.analytics`), read without constructing the facade.
    const tracked = (await chrome
      .evaluate(
        session,
        `(() => { const r = window.__PIX3_PLAYER__ && window.__PIX3_PLAYER__.runner; const root = r && r.getLiveRootNodes()[0]; const s = root && root.scene; const a = s && s.analyticsRunReport ? s.analyticsRunReport() : null; return a ? JSON.parse(JSON.stringify(a)) : null; })()`
      )
      .catch(() => null)) as SmokeAnalytics | null;
    const analytics = tracked && tracked.total > 0 ? tracked : null;
    // Every `scene.haptics` call with its frame and result (on a desktop all `unavailable`).
    const haptics = (await chrome
      .evaluate(
        session,
        `(() => { const r = window.__PIX3_PLAYER__ && window.__PIX3_PLAYER__.runner; const root = r && r.getLiveRootNodes()[0]; const h = root && root.scene && root.scene.haptics; return h && h.runReport ? JSON.parse(JSON.stringify(h.runReport())) : null; })()`
      )
      .catch(() => null)) as SmokeHaptics | null;
    const game = await chrome
      .evaluate(
        session,
        'window.__PIX3_GAME_DEBUG__ && window.__PIX3_GAME_DEBUG__.snapshot ? JSON.parse(JSON.stringify(window.__PIX3_GAME_DEBUG__.snapshot())) : null'
      )
      .catch(() => null);

    // Evaluated again here: a page that reloaded during the run lost the first copy.
    let tree: PlayReport['tree'];
    if (args.tree && pageScripts) {
      tree = (await chrome
        .evaluate(
          session,
          `${pageScripts.debug}\n;JSON.parse(JSON.stringify(window.__PIX3_PAGE_DEBUG_HOST__.liveTree(window.__PIX3_RUNTIME_SCENE__ ?? null)))`
        )
        .catch((error: Error) => ({ error: error.message }))) as PlayReport['tree'];
    } else if (args.tree) {
      tree = { error: `the game is ${status}` };
    }

    let screenshotPath: string | undefined;
    if (args.screenshot) {
      const png = await capture();
      screenshotPath = resolve(io.cwd, args.screenshot);
      mkdirSync(dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, png);
    }

    const done = botReport?.done as { pass?: boolean; reason?: string } | undefined;
    const botFailed =
      botReport !== undefined && (done?.pass !== true || botReport.error !== undefined);
    const runFailed = runReport !== undefined && !runPassed(runReport);
    const failed =
      status !== 'running' ||
      errors.length > 0 ||
      botFailed ||
      runFailed ||
      (replayFile !== null && replayReport?.ok !== true);
    const report: PlayReport = {
      url,
      size: `${args.width}x${args.height}@${args.scale}x`,
      status,
      frames,
      errors,
      ...(botReport ? { bot: botReport } : {}),
      ...(runReport ? { run: runReport } : {}),
      game,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(shots.length > 0 ? { screenshots: shots } : {}),
      ...(sounds ? { sounds } : {}),
      ...(analytics ? { analytics } : {}),
      ...(haptics ? { haptics } : {}),
      ...(profile ? { profile } : {}),
      ...(tree ? { tree } : {}),
      ...(recorded ? { recorded } : {}),
      ...(replayReport ? { replay: replayReport } : {}),
    };
    return { report, failed };
  } finally {
    unlisten();
  }
};

/** The policy a `--run` plays, if any (`{"bot": {"name": …}}`). */
const botNameOf = (gameRun: Record<string, unknown> | null): string | undefined => {
  const bot = gameRun?.bot as { name?: unknown } | undefined;
  return typeof bot?.name === 'string' && bot.name.trim() ? bot.name.trim() : undefined;
};

/** Outcomes that pass a run: a met `until`, or the policy's own `done(true)`. */
const PASSING_OUTCOMES = new Set(['until', 'bot-pass']);

const runPassed = (run: Record<string, unknown>): boolean =>
  run.ok === true && PASSING_OUTCOMES.has(String((run.outcome as { kind?: unknown })?.kind));

const formatRunHuman = (run: Record<string, unknown>): string[] => {
  if (run.ok !== true) {
    return [`run: REFUSED ${String(run.reason ?? '')} — ${String(run.detail ?? run.error ?? '')}`];
  }
  const outcome = run.outcome as { kind?: string; frame?: number } | undefined;
  const lines = [
    `run: ${runPassed(run) ? 'PASS' : 'FAIL'} (${outcome?.kind ?? '?'} at frame ${outcome?.frame ?? '?'}) — ${String(run.verdict ?? '')}`,
  ];
  for (const note of ((run.notes as string[] | undefined) ?? []).slice(0, 6)) {
    lines.push(`  note: ${note}`);
  }
  return lines;
};

const formatPlayHuman = (report: PlayReport): string => {
  const lines = [
    `${report.url} at ${report.size}: ${report.status}, ${report.frames} frame(s)`,
    ...report.errors.map(error => `  error: ${error}`),
  ];
  if (report.bot) {
    const done = report.bot.done as { pass?: boolean; reason?: string; frame?: number } | undefined;
    const crash = report.bot.error as { message?: string } | undefined;
    lines.push(
      crash
        ? `bot ${String(report.bot.name)}: CRASHED — ${crash.message ?? ''}`
        : done
          ? `bot ${String(report.bot.name)}: ${done.pass ? 'PASS' : 'FAIL'} at frame ${done.frame} — ${done.reason}`
          : `bot ${String(report.bot.name)}: no verdict in the time given (${String(report.bot.frames)} ticks, ${String(report.bot.sent)} action(s))`
    );
    const log = (report.bot.log as Array<{ frame: number; kind: string; message: string }>) ?? [];
    for (const entry of log.slice(-12))
      lines.push(`  [${entry.frame}] ${entry.kind}: ${entry.message}`);
  }
  if (report.run) lines.push(...formatRunHuman(report.run));
  if (report.game !== null && report.game !== undefined) {
    lines.push(`game: ${JSON.stringify(report.game)}`);
  }
  if (report.sounds) {
    const distinct = [...new Set(report.sounds.last.map(entry => entry.sound))];
    lines.push(
      `sounds: ${report.sounds.requested} requested${distinct.length ? ` (${distinct.slice(0, 8).join(', ')}${distinct.length > 8 ? ', …' : ''})` : ''}`
    );
  }
  if (report.analytics) lines.push(analyticsSummary(report.analytics));
  if (report.haptics) lines.push(hapticsSummary(report.haptics));
  if (report.screenshot) lines.push(`screenshot: ${report.screenshot}`);
  for (const shot of report.screenshots ?? [])
    lines.push(`screenshot ${shot.name} (frame ${shot.frame}): ${shot.path}`);
  if (report.profile) lines.push(...formatProfileHuman(report.profile));
  if (report.tree) lines.push(...formatTreeHuman(report.tree));
  if (report.golden) lines.push(...formatGoldenHuman(report.golden));
  if (report.replay) lines.push(...formatReplayHuman(report.replay));
  if (report.recorded)
    lines.push(`recorded ${report.recorded.ticks} tick(s): ${report.recorded.file}`);
  return `${lines.join('\n')}\n`;
};
