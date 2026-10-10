/**
 * Routines — the local skill library the agent keeps for itself (§5.7 of
 * `.plans/done/agent-gameplay-testing.md`).
 *
 * A routine is a named, parameterised sequence of steps plus the post-conditions
 * that must hold once they have run, stored as `design/tests/routines/<name>.json`
 * in the project. `game_run({routine: 'buy-item', args: {slot: 2}})` executes it in
 * one tool call, and only the routine's **header** (`name`, `description`,
 * `params`) ever reaches the model's context — the body is the harness's business.
 * That ratio is the whole point: one index line against fifteen input steps
 * re-typed in every iteration.
 *
 * ## The format has exactly two vocabularies, and neither is new
 *
 * This is the load-bearing decision of the module. Two example routines shipped in
 * the templates before a runner existed, and they had drifted into two different
 * dialects — one writing steps as `game_input` steps and assertions as
 * `{predicate: …}`, the other inventing `channel`/`input`/`why` wrappers and
 * tuple assertions `{gameState: [path, op, value]}`. A third dialect here would
 * have made the template — the thing an agent copies from — teach a format the
 * tools do not speak. So:
 *
 * - **Steps are exactly {@link GameInputStep}**, the shape `game_input` already
 *   takes (`tap`/`key`/`keys`/`drag`/`hover`/`wait`/`invoke`, with `ms`/`frames`),
 *   plus one addition the command layer earned: `{type: 'command', name, args}`,
 *   which dispatches a registered intent through `scene.commands`. The field list
 *   is checked against `keyof GameInputStep` at compile time
 *   ({@link INPUT_STEP_FIELDS}), so a new input field cannot appear in one place
 *   and not the other.
 * - **Assertions are exactly the predicate objects of `game-assertions.ts`**,
 *   discriminated by `kind`, parsed by `parseAssertions` (`game-assertions.ts`). There is no second
 *   copy of those rules here.
 *
 * Two fields are documentation and are ignored by the runner: `why` on a step and
 * `note` on the routine. A routine doubles as a checklist a human reads, and the
 * reason a step exists is the part that does not survive being re-derived.
 *
 * ## What "the highest available channel" means for a step
 *
 * The channel ladder of §5.6/§5.8 applies in order: a `command` step is the
 * strongest (it survives any relayout of the UI), `invoke` is the semantic
 * channel, and `tap`/`drag`/`key` are the physical one — kept for the steps whose
 * subject *is* the gesture. What a routine must never do is call a component's
 * handler method directly: that proves nothing about the wire between the player
 * and the effect, which is the one thing the harness exists to prove. The command
 * step is the sanctioned way to express an intent, and it is why the playable
 * templates register their `finish` intent as a command.
 *
 * ## Execution model
 *
 * Steps run in **realtime**, because that is the only mode in which input works at
 * all (`game_run`'s own manual loop refuses `input` for exactly that reason: no
 * tick passes between a synthesized keydown and its keyup). Contiguous input steps
 * are handed to `GameInputService` in one batch, and command steps are dispatched
 * between batches, so the authored order is preserved.
 *
 * `expect` is an **AND** over the predicates, evaluated once after the last step
 * against a frame pair: the baseline captured *before* the first step and the
 * outcome captured after the last one settles. That window is a real advantage
 * over `game_input` + `game_run` split across two calls, where the input lands
 * outside the run's window and `command`/`signal` predicates can only report that
 * they were not listening yet.
 */

import type { Json } from '@/core/agent-introspection';
import {
  assertionAxisNames,
  assertionNodeNames,
  assertionPropertyReads,
  assertionSignalWatches,
  assertionSnapshotNames,
  assertionTypeQueries,
  assertionsNeedCommands,
  describeAssertion,
  evaluateAssertion,
  type AssertionBaseline,
  type AssertionFrame,
  type CommandWindow,
  type GameAssertion,
  type SignalObservation,
  type SignalWatchSpec,
} from '@/services/game-test/game-assertions';
import { flattenScalars } from '@/services/game-test/game-traces';
import type { GameInputStep, LiveNodeSnapshot } from '@/services/game-test/GameInputService';
import type { GameCommandLogEntry } from '@pix3/runtime';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Where routines live in a project. Mirrored by every project template. */
export const ROUTINE_DIRECTORY = 'design/tests/routines';

