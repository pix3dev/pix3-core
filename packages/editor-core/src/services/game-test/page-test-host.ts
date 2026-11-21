import type { RuntimeRenderer, SceneRunner } from '@pix3/runtime';
import { BRIDGE_TOOLS, validateParams } from '@/host/bridge-tools';
import {
  errors as capturedErrors,
  findLiveNodes,
  installErrorCapture,
  readLiveNode,
  type Json,
} from '@/core/agent-introspection';
import { BackgroundTicker, keepaliveSleep } from '@/services/core/background-ticker';
import { setEditorKeepAlive } from '@/services/core/page-activity';
import { loadBotPolicy, ModuleBotStore } from '@/services/game-test/bot-loader';
import { dispatchBotCommand, tickBotOnFrames } from '@/services/game-test/bot-host';
import { DomInputSink } from '@/services/game-test/frame-input';
import {
  BOT_POINTER_ID,
  BotPinch,
  PhysicalAxisDriver,
  collectBotNodeViews,
  keyCodeOf,
  nearestBotNode,
  projectToCanvasFraction,
  botPointInNode,
  hiddenReason,
  raycastBotNodes,
  shortSwipeNote,
  toCanvasFraction,
  type BotCanvasHandle,
  type BotSceneHandle,
} from '@/services/game-test/game-bot-world';
import { BotSession, type BotReport, type BotWorld } from '@/services/game-test/game-bots';
import { GameInputService } from '@/services/game-test/GameInputService';
import { GameTestService } from '@/services/game-test/GameTestService';
import type { GameRuntimeHandle, GameTestHost } from '@/services/game-test/game-runtime-handle';
import { InMemoryReachabilityStore } from '@/services/game-test/reachability-journal';

/**
 * The test host on the game's own page (plan play-in-page S3, D3/D10): what `pix3_game_run` does
 * in the editor — predicates, watch, monkey, `direct-action`, the negative control — run by the
 * page itself, plus the realtime policy run of `pix3 play --bot`. {@link installPageTools} puts
 * it on `window.__PIX3_PLAYER__.tools.call(name, params)`.
 *
 * Two ways onto a page, one source:
 * - the dev server: `editor-core` builds this file into `dist/page-test-host.js` (`@pix3/runtime`
 *   and `three` external), and `virtual:pix3/dev` imports it by path, lazily — on `?debug`, or
 *   when `__PIX3_PLAYER__.loadTools()` is called (`pix3 play`). It shares the page's runtime, and
 *   the policies come from `virtual:pix3/bot-policies`;
 * - a build (`pix3 play dist`): the CLI bundles it into an IIFE with a runtime shim and injects
 *   it with the policy it compiled (`packages/cli/src/play/bundle.ts`).
 *
 * `check-dist` refuses an entry that reaches the editor (services, state, DI, `lit`, `yaml`).
 */

/** The slice of `window.__PIX3_PLAYER__` this host reads and writes. */
interface PagePlayer {
  status: string;
  frames: number;
  scene: string | null;
  runner: SceneRunner | null;
  renderer: RuntimeRenderer | null;
  tools?: PageTools;
}

interface PageWindow extends Window {
  __PIX3_PLAYER__?: PagePlayer;
  __PIX3_GAME_DEBUG__?: { snapshot?: () => unknown };
  __PIX3_PAGE_BOT__?: PageBotHandle;
}

/** `__PIX3_PLAYER__.tools`: the page's test tools, by name. */
export interface PageTools {
  /**
   * `game_run` (the params of `pix3_game_run`), `game_controls`, `game_cancel`, `bot_start`
   * (`{name, args?}`: the realtime policy run of `pix3 play --bot`, read through
   * `window.__PIX3_PAGE_BOT__`), and the live reads behind `pix3_scene` on the page —
   * `live_node` (`{nodeId, byName?}` → `{node, screen, components}`, `screen` in this page's CSS
   * px) and `live_find` (`{text}` → `{matches}`). A refusal is `{ok: false, reason, detail}`, as
   * on the bridge.
   */
  call(name: string, params?: unknown): Promise<unknown>;
}

