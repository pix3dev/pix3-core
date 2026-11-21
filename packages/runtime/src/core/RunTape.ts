/**
 * Record a run and play it back (`pix3 play --record`, `pix3 smoke --replay`, `pix3 play --replay`).
 *
 * A recording keeps only what came from OUTSIDE the game, at the logical tick it reached it — DOM
 * pointer / key / wheel input, commands dispatched from outside (`commands.dispatchExternal`), a
 * trip to the background, a focus loss, how each ad show ended — plus what the game cannot be
 * asked again: the run's settings (`RunOverrides`, the save it started from, the locale), the
 * time step of every tick and which ticks shared a frame. Everything the game does in answer,
 * including the commands it dispatches itself, is its behaviour: the file carries checkpoints of
 * it (every 30 ticks by default) and a replay compares them instead of feeding them back.
 *
 * The file is JSON Lines (`docs/pix3-specification.md`, "Replay files"): a `header`, then `scene`,
 * `tick` and `checkpoint` lines in tick order, then one `end`.
 *
 * Exact replay is promised in Node (`pix3 smoke --replay`: manual time, loads let land before the
 * next tick). A page replays best-effort: what a load took in ticks there is not what it takes
 * here, so a divergence near one is marked as likely load timing, and scene changes are aligned —
 * the replay waits for, or skips to, the tick the recording started each scene on.
 */

import { NodeBase } from '../nodes/NodeBase';
import { getGameDebug } from './game-debug';
import type { AdRunOutcome } from './platform-host';
import type { RunInput, RunTap } from './run-tap';
import type { RunOverrides, SceneRunner } from './SceneRunner';

/** The `format` this engine writes and reads. */
export const RUN_TAPE_FORMAT = 1;
/** Ticks between checkpoints unless the recording says otherwise. */
export const RUN_TAPE_CHECKPOINT_EVERY = 30;

export interface RunTapeHeader {
  readonly type: 'header';
  readonly format: number;
  /** Hash of the project the recording was made on; filled in by the CLI, null otherwise. */
  readonly build: string | null;
  /** The scene the run started in (project-relative). */
  readonly scene: string;
  /** The run's settings, its starting save included (`storage: { snapshot }`). */
  readonly run: RunOverrides;
  /** The time mode at the start; every tick's own step is on its `tick` line. */
  readonly time: { readonly mode: string; readonly fixedDeltaSec: number };
  /** The canvas in CSS px and the device pixel ratio. */
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly locale: string | null;
  readonly checkpointEvery: number;
}

/** One recorded input: its order in the tick and whether it came before the tick or during it. */
export type RunTapeInput = RunInput & { readonly seq: number; readonly phase: 'before' | 'after' };

export interface RunTapeTick {
  readonly type: 'tick';
  readonly tick: number;
  /** The tick's time step, when it changed from the previous tick's (the first: the header's). */
  dt?: number;
  /** This tick starts a frame of `f` ticks (a frame = ticks run back to back with no task turn). */
  f?: number;
  in?: RunTapeInput[];
}

/** What a checkpoint holds and a replay compares. */
export interface RunCheckpoint {
  /** The game's `registerGameDebug` snapshot, keys sorted, numbers rounded to 1e-6. */
  readonly state: unknown;
  /** Every live node by id: `p` position, `r` rotation (when not 0), `s` scale (when not 1), `v: 0` hidden. */
  readonly tree: Record<string, TreeEntry>;
  /** Commands journalled since the previous checkpoint (external and the game's own): `[name, status]`. */
  readonly commands: readonly (readonly [string, string])[];
}

export interface RunTapeCheckpoint extends RunCheckpoint {
  readonly type: 'checkpoint';
  readonly tick: number;
  /** A scene load or prefab spawn was in flight during the interval up to here. */
  readonly loading?: true;
}

export interface RunTapeScene {
  readonly type: 'scene';
  /** The scene's first tick. */
  readonly tick: number;
  readonly path: string | null;
}

