/**
 * `pix3 smoke` report shapes, shared by the CLI side (`command.ts`, plain Node) and the worker that
 * runs the game (`worker.ts`, bundled with the runtime). No imports: both sides load this file.
 */

/** What went wrong while the game ran. Every one of these makes the run fail (exit 1). */
export type SmokeErrorCode =
  /** A script lifecycle hook (`onAttach`/`onStart`/`onUpdate`/…) threw; the engine disabled it. */
  | 'E_SMOKE_SCRIPT'
  /** A script (or the engine) needed a browser API the headless run does not provide. */
  | 'E_SMOKE_DOM'
  /** The engine's own tick threw outside any script hook. */
  | 'E_SMOKE_TICK'
  /** A game command handler threw. */
  | 'E_SMOKE_COMMAND'
  /** Something called `console.error` (not the engine re-reporting one of the above). */
  | 'E_SMOKE_CONSOLE_ERROR'
  /** A promise rejected and nobody handled it, or a timer callback threw. */
  | 'E_SMOKE_UNHANDLED'
  /** The scene could not be loaded or started. */
  | 'E_SMOKE_LOAD'
  /** The project's scripts do not compile. */
  | 'E_SMOKE_SCRIPT_COMPILE'
  /** The compiled scripts threw at module top level when imported. */
  | 'E_SMOKE_SCRIPT_IMPORT';

export interface SmokeError {
  readonly code: SmokeErrorCode;
  /** 0 = loading and starting the scene (`onAttach`/`onStart`), N = the N-th stepped frame. */
  readonly frame: number;
  /** Component type, e.g. `user:GameRules`. */
  readonly script?: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
  /** Lifecycle phase the runtime reported (`start`, `update`, `attach`, `tick`, `command`, …). */
  readonly phase?: string;
  readonly message: string;
  readonly stack?: string;
  /** Browser globals/properties read (and missing) shortly before this error. */
  readonly domAccess?: readonly string[];
}

export type SmokeWarningCode =
  | 'W_SMOKE_MISSING_RESOURCE'
  | 'W_SMOKE_PENDING_COMPONENT'
  | 'W_SMOKE_LOADER'
  | 'W_SMOKE_CONSOLE_WARN'
  | 'W_SMOKE_STUBBED_IMPORT'
  | 'W_SMOKE_STOPPED'
  /** A `--command` named no registered game command, or its handler refused it. */
  | 'W_SMOKE_COMMAND'
  /** A visible `Sprite2D` names a texture that was never loaded: it draws as a white quad. */
  | 'W_SMOKE_UNTEXTURED';

export interface SmokeWarning {
  readonly code: SmokeWarningCode;
  readonly frame?: number;
  readonly message: string;
  /** How many identical warnings were folded into this one. */
  readonly count?: number;
}

export interface SmokeTimings {
  /** Compiling + importing the project's scripts. */
  readonly compile: number;
  /** Loading the scene and running its `onAttach`/`onStart` (frame 0). */
  readonly load: number;
  /** Frame 1 (the first stepped frame). */
  readonly firstFrame: number;
  /** Per stepped frame: engine tick time, not counting the async flush between frames. */
  readonly step: {
    readonly total: number;
    readonly mean: number;
    readonly p95: number;
    readonly max: number;
  };
  /** Whole run, worker start to report. */
  readonly total: number;
}

export interface SmokeReport {
  readonly ok: boolean;
  readonly scene: string;
  /** Frames actually stepped. */
  readonly frames: number;
  readonly framesRequested: number;
  /** The scene started and frame 1 ran with no error attributed to frames 0–1. */
  readonly firstFrameOk: boolean;
  readonly errors: readonly SmokeError[];
  readonly warnings: readonly SmokeWarning[];
  readonly nodes: { readonly start: number; readonly end: number };
  readonly timingsMs: SmokeTimings;
  /** `user:` components registered from the project's scripts. */
  readonly scripts: readonly string[];
  /** Browser properties read but not provided by the shim (feature detection included). */
  readonly domMissing: readonly string[];
  /** What the headless run could not do (models not decoded, audio silent, …). */
  readonly notes: readonly string[];
  /** The game's `registerGameDebug` provider at the end of the run, when it registered one. */
  readonly game: { readonly name: string; readonly snapshot: unknown } | null;
  /** `console.log`/`info` from the run: the total, and the first lines (frame-stamped). */
  readonly logs: { readonly count: number; readonly lines: readonly string[] };
  /**
   * What the game tracked through `scene.analytics` (absent when it tracked nothing): the total,
   * events dropped before a sink was added, and the last 500 events with their frames.
   */
  readonly analytics?: SmokeAnalytics;
  /** `--record`: the recording's text (the CLI writes it to the file and drops it from the report). */
  readonly recording?: string;
  /** `--replay`: how the recording played back. */
  readonly replay?: SmokeReplay;
}

/** `pix3 smoke --replay`: the runtime's `RunTapeReplayResult`. */
export interface SmokeReplay {
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
    readonly recorded: unknown;
    readonly replayed: unknown;
  } | null;
  readonly stopped: string | null;
  readonly notes: readonly string[];
}

/** One human line for a run's `scene.analytics` (shared by `pix3 smoke` and `pix3 play`). */
export const analyticsSummary = (analytics: SmokeAnalytics): string => {
  const distinct = [...new Set(analytics.events.map(event => event.name))];
  const shown = distinct.slice(0, 8).join(', ') + (distinct.length > 8 ? ', …' : '');
  const dropped = analytics.dropped > 0 ? `, ${analytics.dropped} dropped before a sink` : '';
  return `analytics: ${analytics.total} event(s) tracked (${shown})${dropped}`;
};