export interface PageTestOptions {
  /**
   * The project's policies by glob key (`/design/tests/bots/<name>.ts`): `virtual:pix3/bot-policies`
   * `modules` on the dev page; the one policy the CLI compiled on a build.
   */
  readonly botPolicies: () => Readonly<Record<string, Record<string, unknown>>>;
}

interface PageRefusal {
  ok: false;
  reason: string;
  detail: string;
}

const refuse = (reason: string, detail: string): PageRefusal => ({ ok: false, reason, detail });

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
  const pinch = new BotPinch(scene, canvasHandle, sink);
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
      const hidden = hiddenReason(node, target);
      if (hidden) return hidden;
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
    pointerAt: (phase, point, pointer) => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y);
      if (!at)
        return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
      const startedAt = swipeDown;
      if (phase === 'down') swipeDown = at;
      if (phase === 'up') swipeDown = null;
      sink.pointer(phase, at.nx, at.ny, BOT_POINTER_ID, pointer);
      return phase === 'up' && startedAt ? shortSwipeNote(canvasHandle, startedAt, at) : null;
    },
    tapAtDown: (point, pointer) => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y);
      if (!at)
        return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
      swipeDown = at;
      sink.pointer('down', at.nx, at.ny, BOT_POINTER_ID, pointer);
      return null;
    },
    tapAtUp: (point, pointer) => {
      const at = projectToCanvasFraction(scene, canvasHandle, point.x, point.y) ?? swipeDown;
      swipeDown = null;
      if (at) sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID, pointer);
    },
    dispatchCommand: (name, args) => dispatchBotCommand(runner, name, args),
    requestScreenshot: (name, frame) => {
      // Paused on the tick the policy saw, and painted: a batch paints only its last tick, so this
      // one may not have been drawn yet.
      runner.pause();
      runner.renderOnce();
      shots.push({ name, frame });
      return null;
    },
    sendToBackground: awayMs => {
      runner.simulateBackground(awayMs);
      return null;
    },
    pinchAt: (phase, center, spread) => pinch.at(phase, center, spread),
    releaseAll: () => {
      pinch.releaseAll();
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

/** Logic ticks per painted frame while a bot plays on the page. */
const BOT_TICKS_PER_FRAME = 4;

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

/**
 * The page's runtime as a {@link GameRuntimeHandle}. Pause is the runner's own (the player has no
 * focus rule); "focus-pause suppressed" means the game keeps ticking while the page is hidden —
 * frames move from rAF to `BackgroundTicker`'s worker, which a hidden page does not throttle.
 */
const pageRuntime = (player: PagePlayer, page: Window): GameRuntimeHandle | null => {
  const { runner, renderer } = player;
  if (!runner || !renderer || player.status !== 'running') return null;
  return {
    runner,
    renderer,
    canvas: renderer.domElement,
    windowRef: page,
    setPauseRequested: paused => (paused ? runner.pause() : runner.resume()),
    setFocusPauseSuppressed: suppressed => setBackgroundTicks(player, suppressed),
  };
};

let backgroundTicker: BackgroundTicker | null = null;

/**
 * Worker-driven frames while the page is hidden (S0.2: a hidden page gets no rAF, and a run on the
 * agent's background page would stall), for the length of a run; rAF again afterwards. The
 * frames are counted into `__PIX3_PLAYER__.frames` exactly as the player's own scheduler does.
 */
const setBackgroundTicks = (player: PagePlayer, on: boolean): void => {
  const runner = player.runner;
  if (!runner || on === (backgroundTicker !== null)) return;
  // The run keeps the game `active`: no background pause, no `scene.app.onBackground`.
  runner.setBackgroundHeld(on);
  const counted =
    (callback: (time: number) => void) =>
    (time: number): void => {
      player.frames++;
      callback(time);
    };
  if (on) {
    const ticker = new BackgroundTicker();
    backgroundTicker = ticker;
    setEditorKeepAlive(true);
    runner.setFrameScheduler({
      request: callback => ticker.request(counted(callback)),
      cancel: handle => ticker.cancel(handle),
    });
    return;
  }
  runner.setFrameScheduler({
    request: callback => requestAnimationFrame(counted(callback)),
    cancel: handle => cancelAnimationFrame(handle),
  });
  backgroundTicker?.dispose();
  backgroundTicker = null;
  setEditorKeepAlive(false);
};

/** The one run a page holds at a time: a `game_run` or a `bot_start`. */
let active: { readonly kind: 'game_run' | 'bot'; cancel(): void } | null = null;

const busy = (): PageRefusal =>
  refuse(
    'run_active',
    `A ${active?.kind === 'bot' ? 'bot (pix3 play --bot)' : 'game_run'} is already running on this page: wait for it, or call game_cancel.`
  );

/**
 * Give back what an interrupted run may still hold: a pointer down (the negative control's
 * gesture) and the run's pause (the worker frames end with the run's own `finally`). Bots and monkeys release their own input in the
 * loop's `finally`; a pointer is cancelled rather than lifted, so nothing is tapped on the way out.
 */
const releaseInterrupted = (runtime: GameRuntimeHandle, wasPaused: boolean): void => {
  for (const pointerId of new Set([1, BOT_POINTER_ID])) {
    runtime.canvas.dispatchEvent(
      typeof PointerEvent === 'function'
        ? new PointerEvent('pointercancel', { pointerId, bubbles: true })
        : new Event('pointercancel', { bubbles: true })
    );
  }
  runtime.setPauseRequested(wasPaused);
};

/**
 * Start a policy in realtime on the running game (`pix3 play --bot`): fixed 1/60 s ticks, four per
 * painted frame, `bot.screenshot` pauses for the CLI's picture. Throws a sentence when the page
 * has no running game, another run holds it, or the policy does not load.
 */
const startPageBot = async (
  player: PagePlayer,
  page: PageWindow,
  options: PageTestOptions,
  name: string,
  args: Record<string, unknown>
): Promise<PageBotHandle> => {
  if (active) throw new Error(busy().detail);
  const runtime = pageRuntime(player, page);
  if (!runtime) throw new Error(`the page has no running game (status ${player.status})`);
  const loaded = await loadBotPolicy(new ModuleBotStore(options.botPolicies), name);
  if ('error' in loaded) throw new Error(loaded.error);
  const { runner, canvas } = runtime;
  const errors: string[] = [];
  const shots: PageBotShot[] = [];
  const session = new BotSession(
    loaded.name,
    loaded.policy,
    buildPageWorld(runner, canvas, page, shots),
    error => errors.push(error.message),
    args
  );
  // Fixed 1/60 s ticks while the bot plays: a headless page paints at 10–30 fps, and in realtime a
  // tick's game time followed it, so `bot.frame` was not game time and a 300 ms effect lived a
  // different number of ticks each run — no frame of it could be asked for (core-tests/game8).
  const previousTime = runner.getTimeMode();
  // Four ticks per animation frame, one paint each: a headless page paints in software, and
  // painting every tick held a round to 6–8 frames a second (core-tests/game14). A picture or the
  // verdict paints its own tick (`renderOnce`), so nothing a policy photographs is a stale frame.
  runner.setTimeMode({
    mode: 'fixed',
    fixedDeltaSec: 1 / 60,
    ticksPerFrame: BOT_TICKS_PER_FRAME,
    renderEveryNTicks: BOT_TICKS_PER_FRAME,
  });
  runtime.setFocusPauseSuppressed(true);
  // Hold the frame the verdict was reached on: the final screenshot shows what was judged.
  const detach = tickBotOnFrames(runner, session, () => {
    runner.pause();
    runner.renderOnce();
  });
  let stopped = false;
  const stop = (): BotReport => {
    if (!stopped) {
      stopped = true;
      active = null;
      detach();
      session.dispose();
      runner.setTimeMode(previousTime);
      runtime.setFocusPauseSuppressed(false);
    }
    return session.report();
  };
  active = { kind: 'bot', cancel: stop };
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
    stop,
  };
  page.__PIX3_PAGE_BOT__ = handle;
  return handle;
};