export const ROUTINE_FILE_SUFFIX = '.json';

/** Accepts a bare name (`buy-item`) or a full path, and answers the full path. */
export function routineFilePath(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes('/')) {
    return trimmed.endsWith(ROUTINE_FILE_SUFFIX) ? trimmed : `${trimmed}${ROUTINE_FILE_SUFFIX}`;
  }
  const bare = trimmed.endsWith(ROUTINE_FILE_SUFFIX)
    ? trimmed.slice(0, -ROUTINE_FILE_SUFFIX.length)
    : trimmed;
  return `${ROUTINE_DIRECTORY}/${bare}${ROUTINE_FILE_SUFFIX}`;
}

/**
 * The storage seam, same shape as `TraceStore`: the service holds one of these. In 2.x only
 * {@link InMemoryRoutineStore} exists — the 1.x project-file backend (`ProjectRoutineStore`) had no
 * caller left and went with the knip --production sweep.
 */
export interface RoutineStore {
  /** `null` when there is no such routine — not an error; the caller lists what exists. */
  load(path: string): Promise<GameRoutine | null>;
  /** Every stored routine, parsed. Unparseable files are reported, not thrown. */
  loadAll(): Promise<{ routines: GameRoutine[]; broken: Array<{ path: string; error: string }> }>;
}

/** In-memory store: the default, and what the specs run against. */
export class InMemoryRoutineStore implements RoutineStore {
  private readonly byPath = new Map<string, GameRoutine>();

  put(routine: GameRoutine): void {
    this.byPath.set(routineFilePath(routine.name), routine);
  }

  async load(path: string): Promise<GameRoutine | null> {
    return this.byPath.get(routineFilePath(path)) ?? null;
  }