export interface RunTape {
  readonly header: RunTapeHeader;
  readonly scenes: readonly RunTapeScene[];
  readonly ticks: ReadonlyMap<number, RunTapeTick>;
  readonly checkpoints: ReadonlyMap<number, RunTapeCheckpoint>;
  /** The last recorded tick. */
  readonly end: number;
}

interface TreeEntry {
  p: number[];
  r?: number[];
  s?: number[];
  v?: 0;
}

const round = (value: number, step: number): number => {
  const rounded = Math.round(value * step) / step;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** JSON data with sorted keys and rounded numbers: equal states serialise equally. */
const canonical = (value: unknown): unknown => {
  if (typeof value === 'number') return Number.isFinite(value) ? round(value, 1e6) : null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonical(entry);
    }
    return out;
  }
  return value;
};

const treeOf = (roots: readonly NodeBase[]): Record<string, TreeEntry> => {
  const entries = new Map<string, TreeEntry>();
  const visit = (node: NodeBase): void => {
    let key = node.nodeId;
    for (let n = 2; entries.has(key); n += 1) key = `${node.nodeId}#${n}`;
    const entry: TreeEntry = {
      p: [node.position.x, node.position.y, node.position.z].map(v => round(v, 1e4)),
    };
    const r = [node.rotation.x, node.rotation.y, node.rotation.z].map(v => round(v, 1e4));
    if (r.some(v => v !== 0)) entry.r = r;
    const s = [node.scale.x, node.scale.y, node.scale.z].map(v => round(v, 1e4));
    if (s.some(v => v !== 1)) entry.s = s;
    if (!node.visible) entry.v = 0;
    entries.set(key, entry);
    for (const child of node.children) if (child instanceof NodeBase) visit(child);
  };
  roots.forEach(visit);
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

const gameState = (): unknown => {
  try {
    return canonical(JSON.parse(JSON.stringify(getGameDebug()?.snapshot?.() ?? null)));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/** Reads the command journal in slices: what was added since the last read. */
class CommandCursor {
  private last: object | null = null;

  take(runner: SceneRunner): [string, string][] {
    const log = runner.getLiveRootNodes()[0]?.scene?.commands.log ?? [];
    // The last entry read is gone when a scene change cleared the journal: all of it is new.
    const from = this.last ? log.lastIndexOf(this.last as (typeof log)[number]) + 1 : 0;
    this.last = log.at(-1) ?? this.last;
    return log.slice(from).map(entry => [entry.name, entry.status]);
  }
}

const checkpointOf = (runner: SceneRunner, cursor: CommandCursor): RunCheckpoint => ({
  state: gameState(),
  tree: treeOf(runner.getLiveRootNodes()),
  commands: cursor.take(runner),
});

// --- Recording ------------------------------------------------------------------------------------

export interface RunRecordOptions {
  /** Ticks between checkpoints (default 30; 1 = every tick, a precise but large file). */
  readonly every?: number;
}

/**
 * Records a run from the runner it is attached to (`new RunRecorder(runner)` before the scene
 * starts) until {@link finish}, which returns the file's text.
 */
export class RunRecorder implements RunTap {
  private readonly every: number;
  private header: RunTapeHeader | null = null;
  private readonly scenes: RunTapeScene[] = [];
  private readonly ticks = new Map<number, RunTapeTick>();
  private readonly checkpoints: RunTapeCheckpoint[] = [];
  private readonly cursor = new CommandCursor();
  private tick = 0;
  private inTick = false;
  /** Inputs that arrived between ticks: the next tick's `before`. */
  private pending: RunInput[] = [];
  private seq = 0;
  private lastDt: number | null = null;
  private lastSize: { width: number; height: number } | null = null;
  /** The open frame: its first tick and length so far, and the length last declared (`f`). */
  private frameStart = 0;
  private frameLength = 0;
  private declaredFrame = 1;
  private loading = false;
  private finished: string | null = null;

  constructor(
    private readonly runner: SceneRunner,
    options: RunRecordOptions = {}
  ) {
    const every = options.every ?? RUN_TAPE_CHECKPOINT_EVERY;
    this.every = Number.isInteger(every) && every >= 1 ? every : RUN_TAPE_CHECKPOINT_EVERY;
    runner.setRunTap(this);
  }

  /** The tick the run is on (0 before the first). */
  get ticksRecorded(): number {
    return this.tick;
  }

  beforeTick(dt: number, frameStart: boolean): void {
    this.tick += 1;
    this.inTick = true;
    this.seq = 0;
    if (frameStart) this.closeFrame();
    if (this.frameLength === 0) this.frameStart = this.tick;
    this.frameLength += 1;
    if (dt !== this.lastDt) {
      this.line(this.tick).dt = dt;
      this.lastDt = dt;
    }
    const before = this.pending;
    this.pending = [];
    for (const input of before) this.push(input, 'before');
    if (this.runner.pendingLoads > 0) this.loading = true;
  }

  afterTick(): void {
    this.inTick = false;
    if (this.tick % this.every === 0) this.checkpoint();
  }

  input(input: RunInput): void {
    if (input.kind === 'resize') {
      const last = this.lastSize;
      if (last && last.width === input.width && last.height === input.height) return;
      this.lastSize = { width: input.width, height: input.height };
    }
    if (this.inTick) this.push(input, 'after');
    else this.pending.push(input);
  }

  sceneStarted(path: string | null): void {
    if (!this.header) this.writeHeader(path);
    this.scenes.push({ type: 'scene', tick: this.tick + 1, path });
    // The old scene's input layer and command registry were torn down with what they had queued:
    // only the page's own state carries over.
    this.pending = this.pending.filter(
      input => input.kind === 'background' || input.kind === 'blur'
    );
  }

  /** End the recording: a last checkpoint, the `end` line; the file's text (the same on a second call). */
  finish(): string {
    if (this.finished !== null) return this.finished;
    this.runner.setRunTap(null);
    this.closeFrame();
    if (!this.header) this.writeHeader(null);
    if (this.tick > 0 && this.checkpoints.at(-1)?.tick !== this.tick) this.checkpoint();
    // Tick order; within a tick: its scene, its inputs, then the checkpoint taken after it.
    const order = { scene: 0, tick: 1, checkpoint: 2 };
    const body = [...this.scenes, ...this.ticks.values(), ...this.checkpoints].sort(
      (a, b) => a.tick - b.tick || order[a.type] - order[b.type]
    );
    const lines: object[] = [this.header!, ...body];
    lines.push({ type: 'end', tick: this.tick });
    this.finished = `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
    return this.finished;
  }

  private writeHeader(scene: string | null): void {
    const start = this.runner.describeRunStart();
    const run: RunOverrides = { ...this.runner.getRunOverrides() };
    delete run.record;
    delete run.replay;
    const time = this.runner.getTimeMode();
    this.lastSize = { width: start.viewport.width, height: start.viewport.height };
    this.header = {
      type: 'header',
      format: RUN_TAPE_FORMAT,
      build: null,
      scene: scene ?? '',
      run: start.storage ? { ...run, storage: { snapshot: start.storage } } : run,
      time: { mode: time.mode, fixedDeltaSec: time.fixedDeltaSec },
      viewport: start.viewport,
      locale: start.locale,
      checkpointEvery: this.every,
    };
  }

  private line(tick: number): RunTapeTick {
    let line = this.ticks.get(tick);
    if (!line) {
      line = { type: 'tick', tick };
      this.ticks.set(tick, line);
    }
    return line;
  }

  private push(input: RunInput, phase: 'before' | 'after'): void {
    const line = this.line(this.tick);
    (line.in ??= []).push({ ...input, seq: this.seq++, phase });
  }

  /** The open frame is over: declare its length on its first tick when it differs from the last one. */
  private closeFrame(): void {
    if (this.frameLength === 0) return;
    if (this.frameLength !== this.declaredFrame) {
      this.line(this.frameStart).f = this.frameLength;
      this.declaredFrame = this.frameLength;
    }
    this.frameLength = 0;
  }

  private checkpoint(): void {
    this.checkpoints.push({
      type: 'checkpoint',
      tick: this.tick,
      ...checkpointOf(this.runner, this.cursor),
      ...(this.loading ? { loading: true as const } : {}),
    });
    this.loading = false;
  }
}

// --- Reading --------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number): value is number =>
  Number.isInteger(value) && (value as number) >= min;
const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const inputProblem = (input: Record<string, unknown>): string | null => {
  switch (input.kind) {
    case 'pointer':
      return ['down', 'move', 'up', 'cancel'].includes(input.type as string) &&
        Number.isInteger(input.id) &&
        isNum(input.x) &&
        isNum(input.y) &&
        typeof input.pointerType === 'string' &&
        Number.isInteger(input.button) &&
        Number.isInteger(input.buttons)
        ? null
        : 'a pointer input needs type down|move|up|cancel, id, x, y, pointerType, button, buttons';
    case 'key':
      return ['down', 'up'].includes(input.type as string) &&
        typeof input.code === 'string' &&
        typeof input.key === 'string' &&
        typeof input.repeat === 'boolean'
        ? null
        : 'a key input needs type down|up, code, key, repeat';
    case 'wheel':
      return isNum(input.dx) &&
        isNum(input.dy) &&
        ['ctrl', 'meta', 'shift', 'alt'].every(k => typeof input[k] === 'boolean')
        ? null
        : 'a wheel input needs dx, dy, ctrl, meta, shift, alt';
    case 'command':
      return typeof input.name === 'string' &&
        input.name !== '' &&
        (input.args === undefined || isObject(input.args))
        ? null
        : 'a command input needs a name (and args as an object)';
    case 'background':
      return isNum(input.awayMs) && input.awayMs >= 0
        ? null
        : 'a background input needs awayMs ≥ 0';
    case 'blur':
      return null;
    case 'resize':
      return isNum(input.width) && isNum(input.height) ? null : 'a resize needs width and height';
    case 'ad':
      return ['reward', 'skip', 'unavailable'].includes(input.outcome as string)
        ? null
        : 'an ad input needs outcome reward|skip|unavailable';
    default:
      return `unknown input kind ${JSON.stringify(input.kind)}`;
  }
};

const headerProblem = (line: Record<string, unknown>): string | null => {
  if (line.type !== 'header') return 'the first line is not the header ({"type":"header",…})';
  if (line.format !== RUN_TAPE_FORMAT)
    return `format ${JSON.stringify(line.format)} is not one this engine reads (${RUN_TAPE_FORMAT})`;
  if (typeof line.scene !== 'string' || line.scene === '') return 'the header names no scene';
  if (!isObject(line.run)) return 'the header has no run settings (run: {…})';
  const time = line.time;
  if (
    !isObject(time) ||
    typeof time.mode !== 'string' ||
    !isNum(time.fixedDeltaSec) ||
    time.fixedDeltaSec <= 0
  )
    return 'the header has no time ({ mode, fixedDeltaSec > 0 })';
  const view = line.viewport;
  if (
    !isObject(view) ||
    !isNum(view.width) ||
    !isNum(view.height) ||
    !isNum(view.dpr) ||
    view.width <= 0 ||
    view.height <= 0 ||
    view.dpr <= 0
  )
    return 'the header has no viewport ({ width, height, dpr } > 0)';
  if (!isInt(line.checkpointEvery, 1)) return 'checkpointEvery is not a whole number ≥ 1';
  if (line.build !== null && typeof line.build !== 'string')
    return 'build is neither a hash nor null';
  return null;
};

const MAX_PROBLEMS = 20;

/** Read a recording; every problem with its line number when it is not one this engine can replay. */
export const parseRunTape = (
  text: string
): { ok: true; tape: RunTape } | { ok: false; errors: string[] } => {
  const errors: string[] = [];
  const fail = (index: number, message: string): void => {
    if (errors.length < MAX_PROBLEMS) errors.push(`line ${index + 1}: ${message}`);
  };
  const rows = text.split('\n');
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
  const lines: Record<string, unknown>[] = [];
  rows.forEach((row, index) => {
    try {
      const parsed = JSON.parse(row) as unknown;
      if (isObject(parsed)) lines.push(parsed);
      else fail(index, 'not a JSON object');
    } catch {
      fail(index, 'not JSON');
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  if (lines.length === 0) return { ok: false, errors: ['the file is empty'] };
  const headerError = headerProblem(lines[0]);
  if (headerError) return { ok: false, errors: [`line 1: ${headerError}`] };

  const scenes: RunTapeScene[] = [];
  const ticks = new Map<number, RunTapeTick>();
  const checkpoints = new Map<number, RunTapeCheckpoint>();
  let end: number | null = null;
  let lastTick = 0;
  let lastCheckpoint = 0;
  let lastScene = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (end !== null) {
      fail(index, 'a line after the end');
      continue;
    }
    switch (line.type) {
      case 'scene':
        if (!isInt(line.tick, 1) || line.tick < lastScene || line.tick < lastTick)
          fail(index, 'a scene line needs a tick ≥ 1, in order');
        else if (line.path !== null && typeof line.path !== 'string')
          fail(index, 'a scene line needs a path');
        else {
          lastScene = line.tick;
          scenes.push(line as unknown as RunTapeScene);
        }
        break;
      case 'tick': {
        if (!isInt(line.tick, 1) || line.tick <= lastTick) {
          fail(index, 'tick numbers must be whole, ≥ 1 and increasing');
          break;
        }
        lastTick = line.tick;
        if (line.dt !== undefined && (!isNum(line.dt) || line.dt < 0))
          fail(index, 'dt must be a number ≥ 0');
        if (line.f !== undefined && !isInt(line.f, 1)) fail(index, 'f must be a whole number ≥ 1');
        if (line.in !== undefined) {
          if (!Array.isArray(line.in)) {
            fail(index, 'in must be a list of inputs');
            break;
          }
          let seq = -1;
          for (const input of line.in as unknown[]) {
            if (!isObject(input)) {
              fail(index, 'an input is not an object');
              continue;
            }
            const problem = inputProblem(input);
            if (problem) fail(index, problem);
            if (!isInt(input.seq, seq + 1)) fail(index, 'input seq numbers must increase');
            else seq = input.seq;
            if (input.phase !== 'before' && input.phase !== 'after')
              fail(index, 'an input phase is before or after');
          }
        }
        ticks.set(line.tick, line as unknown as RunTapeTick);
        break;
      }
      case 'checkpoint':
        if (!isInt(line.tick, 1) || line.tick <= lastCheckpoint || line.tick < lastTick)
          fail(index, 'checkpoint ticks must be whole, ≥ 1, increasing and not behind the ticks');
        else if (!('state' in line) || !isObject(line.tree) || !Array.isArray(line.commands))
          fail(index, 'a checkpoint needs state, tree and commands');
        else {
          lastCheckpoint = line.tick;
          checkpoints.set(line.tick, line as unknown as RunTapeCheckpoint);
        }
        break;
      case 'end':
        if (!isInt(line.tick, 0) || line.tick < Math.max(lastTick, lastCheckpoint, lastScene - 1))
          fail(index, 'the end tick must be whole and not before the last line');
        else end = line.tick;
        break;
      case 'header':
        fail(index, 'a second header');
        break;
      default:
        fail(index, `unknown line type ${JSON.stringify(line.type)}`);
    }
  }
  if (end === null) errors.push('no end line: the recording was cut short');
  if (scenes[0] && scenes[0].tick !== 1) errors.push('the first scene line is not at tick 1');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    tape: { header: lines[0] as unknown as RunTapeHeader, scenes, ticks, checkpoints, end: end! },
  };
};

/** The `RunOverrides` a replay runs with: the header's, ad outcomes as the recording saw them. */
export const runTapeOverrides = (tape: RunTape): RunOverrides => {
  const ads: AdRunOutcome[] = [];
  for (const tick of [...tape.ticks.values()].sort((a, b) => a.tick - b.tick)) {
    for (const input of tick.in ?? []) if (input.kind === 'ad') ads.push(input.outcome);
  }
  return ads.length > 0 ? { ...tape.header.run, ads } : tape.header.run;
};

// --- Replay ---------------------------------------------------------------------------------------

/** Cap on the paths a divergence lists. */
const MAX_PATHS = 50;

const diffPaths = (a: unknown, b: unknown, path: string, out: string[]): void => {
  if (out.length > MAX_PATHS) return;
  if (Object.is(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1)
      diffPaths(a[i], b[i], `${path}.${i}`, out);
    return;
  }
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(path);
};

export interface RunTapeDivergence {
  /** The last checkpoint that matched (0 = the start) … */
  readonly from: number;
  /** … and the first that did not: the game went another way between the two. */
  readonly to: number;
  /** Where the two differ (`state.score`, `tree.player.p.0`, `commands.length`), up to 50. */
  readonly paths: readonly string[];
  readonly morePaths: number;
  /** A load was in flight or a scene change was aligned in the interval: likely load timing. */
  readonly likelyLoad: boolean;
  readonly recorded: RunCheckpoint;
  readonly replayed: RunCheckpoint;
}

export interface RunTapeReplayResult {
  /** Ran to the recording's end with every checkpoint matching. */
  readonly ok: boolean;
  /** Recorded ticks played. */
  readonly ticks: number;
  readonly end: number;
  /** Checkpoints compared (and matched, unless there is a divergence). */
  readonly checkpoints: number;
  readonly divergence: RunTapeDivergence | null;
  /** Why the replay ended before the recording did (the game stopped, a scene never came). */
  readonly stopped: string | null;
  readonly notes: readonly string[];
}

export interface RunTapeReplayOptions {
  /** Let pending async work run between frames: a few event-loop turns (no animation frame needed). */
  readonly flush: () => Promise<void>;
  /** Told the recorded tick before it runs (a report's frame numbers). */
  readonly onTick?: (tick: number) => void;
}

/** Turns a replay waits for loads to land before it gives up on one. */
const MAX_LOAD_TURNS = 2000;
/** Ticks a replay plays the old scene waiting for the scene change the recording made. */
const MAX_HOLD_TICKS = 600;

/**
 * Play `tape` on `runner`: its scene started (`runTapeOverrides(tape)` applied before) and its time
 * mode `manual`. Stops at the first checkpoint that differs and leaves the game on that tick.
 */
export const replayRunTape = async (
  runner: SceneRunner,
  tape: RunTape,
  options: RunTapeReplayOptions
): Promise<RunTapeReplayResult> => {
  const notes: string[] = [];
  const note = (text: string): void => {
    if (!notes.includes(text)) notes.push(text);
  };
  const { flush } = options;
  let playing: RunTapeTick | null = null;
  /** The tick whose `before` inputs went in ahead of its frame's settle. */
  let injectedBefore = 0;
  let startsSeen = 0;
  const inject = (phase: 'before' | 'after'): void => {
    for (const input of playing?.in ?? []) {
      if (input.phase !== phase) continue;
      if (input.kind === 'resize')
        note('The recording resized the canvas mid-run; a replay keeps its size.');
      runner.injectRunInput(input);
    }
  };
  runner.setRunTap({
    beforeTick: () => {
      if (playing && playing.tick !== injectedBefore) inject('before');
    },
    afterTick: () => inject('after'),
    input: () => {},
    sceneStarted: () => {
      startsSeen += 1;
    },
  });

  const settle = async (): Promise<void> => {
    await flush();
    for (let turns = 0; runner.pendingLoads > 0 && turns < MAX_LOAD_TURNS; turns += 1)
      await flush();
  };
  const step = async (dt: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (runner.stepFrames(1, dt) === 1) return true;
      await settle();
    }
    return false;
  };

  const cursor = new CommandCursor();
  const scenes = tape.scenes.slice(1);
  let sceneIndex = 0;
  let startsHandled = 0;
  let tapeTick = 0;
  let compared = 0;
  let lastMatch = 0;
  let unsettledInterval = false;
  let dt = tape.header.time.fixedDeltaSec;
  let frameLength = 1;
  let frameLeft = 0;
  let settled = false;
  let holds = 0;
  let stopped: string | null = null;
  let divergence: RunTapeDivergence | null = null;
  try {
    for (;;) {
      // A scene the replay started: line the recording up with it.
      while (startsHandled < startsSeen) {
        startsHandled += 1;
        const recorded = scenes[sceneIndex++];
        if (!recorded) {
          stopped = `the replay changed scene after tick ${tapeTick}; the recording did not`;
          break;
        }
        if (recorded.tick > tapeTick + 1) {
          let dropped = 0;
          for (let t = tapeTick + 1; t < recorded.tick; t += 1) {
            const skipped = tape.ticks.get(t);
            const lost = skipped?.in?.filter(i => t !== injectedBefore || i.phase === 'after');
            dropped += lost?.length ?? 0;
            if (skipped?.dt !== undefined) dt = skipped.dt;
            if (skipped?.f !== undefined) frameLength = skipped.f;
          }
          note(
            `Scene ${recorded.path ?? '?'} started ${recorded.tick - tapeTick - 1} tick(s) sooner than recorded (a load or a transition); ticks ${tapeTick + 1}–${recorded.tick - 1} were skipped${dropped ? ` with ${dropped} input(s)` : ''}.`
          );
          tapeTick = recorded.tick - 1;
        }
        holds = 0;
        frameLeft = 0;
        unsettledInterval = true;
      }
      if (stopped || tapeTick >= tape.end) break;
      const next = tapeTick + 1;
      const awaited = scenes[sceneIndex];
      if (awaited && awaited.tick === next) {
        // The recording starts a scene here and the replay has not: play the old one on, inputless.
        if (holds >= MAX_HOLD_TICKS) {
          stopped = `the recording started ${awaited.path ?? 'a scene'} at tick ${next}; the replay did not within ${MAX_HOLD_TICKS} ticks`;
          break;
        }
        await settle();
        if (startsSeen > startsHandled) continue;
        holds += 1;
        unsettledInterval = true;
        playing = null;
        if (!(await step(dt))) {
          stopped = `the game stopped while waiting for ${awaited.path ?? 'a scene'} (tick ${next})`;
          break;
        }
        continue;
      }
      const line = tape.ticks.get(next);
      const startsFrame = line?.f !== undefined || frameLeft <= 0;
      if (startsFrame && !settled) {
        // Between frames, as recorded: the inputs, then whatever async work they and the last
        // frame left (an ad's outcome, a spawn) before the frame runs.
        playing = line ?? null;
        inject('before');
        playing = null;
        injectedBefore = next;
        await settle();
        settled = true;
        continue;
      }
      settled = false;
      if (line?.f !== undefined) frameLength = line.f;
      if (startsFrame) frameLeft = frameLength;
      frameLeft -= 1;
      if (line?.dt !== undefined) dt = line.dt;
      options.onTick?.(next);
      playing = line ?? null;
      const ran = await step(dt);
      playing = null;
      if (!ran) {
        stopped = `the game stopped at tick ${next} (the runner no longer steps)`;
        break;
      }
      tapeTick = next;
      if (runner.pendingLoads > 0) unsettledInterval = true;
      const recorded = tape.checkpoints.get(tapeTick);
      if (!recorded) continue;
      const replayed = checkpointOf(runner, cursor);
      const paths: string[] = [];
      diffPaths(
        { state: recorded.state, tree: recorded.tree, commands: recorded.commands },
        replayed,
        '',
        paths
      );
      compared += 1;
      if (paths.length > 0) {
        divergence = {
          from: lastMatch,
          to: tapeTick,
          paths: paths.slice(0, MAX_PATHS),
          morePaths: Math.max(0, paths.length - MAX_PATHS),
          likelyLoad: unsettledInterval || recorded.loading === true,
          recorded: { state: recorded.state, tree: recorded.tree, commands: recorded.commands },
          replayed,
        };
        break;
      }
      lastMatch = tapeTick;
      unsettledInterval = false;
    }
  } finally {
    runner.setRunTap(null);
  }
  return {
    ok: divergence === null && stopped === null,
    ticks: tapeTick,
    end: tape.end,
    checkpoints: compared,
    divergence,
    stopped,
    notes,
  };
};
