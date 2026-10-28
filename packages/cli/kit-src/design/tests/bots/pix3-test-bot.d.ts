// Pix3 agent kit {{version}} — `pix3 kit --update` rewrites this file; do not edit.
//
// Types for the test policies in this folder (global: no import needed). A policy is
// one file exporting an object with a `tick(bot)`; the harness runs it once per logic
// tick while the game plays, through `pix3_game_run {bot: {name: '<file name without
// .ts>'}, …}`. Write it as
//
//   export default {
//     name: 'dodge',
//     tick(bot) { … },
//   } satisfies BotPolicy;
//
// so `bot` is a Pix3TestBot and `pix3 check` type-checks the policy.
//
// The timing contract, which decides whether a policy works: `tick` runs AFTER the
// game's tick, and every actuator lands on the NEXT tick. Observe frame N, act for
// frame N+1 — the same one-frame lag a human player has.

declare interface BotPoint {
  x: number;
  y: number;
  z?: number;
}

/** What a policy sees of one live node. */
declare interface BotNodeView {
  nodeId: string;
  name: string;
  type: string;
  /** The node's own flag. `false` means it is not on screen and cannot be tapped. */
  visible: boolean;
  position: { x: number; y: number; z: number };
  worldPosition: { x: number; y: number; z: number };
  /** The text the node renders, for nodes that render one. */
  text?: string;
}

declare interface BotHit {
  node: BotNodeView;
  distance: number;
  point: { x: number; y: number; z: number };
}

declare interface Pix3TestBot {
  /** Ticks this policy has been ticked for: 1 on the run's first frame (never during settleMs). */
  readonly frame: number;
  /**
   * The run's parameters (frozen; `{}` when none): pix3_game_run {bot: {name, args: {…}}} or
   * pix3 play --bot <name> --bot-args '{…}'. One policy, several variants.
   */
  readonly args: Readonly<Record<string, unknown>>;

  // -- sensors ---------------------------------------------------------------

  /** Live nodes answering a name, an id, or a type ('Sprite2D'). */
  nodes(query: string): BotNodeView[];
  /** Nearest live node of `type` to `from` (default: the world origin). */
  nearest(type: string, from?: BotPoint): BotHit | null;
  /** First live node struck by a ray. `dir` need not be normalised. */
  raycast(from: BotPoint, dir: BotPoint): BotHit | null;
  /**
   * The world point at (x, y) in a node's own space (name or id) — what tapAt / swipe take:
   * bot.tapAt(bot.pointIn('board', cellX, cellY)) taps a board cell. null when no such node.
   */
  pointIn(node: string, x: number, y: number): BotPoint | null;
  /** The game's own registerGameDebug() snapshot, or null when it registered none. */
  gameState(): unknown;

  // -- actuators -------------------------------------------------------------

  /** Hold a key ('Key_ArrowLeft' or 'ArrowLeft') or a named button ('Action_Primary'). */
  press(action: string, frames?: number): void;
  /** Let go of something press() is holding. */
  release(action: string): void;
  /**
   * Tap a control by node name/id: down now, up a few ticks later. Refused (a bot error that names
   * it) when the node or one of its ancestors is hidden — an overlay instance still invisible.
   */
  tap(target: string): void;
  /**
   * Tap a world point (a board cell): down now, up a few ticks later, on the same finger as
   * swipe() — not while a swipe or another tapAt is still down. physical-input only.
   */
  tapAt(point: BotPoint): void;
  /** Steer an input axis to -1..1. On physical-input this deflects the live joystick. */
  axis(name: string, value: number): void;
  /** Point the pointer at a world position (aim, hover, click-to-move). */
  moveTo(point: BotPoint): void;
  /**
   * Drag a finger from one world point to another over `frames` ticks (default 8): down, a move
   * per tick, up — a swipe, a drag-and-drop, a slingshot pull. physical-input only.
   */
  swipe(from: BotPoint, to: BotPoint, frames?: number): void;
  /**
   * Dispatch one of the game's scene.commands ('restart', …): proves the handler, not a button.
   * true when it ran and did not decline (a handler returns false to decline, e.g. a dead swap).
   */
  command(name: string, args?: Record<string, unknown>): boolean;
  /**
   * A named picture of this frame: `pix3 play --bot` freezes the game here, saves <name>.png
   * (--shots dir) and lets it run on — a selected cell, a result card, a 200 ms effect. In the
   * editor's pix3_game_run it is only a log marker.
   */
  screenshot(name: string): void;

  // -- protocol --------------------------------------------------------------

  /** One line in the run report — how the policy explains its own reasoning. */
  log(event: string): void;
  /** End the run with the policy's verdict and the reason, in words. First call wins. */
  done(pass: boolean, reason: string): void;
}

/**
 * A policy file exports a BotPolicy object, or a factory returning one — called once per run, so
 * its locals are fresh state every run (module-level variables survive between pix3_game_run
 * runs in the editor until the file changes):
 *   export default (() => { let step = 0; return { tick(bot) { … } }; }) satisfies () => BotPolicy;
 * Two taps in a row (select a cell, then its neighbour) need a gap: a tap holds its finger down
 * for 3 ticks, so tap on one frame and the next one at least ~6 frames later.
 */
declare interface BotPolicy {
  /** Optional label for the report; the file name is used when absent. */
  name?: string;
  /** Runs once before the first tick. */
  start?(bot: Pix3TestBot): void;
  /** Runs once per logic tick until done() or the budget ends. */
  tick(bot: Pix3TestBot): void;
  /** Runs once after the last tick, whatever ended the run. */
  end?(bot: Pix3TestBot): void;
}