  async loadAll(): Promise<{
    routines: GameRoutine[];
    broken: Array<{ path: string; error: string }>;
  }> {
    return { routines: [...this.byPath.values()], broken: [] };
  }
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Parameter types a routine may declare. Deliberately the three JSON scalars. */
export type RoutineParamType = 'number' | 'string' | 'boolean';

/**
 * Dispatch a registered intent through `scene.commands` — the highest channel a
 * step can use, and the reason this step type exists at all: the alternative a
 * template had reached for (calling a component method by name) exercises the
 * handler while skipping every wire between the player and it.
 */
export interface RoutineCommandStep {
  type: 'command';
  /** The intent as registered, e.g. `finish`, `shop.buy`. */
  name: string;
  args?: Record<string, Json>;
  /** Documentation for the reader; ignored by the runner. */
  why?: string;
}

/** An input step, exactly as `game_input` takes it, plus the ignored `why`. */
export type RoutineInputStep = GameInputStep & { why?: string };

export type RoutineStep = RoutineInputStep | RoutineCommandStep;

export interface GameRoutine {
  name: string;
  /** One line — this is what reaches the model's context. */
  description: string;
  /** Scene path or free tag (the 1.x prompt index filtered on it). */
  scope?: string;
  params?: Record<string, RoutineParamType>;
  /** Live nodes the routine needs. Checked against the scene BEFORE it runs. */
  uses: string[];
  steps: RoutineStep[];
  /** Post-conditions, ANDed. Empty means this is a macro, not a test. */
  expect: GameAssertion[];
  /** Free-form documentation; ignored by the runner. */
  note?: string;
}

/** A routine with no assertions is a macro: it replays work, it proves nothing. */
export function isMacroRoutine(routine: GameRoutine): boolean {
  return routine.expect.length === 0;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Bind `args` to the routine's declared `params` and substitute them everywhere.
 *
 * Two substitution readings, and the difference matters: a string that is
 * *entirely* one placeholder (`"{slot}"`) becomes the typed value, so
 * `{type:'command', name:'shop.buy', args:{slot:'{slot}'}}` dispatches the number
 * 2 and not the string `"2"`; a placeholder embedded in text (`"Slot{slot}"`)
 * interpolates. Every other value is copied through untouched.
 *
 * An undeclared arg is refused rather than ignored — a typo in a parameter name is
 * otherwise indistinguishable from a routine that quietly ran with its defaults.
 */
export function prepareRoutine(
  routine: GameRoutine,
  rawArgs: Record<string, unknown> = {}
): { routine: GameRoutine; args: Record<string, Json> } | { error: string } {
  const declared = routine.params ?? {};
  const args: Record<string, Json> = {};

  for (const key of Object.keys(rawArgs)) {
    if (!(key in declared)) {
      return {
        error: `"${routine.name}" declares no param "${key}" (declared: ${Object.keys(declared).join(', ') || 'none'}).`,
      };
    }
  }
  for (const [name, type] of Object.entries(declared)) {
    const value = rawArgs[name];
    if (value === undefined) {
      return {
        error: `"${routine.name}" needs args.${name} (${type}). Call it as game_run {routine:'${routine.name}', args:{${name}: …}}.`,
      };
    }
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { error: `args.${name} must be a finite number (got ${JSON.stringify(value)}).` };
    }
    if (type === 'string' && typeof value !== 'string') {
      return { error: `args.${name} must be a string (got ${JSON.stringify(value)}).` };
    }
    if (type === 'boolean' && typeof value !== 'boolean') {
      return { error: `args.${name} must be a boolean (got ${JSON.stringify(value)}).` };
    }
    args[name] = value as Json;
  }

  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (whole && whole[1] in args) return args[whole[1]];
      return value.replace(PLACEHOLDER, (match, name: string) =>
        name in args ? String(args[name]) : match
      );
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          substitute(entry),
        ])
      );
    }
    return value;
  };

  return {
    routine: {
      ...routine,
      uses: routine.uses.map(entry => String(substitute(entry))),
      steps: routine.steps.map(step => substitute(step) as RoutineStep),
    },
    args,
  };
}

// ---------------------------------------------------------------------------
// Staleness (§5.7.4)
// ---------------------------------------------------------------------------

/** The marker a stale routine answers with, so it is greppable in a transcript. */
export const ROUTINE_STALE_PREFIX = 'ROUTINE STALE';

/** Names in `uses` that no live node answers — checked before the first step. */
export function findStaleUses(
  uses: readonly string[],
  nodeExists: (query: string) => boolean
): string[] {
  return uses.filter(name => !nodeExists(name));
}

/**
 * The refusal a stale routine gets.
 *
 * It names the missing node, because that is the whole value of the check: a
 * renamed node is diagnosed from the name in one line, instead of being read off
 * the symptom of a test that failed three steps in for no stated reason.
 */