/** `game_run` under the page's run contract: one at a time, released on cancel and `pagehide`. */
const gameRun = async (
  player: PagePlayer,
  page: Window,
  service: GameTestService,
  params: unknown
): Promise<unknown> => {
  if (active) return busy();
  // The bridge's own schema first, so the page refuses what `pix3_game_run` refuses.
  const schema = BRIDGE_TOOLS.find(tool => tool.name === 'pix3_game_run')?.inputSchema;
  const problem = schema ? validateParams(schema, params ?? {}) : null;
  if (problem) return refuse('invalid_params', problem);
  const parsed = GameTestService.parseSpec(params);
  if ('error' in parsed) return refuse('invalid_spec', parsed.error);
  const runtime = pageRuntime(player, page);
  const wasPaused = runtime?.runner.paused ?? false;
  const abort = new AbortController();
  active = { kind: 'game_run', cancel: () => abort.abort() };
  try {
    const result = await service.run(parsed.spec, abort.signal);
    return result.ok ? result : refuse('refused', result.error ?? 'the game run did not start');
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    return refuse('cancelled', 'The run was cancelled (game_cancel, or the page is going away).');
  } finally {
    active = null;
    if (abort.signal.aborted && runtime) releaseInterrupted(runtime, wasPaused);
  }
};

