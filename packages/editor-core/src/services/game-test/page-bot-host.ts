import type { SceneRunner } from '@pix3/runtime';
import { DomInputSink } from '@/services/game-test/frame-input';
import {
  BOT_POINTER_ID,
  PhysicalAxisDriver,
  collectBotNodeViews,
  keyCodeOf,
  nearestBotNode,
  projectToCanvasFraction,
  botPointInNode,
  raycastBotNodes,
  toCanvasFraction,
  type BotCanvasHandle,
  type BotSceneHandle,
} from '@/services/game-test/game-bot-world';
import {
  BotSession,
  resolveBotPolicy,
  type BotReport,
  type BotWorld,
} from '@/services/game-test/game-bots';
import type { Json } from '@/core/agent-introspection';

/**
 * A bot policy on the game's own page — the dev server's `/` or a built `dist/index.html` —
 * without the editor: `pix3 play --bot <name>` bundles this module with the project's policy and
 * evaluates it in the page. The same `BotSession` the editor's `pix3_game_run` uses, ticked by the
 * same per-tick hook (`SceneRunner.subscribeFrameStats`), on the `physical-input` channel only:
 * taps, swipes and keys are DOM events on the game canvas, the path a player's input takes. What
 * the editor adds on top (predicates, the negative control, `direct-action`) is the editor's.
 *
 * Bundled by the CLI (`packages/cli/src/play/`), never imported by the editor.
 */

interface PageCommands {
  list(): Array<{ name: string }>;
  dispatch(name: string, args?: Record<string, unknown>): boolean;
}

interface PageWindow extends Window {
  __PIX3_PLAYER__?: { runner: SceneRunner | null; status: string };
  __PIX3_GAME_DEBUG__?: { snapshot?: () => unknown };
  __PIX3_PAGE_BOT__?: PageBotHandle;
}

/** A picture the policy asked for (`bot.screenshot`); the game is paused on its frame. */
export interface PageBotShot {
  readonly name: string;
  readonly frame: number;
}

export interface PageBotHandle {
  readonly finished: boolean;
  /** Ticks the policy has played (`bot.frame`): 1/60 s of game time each. */
  readonly frame: number;
  /**
   * The next picture to take, or null. The game stays paused on its frame until {@link resume};
   * the CLI captures the page in between.
   */
  takeShot(): PageBotShot | null;
  /** Let the game run on after a picture (it stays paused once the policy is finished). */
  resume(): void;
  /** The session's report; `notes` names what the page run could not do. */
  report(): BotReport;
  /** End the run (budget spent): `end()` runs, everything held is released. */
  stop(): BotReport;
}

const commandsOf = (runner: SceneRunner): PageCommands | null => {
  for (const root of runner.getLiveRootNodes()) {
    const commands = (root.scene as { commands?: PageCommands } | undefined)?.commands;
    if (commands) return commands;
  }
  return null;
};