export function staleRoutineMessage(routine: GameRoutine, missing: readonly string[]): string {
  const which = missing.map(name => `"${name}"`).join(', ');
  return `${ROUTINE_STALE_PREFIX}: no node ${which} in the running scene, and routine "${routine.name}" needs ${missing.length > 1 ? 'them' : 'it'} (its \`uses\`). Nothing was executed. Either the node was renamed/removed — update ${routineFilePath(routine.name)} or the scene — or the routine belongs to another scene (its scope is ${routine.scope ? `"${routine.scope}"` : 'unset'}).`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** What one step did. `channel` is the ladder rung it used. */
export interface RoutineStepReport {
  index: number;
  channel: 'command' | 'input';
  /** The step as one readable line. */
  label: string;
  ok: boolean;
  error?: string;
  /** The routine's own `why`, echoed so a failure reads with its intent. */
  why?: string;
}

export interface RoutineExpectationReport {
  index: number;
  assertion: string;
  met: boolean;
  detail: string;
}

export interface RoutineRunResult {
  /** False only when the routine could not run at all (missing, stale, bad args). */
  ok: boolean;
  error?: string;
  /** Read this first. */
  verdict?: string;
  routine?: {
    name: string;
    description: string;
    scope?: string;
    macro: boolean;
    args?: Record<string, Json>;
    note?: string;
  };
  steps?: RoutineStepReport[];
  /** Every expectation, met or not — a routine's `expect` is an AND. */
  expectations?: RoutineExpectationReport[];
  /** Logic ticks the routine spanned, when the host counts them. */
  frames?: number;
  newErrors?: Array<{ source: string; message: string }>;
  game?: { provider: string; snapshot: Json; changed?: Record<string, [Json, Json]> };
  notes?: string[];
}

/** One reading of the game's own debug provider. */
export interface RoutineGameSample {
  name: string;
  snapshot: Json;
}

/**
 * Everything the routine driver needs from the live editor, injected so the driver
 * itself is testable without a runner, a renderer or DI — the same split
 * `runGameTestLoop` uses.
 */
export interface RoutineWorld {
  /** Does a live node answer this name/id right now? Drives `uses` and `presentNodes`. */
  nodeExists(query: string): boolean;
  /** Run a contiguous batch of input steps through the real input path. */
  runInput(steps: RoutineInputStep[]): Promise<{ ok: boolean; error?: string }>;
  /**
   * Dispatch an intent. `null` means the running scene exposes no command registry
   * at all, which is a different sentence from "no handler took it".
   */
  dispatchCommand(
    name: string,
    args?: Record<string, Json>
  ): { ok: boolean; error?: string } | null;
  /** The game's own debug provider, or null when it registered none. */
  sampleGameState(): RoutineGameSample | null;
  errorCount(): number;
  errorsSince(from: number): Array<{ source: string; message: string }>;
  /** Transform snapshot of a live node (for `nodeMoved`), or null. */
  snapshotNode(query: string): LiveNodeSnapshot | null;
  /** A dot path into a live node's own properties; `undefined` = no node or no such property. */
  readNodeProperty(query: string, path: string): Json | undefined;
  /** Live node count for a type query (the pooling-proof reading of `nodeAppeared`). */
  countNodesOfType(type: string): number;
  /** Input axis value, sampled WITHOUT registering as a game poll. */
  readAxis?(name: string): number | undefined;
  /** The scene's command journal, for `command` predicates. */
  readCommandJournal?(): { entries: readonly GameCommandLogEntry[]; dropped: number } | null;
  /** Signal subscriptions, opened before the first step. */
  watchSignals?(specs: readonly SignalWatchSpec[]): {
    sweep(frame: number): void;
    observations(): ReadonlyMap<string, SignalObservation>;
    dispose(): void;
  };
  /** Ticks executed since the driver started, when the host counts them. */
  framesElapsed?(): number;
  /** Let the last step's effect land before the outcome frame is captured. */
  settle(): Promise<void>;
}

/** Journal entries the pre-window tail may carry into the report. */
const MAX_PRE_WINDOW_ENTRIES = 8;

/**
 * Execute one routine end to end: bind args, refuse if stale, run the steps on the
 * highest channel each one asked for, then judge the whole `expect` list against
 * the window the steps ran in.
 *
 * The order is the contract. Args are bound before the staleness check so that
 * `uses: ["Slot{slot}"]` is checked as the node it will actually touch; the
 * staleness check happens before the first step so a renamed node is one line
 * rather than a failure halfway through; and the expectations are judged only if
 * every step was delivered, because predicates evaluated after an undelivered step
 * would blame the game for the harness's problem.
 */
export async function runRoutine(
  world: RoutineWorld,
  routine: GameRoutine,
  rawArgs: Record<string, unknown> = {}
): Promise<RoutineRunResult> {
  const prepared = prepareRoutine(routine, rawArgs);
  if ('error' in prepared) return { ok: false, error: prepared.error };
  const bound = prepared.routine;

  const missing = findStaleUses(bound.uses, query => world.nodeExists(query));
  if (missing.length > 0) {
    return { ok: false, error: staleRoutineMessage(bound, missing) };
  }

  const header = {
    name: bound.name,
    description: bound.description,
    ...(bound.scope ? { scope: bound.scope } : {}),
    macro: isMacroRoutine(bound),
    ...(Object.keys(prepared.args).length > 0 ? { args: prepared.args } : {}),
    ...(bound.note ? { note: bound.note } : {}),
  };

  const notes: string[] = [];
  const errorsBefore = world.errorCount();
  const baselineSample = world.sampleGameState();
  if (!baselineSample && bound.expect.some(assertionReadsGameState)) {
    notes.push(
      'No GameDebugProvider is registered by the running game, so every gameState expectation reports it instead of a result. Register one with registerGameDebug({name, snapshot}).'
    );
  }

  const collector = new FrameCollector(world, bound.expect, notes);
  const watcher = collector.openSignalWatch();
  let baseline: AssertionBaseline;
  const steps: RoutineStepReport[] = [];
  try {
    watcher?.sweep(0);
    baseline = collector.capture(0, baselineSample, errorsBefore);

    for (const batch of batchSteps(bound.steps)) {
      const report = await runBatch(world, batch);
      steps.push(...report.steps);
      watcher?.sweep(report.steps.length);
      if (!report.ok) {
        const failed = steps[steps.length - 1];
        return {
          ok: true,
          verdict: `ROUTINE FAIL ${bound.name} — step ${failed.index + 1} (${failed.label}) could not be delivered: ${failed.error}. The ${bound.expect.length} expectation(s) were NOT judged, so nothing is claimed about the game here${bound.expect.length > 0 ? ' — a step that never reached the game cannot fail or pass it' : ''}.`,
          routine: header,
          steps,
          ...(bound.expect.length > 0 ? { expectations: describeUnjudged(bound.expect) } : {}),
          newErrors: world.errorsSince(errorsBefore),
          ...(notes.length ? { notes } : {}),
        };
      }
    }

    await world.settle();
    const frames = world.framesElapsed?.() ?? 0;
    watcher?.sweep(frames);
    const outcome = collector.capture(frames, world.sampleGameState(), errorsBefore);

    const expectations: RoutineExpectationReport[] = bound.expect.map((assertion, index) => {
      const result = evaluateAssertion(assertion, outcome, baseline);
      return {
        index,
        assertion: describeAssertion(assertion),
        met: result.met,
        detail: result.detail,
      };
    });

    const newErrors = world.errorsSince(errorsBefore);
    const game = buildGameReport(baselineSample, outcome.gameState, baselineSample?.name);

    return {
      ok: true,
      verdict: buildRoutineVerdict(bound, steps, expectations, frames, newErrors.length),
      routine: header,
      steps,
      ...(expectations.length ? { expectations } : {}),
      frames,
      newErrors,
      ...(game ? { game } : {}),
      ...(notes.length ? { notes } : {}),
    };
  } finally {
    watcher?.dispose();
  }
}

/** `expect` entries that were never reached, said out loud rather than omitted. */
function describeUnjudged(expect: readonly GameAssertion[]): RoutineExpectationReport[] {
  return expect.map((assertion, index) => ({
    index,
    assertion: describeAssertion(assertion),
    met: false,
    detail: 'not judged — the routine stopped before its last step ran',
  }));
}

/**
 * Group contiguous input steps so each group is one `GameInputService` call, with
 * command dispatches in between. Authored order is preserved exactly; the grouping
 * only decides how many round trips through the input layer a routine costs.
 */
export function batchSteps(
  steps: readonly RoutineStep[]
): Array<
  | { kind: 'input'; steps: Array<{ index: number; step: RoutineInputStep }> }
  | { kind: 'command'; index: number; step: RoutineCommandStep }
> {
  const batches: Array<
    | { kind: 'input'; steps: Array<{ index: number; step: RoutineInputStep }> }
    | { kind: 'command'; index: number; step: RoutineCommandStep }
  > = [];
  steps.forEach((step, index) => {
    if (step.type === 'command') {
      batches.push({ kind: 'command', index, step });
      return;
    }
    const last = batches[batches.length - 1];
    if (last && last.kind === 'input') {
      last.steps.push({ index, step });
      return;
    }
    batches.push({ kind: 'input', steps: [{ index, step }] });
  });
  return batches;
}

async function runBatch(
  world: RoutineWorld,
  batch: ReturnType<typeof batchSteps>[number]
): Promise<{ ok: boolean; steps: RoutineStepReport[] }> {
  if (batch.kind === 'command') {
    const outcome = world.dispatchCommand(batch.step.name, batch.step.args);
    const error =
      outcome === null
        ? `the running scene exposes no command registry, so "${batch.step.name}" cannot be dispatched. A game opts in from a script: scene.commands.register('${batch.step.name}', …).`
        : outcome.ok
          ? undefined
          : (outcome.error ??
            `no registered handler took "${batch.step.name}" — check the name against the intents the scene registers (game_controls lists them).`);
    return {
      ok: error === undefined,
      steps: [
        {
          index: batch.index,
          channel: 'command',
          label: describeStep(batch.step),
          ok: error === undefined,
          ...(error ? { error } : {}),
          ...(batch.step.why ? { why: batch.step.why } : {}),
        },
      ],
    };
  }

  const result = await world.runInput(batch.steps.map(entry => entry.step));
  // The input layer reports the batch, not the individual step, so a failed batch
  // attributes the error to the batch's first step and marks the rest as not run —
  // guessing which one of five taps the message was about would be worse.
  return {
    ok: result.ok,
    steps: batch.steps.map((entry, position) => ({
      index: entry.index,
      channel: 'input' as const,
      label: describeStep(entry.step),
      ok: result.ok,
      ...(result.ok
        ? {}
        : {
            error:
              position === 0
                ? (result.error ?? 'the input layer refused the step')
                : 'not run — an earlier step in the same input batch failed',
          }),
      ...(entry.step.why ? { why: entry.step.why } : {}),
    })),
  };
}

/** One step as a line a human can read in a report. */
export function describeStep(step: RoutineStep): string {
  if (step.type === 'command') {
    const args = step.args && Object.keys(step.args).length ? ` ${JSON.stringify(step.args)}` : '';
    return `command ${step.name}${args}`;
  }
  const parts: string[] = [step.type];
  if (step.target) parts.push(step.target);
  if (step.type === 'invoke' && step.interaction) parts.push(`.${step.interaction}`);
  if (step.code) parts.push(step.code);
  if (step.codes) parts.push(step.codes.join('+'));
  if (step.x !== undefined || step.y !== undefined)
    parts.push(`at (${step.x ?? 0}, ${step.y ?? 0})`);
  if (step.frames !== undefined) parts.push(`${step.frames}f`);
  else if (step.ms !== undefined) parts.push(`${step.ms}ms`);
  return parts.join(' ');
}

/**
 * One line, read first. Three shapes, because three things are being said: a macro
 * asserted nothing (and must never read as a pass), a test held every expectation,
 * or it did not — with the first failure quoted, since that is the finding.
 */
function buildRoutineVerdict(
  routine: GameRoutine,
  steps: readonly RoutineStepReport[],
  expectations: readonly RoutineExpectationReport[],
  frames: number,
  newErrors: number
): string {
  const ran = `${steps.length} step(s)${frames > 0 ? `, ${frames} tick(s)` : ''}`;
  const errors = newErrors > 0 ? ` ${newErrors} NEW RUNTIME ERROR(S) during the routine.` : '';
  if (expectations.length === 0) {
    return `ROUTINE MACRO ${routine.name} — ${ran} ran and NOTHING WAS ASSERTED. This routine is a macro: it replays work, it does not test it. Add \`expect\` predicates to make it a regression check.${errors}`;
  }
  const failed = expectations.filter(entry => !entry.met);
  if (failed.length === 0) {
    return `ROUTINE PASS ${routine.name} — ${ran}, ${expectations.length}/${expectations.length} expectation(s) held.${errors}`;
  }
  const first = failed[0];
  return `ROUTINE FAIL ${routine.name} — ${ran}, ${expectations.length - failed.length}/${expectations.length} expectation(s) held. expect[${first.index}] ${first.assertion}: ${first.detail}.${errors}`;
}

/**
 * The baseline → outcome scalar diff of the game's own snapshot.
 *
 * Flattened by `flattenScalars` from `game-traces.ts` rather than by a private
 * walker: it is the same "dot path → scalar" reading the traces compare on, and two
 * flatteners would eventually disagree about what a path is called.
 */
function buildGameReport(
  baseline: RoutineGameSample | null,
  outcome: Json | null,
  provider: string | undefined
): RoutineRunResult['game'] {
  if (outcome === null || provider === undefined) return undefined;
  const changed: Record<string, [Json, Json]> = {};
  const before = flattenScalars(baseline?.snapshot ?? null);
  const after = flattenScalars(outcome);
  for (const [path, value] of Object.entries(after)) {
    const previous = before[path];
    if (JSON.stringify(previous ?? null) !== JSON.stringify(value ?? null)) {
      changed[path] = [previous ?? null, value];
    }
  }
  return {
    provider,
    snapshot: outcome,
    ...(Object.keys(changed).length ? { changed } : {}),
  };
}

const assertionReadsGameState = (assertion: GameAssertion): boolean =>
  assertion.kind === 'gameState' || assertion.kind === 'gameStateChanged';

/**
 * Builds the two {@link AssertionFrame}s a routine is judged on.
 *
 * It collects **only what the routine's own predicates ask for** — the same rule
 * the frame loop follows — and it collects *all* of it, including the fields the
 * frame loop does not (`nodes`, `nodeProperties`, `typeCounts`, `axes`). A routine
 * asserts post-conditions on the controls it just operated, so `nodeProperty` is
 * its most natural predicate; leaving it uncollected would answer the most common
 * routine with "harness bug", which is the worst of the three possible answers.
 */
class FrameCollector {
  private readonly presentNames: string[];
  private readonly snapshotNames: string[];
  private readonly typeQueries: string[];
  private readonly propertyReads: ReturnType<typeof assertionPropertyReads>;
  private readonly axisNames: string[];
  private readonly needCommands: boolean;
  private commandBase = 0;
  private commandReset = false;
  private preWindow: GameCommandLogEntry[] = [];
  private signals: {
    sweep(frame: number): void;
    observations(): ReadonlyMap<string, SignalObservation>;
    dispose(): void;
  } | null = null;

  constructor(
    private readonly world: RoutineWorld,
    private readonly expect: readonly GameAssertion[],
    private readonly notes: string[]
  ) {
    this.presentNames = assertionNodeNames(expect);
    this.snapshotNames = assertionSnapshotNames(expect);
    this.typeQueries = assertionTypeQueries(expect);
    this.propertyReads = assertionPropertyReads(expect);
    this.axisNames = assertionAxisNames(expect);
    this.needCommands = assertionsNeedCommands(expect);

    if (this.needCommands) {
      const reading = world.readCommandJournal?.() ?? null;
      if (reading) {
        this.commandBase = reading.entries.length + reading.dropped;
        this.preWindow = reading.entries
          .slice(-MAX_PRE_WINDOW_ENTRIES)
          .map(entry => ({ ...entry }));
      } else {
        notes.push(
          'The running scene exposes no command registry, so no `command` expectation can match. A game opts in from a script: scene.commands.register("open-menu", …), dispatched by the control handler.'
        );
      }
    }
    if (this.axisNames.length > 0 && !world.readAxis) {
      notes.push(
        'This host cannot sample input axes, so every `axis` expectation reports that instead of a value.'
      );
    }
  }

  /** Open the signal window BEFORE the first step, so the routine's own window is heard. */
  openSignalWatch(): {
    sweep(frame: number): void;
    observations(): ReadonlyMap<string, SignalObservation>;
    dispose(): void;
  } | null {
    const specs = assertionSignalWatches(this.expect);
    if (specs.length === 0) return null;
    if (!this.world.watchSignals) {
      this.notes.push(
        'This host cannot subscribe to signals, so every `signal` expectation reports that it was never listening.'
      );
      return null;
    }
    this.signals = this.world.watchSignals(specs);
    return this.signals;
  }

  capture(frame: number, sample: RoutineGameSample | null, errorsBefore: number): AssertionFrame {
    const nodes = new Map<string, LiveNodeSnapshot>();
    for (const name of this.snapshotNames) {
      const snapshot = this.world.snapshotNode(name);
      if (snapshot) nodes.set(name, snapshot);
    }
    const nodeProperties = new Map<string, Json | undefined>();
    for (const read of this.propertyReads) {
      nodeProperties.set(read.key, this.world.readNodeProperty(read.name, read.path));
    }
    const typeCounts = new Map<string, number>();
    for (const query of this.typeQueries) {
      typeCounts.set(query, this.world.countNodesOfType(query));
    }
    const axes = new Map<string, number>();
    if (this.world.readAxis) {
      for (const name of this.axisNames) {
        const value = this.world.readAxis(name);
        if (value !== undefined) axes.set(name, value);
      }
    }
    const commands = this.commandWindow();
    return {
      frame,
      // Routines run in realtime, so there is no driver tick length to multiply by;
      // the honest denomination for "how long" here is the tick count in `frames`.
      gameTimeMs: 0,
      gameState: sample?.snapshot ?? null,
      presentNodes: new Set(this.presentNames.filter(name => this.world.nodeExists(name))),
      newErrorCount: this.world.errorCount() - errorsBefore,
      ...(commands ? { commands } : {}),
      ...(this.signals ? { signals: this.signals.observations() } : {}),
      ...(nodes.size ? { nodes } : {}),
      ...(nodeProperties.size ? { nodeProperties } : {}),
      ...(typeCounts.size ? { typeCounts } : {}),
      ...(axes.size ? { axes } : {}),
    };
  }

  /**
   * The journal slice appended since the baseline — a *position*, not a filter, for
   * the same reason as the frame loop: the ring buffer's `entries.length + dropped`
   * is the only monotone count of everything ever pushed, and frame stamps come
   * from the engine's counter rather than from this routine's start.
   */
  private commandWindow(): CommandWindow | undefined {
    if (!this.needCommands || !this.world.readCommandJournal) return undefined;
    const reading = this.world.readCommandJournal();
    if (!reading) return { entries: [], dropped: 0, available: false };
    const total = reading.entries.length + reading.dropped;
    if (total < this.commandBase) {
      this.commandReset = true;
      this.commandBase = 0;
    }
    const appended = total - this.commandBase;
    const kept = Math.min(appended, reading.entries.length);
    return {
      entries: reading.entries.slice(reading.entries.length - kept),
      dropped: appended - kept,
      available: true,
      ...(this.commandReset ? { reset: true } : {}),
      ...(this.preWindow.length ? { beforeWindow: this.preWindow } : {}),
    };
  }
}

/** Shared by every "no such routine" answer, so the model always sees what exists. */
export function describeAvailableRoutines(routines: readonly GameRoutine[]): string {
  if (routines.length === 0) {
    return `No routines are stored in ${ROUTINE_DIRECTORY}/ yet.`;
  }
  return `Stored routines: ${routines
    .map(routine => routine.name)
    .sort()
    .join(', ')}.`;
}