/**
 * Install the page's test tools on `window.__PIX3_PLAYER__.tools` (idempotent) and return them.
 * Throws when the page has no player.
 */
export const installPageTools = (options: PageTestOptions): PageTools => {
  const page = window as PageWindow;
  const player = page.__PIX3_PLAYER__;
  if (!player) throw new Error('this page has no Pix3 player (window.__PIX3_PLAYER__)');
  if (player.tools) return player.tools;
  installErrorCapture();
  const host: GameTestHost = {
    isPlaying: () => player.status !== 'failed',
    runtime: () => pageRuntime(player, page),
    sceneId: () => player.scene ?? '',
    // The page does not read `pix3project.yaml`; the editor's lint is the one with the platform.
    targetPlatform: () => undefined,
    errors: () => capturedErrors(),
    sleep: keepaliveSleep,
    // On the worker while a run keeps the page alive: a hidden page throttles `setTimeout`.
    yieldToHost: () => keepaliveSleep(0),
    // Proofs last as long as the page: it cannot write the project's journal.
    reachabilityStore: () => new InMemoryReachabilityStore(),
    loadBot: name => loadBotPolicy(new ModuleBotStore(options.botPolicies), name),
  };
  const input = new GameInputService(host);
  const service = new GameTestService(host, input);
  page.addEventListener('pagehide', () => active?.cancel());
  const tools: PageTools = {
    call: async (name, params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      switch (name) {
        case 'game_run':
          return gameRun(player, page, service, params);
        case 'game_controls':
          return input.listControls();
        case 'game_cancel':
          if (!active) return { ok: true, cancelled: false };
          active.cancel();
          return { ok: true, cancelled: true };
        case 'live_node': {
          const runtime = pageRuntime(player, page);
          if (typeof record.nodeId !== 'string')
            return refuse('invalid_params', 'live_node takes {nodeId, byName?}.');
          const live = runtime
            ? readLiveNode(runtime.runner, runtime.canvas, record.nodeId, {
                byName: record.byName === true,
              })
            : null;
          return live
            ? { ok: true, node: live.dto, screen: live.screen, components: live.components }
            : refuse('not_found', `No live node "${record.nodeId}" in the running game.`);
        }
        case 'live_find': {
          const runtime = pageRuntime(player, page);
          if (typeof record.text !== 'string')
            return refuse('invalid_params', 'live_find takes {text}.');
          return { ok: true, matches: runtime ? findLiveNodes(runtime.runner, record.text) : [] };
        }
        case 'bot_start': {
          if (typeof record.name !== 'string')
            return refuse('invalid_spec', 'bot_start takes {name, args?}.');
          const args = (record.args ?? {}) as Record<string, unknown>;
          await startPageBot(player, page, options, record.name, args);
          return { ok: true };
        }
        default:
          return refuse(
            'unknown_tool',
            `No page tool "${name}": game_run, game_controls, game_cancel, bot_start, live_node, live_find.`
          );
      }
    },
  };
  player.tools = tools;
  return tools;
};