const buildPageWorld = (
  runner: SceneRunner,
  canvas: HTMLCanvasElement,
  page: Window,
  shots: PageBotShot[]
): BotWorld => {
  const sink = new DomInputSink(canvas, page);
  const scene = runner as unknown as BotSceneHandle;
  const canvasHandle = canvas as unknown as BotCanvasHandle;
  const sticks = new PhysicalAxisDriver(scene, canvasHandle, sink);
  const heldKeys = new Set<string>();
  const openTaps = new Map<string, { nx: number; ny: number }>();
  let swipeDown: { nx: number; ny: number } | null = null;

  return {
    channel: 'physical-input',
    findNodes: (query, max) => collectBotNodeViews(scene, query, max),
    nearestOfType: (type, from) => nearestBotNode(scene, type, from),
    raycast: (from, dir) => raycastBotNodes(scene, from, dir),
    pointIn: (query, x, y) => botPointInNode(scene, query, x, y),
    gameState: () => {
      const snapshot = (page as PageWindow).__PIX3_GAME_DEBUG__?.snapshot?.();
      return snapshot === undefined ? null : (JSON.parse(JSON.stringify(snapshot)) as Json);
    },
    pressAction: action => {
      const code = keyCodeOf(action) ?? keyCodeOf(`Key_${action}`);
      if (!code) {
        return `"${action}" is not a key: on the page only keys and pointers exist — tap() a control, or press a key the game binds.`;
      }
      sink.key('down', code);
      heldKeys.add(code);
      return null;
    },
    releaseAction: action => {
      const code = keyCodeOf(action) ?? keyCodeOf(`Key_${action}`);
      if (!code) return null;
      sink.key('up', code);
      heldKeys.delete(code);
      return null;
    },
    tapDown: target => {
      const node = runner.getLiveNodeById(target) ?? runner.findLiveNodeByName(target);
      if (!node) return `no live node named or with id "${target}" in the running scene.`;
      if (!node.visible) return `"${target}" has visible:false, so it cannot be tapped.`;
      const backing = runner.projectNodeToCanvas(node);
      const at = backing ? toCanvasFraction(canvas, backing) : null;
      if (!at) return `"${target}" could not be projected to the canvas.`;
      openTaps.set(target, at);
      sink.pointer('down', at.nx, at.ny, BOT_POINTER_ID);
      return null;
    },
    tapUp: target => {
      const at = openTaps.get(target);
      if (!at) return;
      openTaps.delete(target);
      sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID);
    },
    setAxisValue: (name, value) => sticks.steer(name, value),
    pointAt: point => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y);
      if (!at)
        return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
      sink.pointer('move', at.nx, at.ny, BOT_POINTER_ID);
      return null;
    },
    pointerAt: (phase, point) => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y);
      if (!at)
        return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
      if (phase === 'down') swipeDown = at;
      if (phase === 'up') swipeDown = null;
      sink.pointer(phase, at.nx, at.ny, BOT_POINTER_ID);
      return null;
    },
    tapAtDown: point => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y);
      if (!at)
        return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
      swipeDown = at;
      sink.pointer('down', at.nx, at.ny, BOT_POINTER_ID);
      return null;
    },
    tapAtUp: point => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y) ?? swipeDown;
      swipeDown = null;
      if (at) sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID);
    },
    dispatchCommand: (name, args) => {
      const commands = commandsOf(runner);
      if (!commands) return 'the running scene has no command registry.';
      if (!commands.list().some(entry => entry.name === name)) {
        return `no command "${name}" is registered (registered: ${
          commands
            .list()
            .map(e => e.name)
            .join(', ') || 'none'
        }).`;
      }
      return commands.dispatch(name, args) ? null : `command "${name}" refused or threw.`;
    },
    requestScreenshot: (name, frame) => {
      // The policy ticks after the frame was drawn, so pausing here holds exactly what it saw.
      runner.pause();
      shots.push({ name, frame });
      return null;
    },
    releaseAll: () => {
      if (swipeDown) sink.pointer('up', swipeDown.nx, swipeDown.ny, BOT_POINTER_ID);
      swipeDown = null;
      for (const code of heldKeys) sink.key('up', code);
      heldKeys.clear();
      for (const at of openTaps.values()) sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID);
      openTaps.clear();
      sticks.releaseAll();
    },
  };
};

/**
 * Start `policyModule` (the compiled policy file's exports) on the running game of this page.
 * Throws a sentence when the page has no running game or the module is not a policy.
 */
export const startPageBot = (
  name: string,
  policyModule: unknown,
  args: Record<string, unknown> = {}
): PageBotHandle => {
  const page = window as PageWindow;
  const runner = page.__PIX3_PLAYER__?.runner;
  if (!runner) throw new Error('the page has no running game (window.__PIX3_PLAYER__.runner)');
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('the game has no canvas on this page');
  const resolved = resolveBotPolicy(policyModule);
  if ('error' in resolved) throw new Error(resolved.error);
  const errors: string[] = [];
  const shots: PageBotShot[] = [];
  const session = new BotSession(
    name,
    resolved.policy,
    buildPageWorld(runner, canvas, page, shots),
    error => errors.push(error.message),
    args
  );
  // Fixed 1/60 s ticks while the bot plays: a headless page paints at 10–30 fps, and in realtime a
  // tick's game time followed it, so `bot.frame` was not game time and a 300 ms effect lived a
  // different number of ticks each run — no frame of it could be asked for (core-tests/game8).
  const previousTime = runner.getTimeMode();
  runner.setTimeMode({ mode: 'fixed', fixedDeltaSec: 1 / 60, ticksPerFrame: 1 });
  const detach = runner.subscribeFrameStats(() => {
    session.tick();
    // Hold the frame the verdict was reached on: the final screenshot shows what was judged.
    if (session.finished) runner.pause();
  });
  const handle: PageBotHandle = {
    get finished() {
      return session.finished;
    },
    get frame() {
      return session.frame;
    },
    takeShot: () => shots.shift() ?? null,
    resume: () => {
      if (shots.length === 0 && !session.finished) runner.resume();
    },
    report: () => session.report(),
    stop: () => {
      detach();
      session.dispose();
      runner.setTimeMode(previousTime);
      return session.report();
    },
  };
  page.__PIX3_PAGE_BOT__ = handle;
  return handle;
};