export interface SmokeAnalytics {
  readonly total: number;
  readonly dropped: number;
  readonly events: readonly {
    readonly name: string;
    readonly props: Readonly<Record<string, unknown>>;
    readonly frame: number;
  }[];
}

/** The run could not happen at all (exit 2). */
export type SmokeFailureCode =
  | 'E_SMOKE_USAGE'
  | 'E_SMOKE_NO_PROJECT'
  | 'E_SMOKE_NO_SCENE'
  | 'E_SMOKE_BUNDLE'
  | 'E_SMOKE_UNSUPPORTED'
  | 'E_SMOKE_TIMEOUT'
  | 'E_SMOKE_CRASH'
  | 'E_EDITOR_UNSYNCED'
  /** The project installs another `@pix3/runtime` than the one this CLI runs scenes with. */
  | 'E_RUNTIME_VERSION'
  /** `--replay` names a file this engine cannot replay (the reasons say why). */
  | 'E_SMOKE_REPLAY_FILE';

export interface SmokeFailure {
  readonly ok: false;
  readonly code: SmokeFailureCode;
  readonly reason: string;
  readonly scene?: string;
}

export type SmokeOutcome = SmokeReport | SmokeFailure;

/**
 * `pix3 smoke` with no scene argument: several scenes, each run on its own (`runs`, in run order).
 * `ok` = every run ran and reported no error.
 */
export interface SmokeRunSet {
  readonly ok: boolean;
  /** `changed` = the scenes uncommitted changes reach; `all` = every top-level scene. */
  readonly selection: 'changed' | 'all';
  /** Why these scenes, in words. */
  readonly reason: string;
  /** Project files git reported as changed, when git was asked. */
  readonly changed?: readonly string[];
  readonly runs: readonly SmokeOutcome[];
}

/**
 * Every code `pix3 smoke` can print — the kit drift spec holds the kit's mentions to this list.
 * @internal Read by `kit.spec.ts` only (knip --production skips it).
 */
export const SMOKE_CODES: Readonly<
  Record<SmokeErrorCode | SmokeWarningCode | SmokeFailureCode, 'error' | 'warning' | 'failure'>
> = {
  E_SMOKE_SCRIPT: 'error',
  E_SMOKE_DOM: 'error',
  E_SMOKE_TICK: 'error',
  E_SMOKE_COMMAND: 'error',
  E_SMOKE_CONSOLE_ERROR: 'error',
  E_SMOKE_UNHANDLED: 'error',
  E_SMOKE_LOAD: 'error',
  E_SMOKE_SCRIPT_COMPILE: 'error',
  E_SMOKE_SCRIPT_IMPORT: 'error',
  W_SMOKE_MISSING_RESOURCE: 'warning',
  W_SMOKE_PENDING_COMPONENT: 'warning',
  W_SMOKE_LOADER: 'warning',
  W_SMOKE_CONSOLE_WARN: 'warning',
  W_SMOKE_STUBBED_IMPORT: 'warning',
  W_SMOKE_STOPPED: 'warning',
  W_SMOKE_COMMAND: 'warning',
  W_SMOKE_UNTEXTURED: 'warning',
  E_SMOKE_USAGE: 'failure',
  E_SMOKE_NO_PROJECT: 'failure',
  E_SMOKE_NO_SCENE: 'failure',
  E_SMOKE_BUNDLE: 'failure',
  E_SMOKE_UNSUPPORTED: 'failure',
  E_SMOKE_TIMEOUT: 'failure',
  E_SMOKE_CRASH: 'failure',
  E_EDITOR_UNSYNCED: 'failure',
  E_RUNTIME_VERSION: 'failure',
  E_SMOKE_REPLAY_FILE: 'failure',
};

export const isSmokeFailure = (outcome: SmokeOutcome): outcome is SmokeFailure => 'code' in outcome;

/** What the CLI hands the worker. */
export interface SmokeJob {
  readonly projectRoot: string;
  /** Project-relative scene path, no `res://`. */
  readonly scene: string;
  readonly frames: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** `pix3project.yaml` `autoloads:`, verbatim (the worker normalises it as every host does). */
  readonly autoloads?: unknown;
  /** Where `esbuild` resolves from (the bundle may live in a temp folder). */
  readonly esbuildSpecifier?: string;
  /** A folder whose `node_modules` has `three` (for `three/*` addons a project does not install). */
  readonly fallbackResolveDir?: string;
  /** `--command`: game commands to dispatch, each before its frame. */
  readonly commands?: readonly SmokeCommand[];
  /** `--seed` / `--config` / `--ads`: `SceneRunner.setRunOverrides` for the run. */
  readonly run?: SmokeRunOverrides;
  /** `--record`: record the run (`every` = ticks between checkpoints). */
  readonly record?: { readonly every?: number };
  /** `--replay`: a recording's text; it decides the run's settings, scene and length. */
  readonly replay?: string;
  /** The canvas in CSS px when it is not {@link viewport} (a replay: the recording's). */
  readonly canvas?: { readonly width: number; readonly height: number };
}

/** A smoke run's test settings: the `scene.random` seed, ad outcomes and component config overrides. */
export interface SmokeRunOverrides {
  readonly seed?: number;
  /** `RunOverrides.ads`: what every `platform` ad show does (`--ads reward,skip`). */
  readonly ads?: 'reward' | 'skip' | 'unavailable' | readonly ('reward' | 'skip' | 'unavailable')[];
  readonly config?: Record<string, Record<string, Record<string, unknown>>>;
}

/** One `--command name@frame`: `scene.commands.dispatch(name)` right before that frame steps. */
export interface SmokeCommand {
  readonly name: string;
  readonly frame: number;
  /** The handler's args object (`scene.commands.dispatch(name, args)`). */
  readonly args?: Record<string, unknown>;
}
