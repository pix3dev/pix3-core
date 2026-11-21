/**
 * The bot host every place a policy plays shares: the editor's `pix3_game_run`
 * (`GameTestService`), the game's page (`page-test-host.ts`, `pix3 play --bot`) and Node
 * (`pix3 smoke --bot`, which bundles this file into its worker beside the runtime).
 *
 * What lives here is what needs no DOM: the session ticked from the runner's frame hook
 * ({@link tickBotOnFrames}), the `direct-action` world ({@link directActionWorld} — the input
 * service's buttons and axes, a control's own `click` interaction, the game's commands) and the
 * live lookups it shares with the editor's monkey. The `physical-input` worlds stay with their
 * hosts: they need a canvas and DOM events.
 *
 * It is in the page host's graph, so `check-dist` holds it to the same rule: nothing of the
 * editor, only `@pix3/runtime`, `three` and the other `game-test` files.
 */

import { isInteractive, type Interactive, type NodeBase, type SceneRunner } from '@pix3/runtime';
import type { Json } from '@/core/agent-introspection';
import {
  botPointInNode,
  collectBotNodeViews,
  hiddenReason,
  nearestBotNode,
  raycastBotNodes,
  type BotSceneHandle,
} from '@/services/game-test/game-bot-world';
import {
  BotSession,
  resolveBotPolicy,
  type BotReport,
  type BotWorld,
} from '@/services/game-test/game-bots';

/**
 * Who answers to this interaction on this node — the node itself (an engine
 * control) or one of its script components. Resolved per press rather than cached,
 * because a monkey run outlives the nodes it presses.
 */
export function findInteractionOwner(node: NodeBase, interaction: string): Interactive | null {
  const offers = (candidate: unknown): Interactive | null => {
    if (!isInteractive(candidate)) return null;
    try {
      return candidate.getInteractions().some(entry => entry.name === interaction)
        ? candidate
        : null;
    } catch {
      return null;
    }
  };
  const own = offers(node);
  if (own) return own;
  for (const component of node.components ?? []) {
    const found = offers(component);
    if (found) return found;
  }
  return null;
}

/** The live `InputService`, reached the same way the listing reaches it: through a root node. */
export function resolveLiveInput(runner: SceneRunner): {
  setButton(name: string, pressed: boolean): void;
  setAxis?(name: string, value: number): void;
  getAxis?(name: string): number;
} | null {
  for (const root of runner.getLiveRootNodes()) {
    const input = (root as { input?: unknown }).input as
      | { setButton?: (name: string, pressed: boolean) => void }
      | undefined;
    if (input && typeof input.setButton === 'function') {
      return input as { setButton(name: string, pressed: boolean): void };
    }
  }
  return null;
}

/** The slice of the scene's command registry a bot dispatches through. */
interface BotCommands {
  list(): Array<{ name: string }>;
  /** From outside the game: a run recording keeps it as input. */
  dispatchExternal(name: string, args?: Record<string, unknown>): boolean;
}

const commandsOf = (runner: SceneRunner): BotCommands | null => {
  for (const root of runner.getLiveRootNodes()) {
    const commands = (root.scene as { commands?: BotCommands } | undefined)?.commands;
    if (commands) return commands;
  }
  return null;
};

/** `bot.command(name, args)` on the running game: `null`, or the sentence of the refusal. */
export function dispatchBotCommand(
  runner: SceneRunner,
  name: string,
  args?: Record<string, unknown>
): string | null {
  const commands = commandsOf(runner);
  if (!commands) return 'the running scene has no command registry (is it still running?).';
  if (!commands.list().some(entry => entry.name === name)) {
    const known = commands.list().map(entry => entry.name);
    return `no command "${name}" is registered${known.length ? ` (registered: ${known.join(', ')})` : ' — the game registers none (scene.commands.register)'}.`;
  }
  return commands.dispatchExternal(name, args)
    ? null
    : `command "${name}" declined (its handler returned false) or threw.`;
}

const PHYSICAL_ONLY = (gesture: string, instead: string): string =>
  `${gesture} is a physical gesture; on \`direct-action\` there is nothing to call. ${instead}`;

/** `Key_A` / `Action_Jump` as given; a bare name is a key. */
const buttonName = (action: string): string =>
  action.startsWith('Key_') || action.startsWith('Action_') ? action : `Key_${action}`;

/**
 * The `direct-action` world: senses like every world, actuates on the game's logic — a button or
 * an axis set on the live input service, a control's `click` interaction invoked, a command
 * dispatched. No canvas, no DOM: it is the world of a policy in Node. Gestures that only exist as
 * pointers (`tapAt`, `swipe`, `pinch`, `moveTo`) are refused with the sentence saying so.
 */
export function directActionWorld(runner: SceneRunner, gameState: () => Json | null): BotWorld {
  const scene = runner as unknown as BotSceneHandle;
  const heldButtons = new Set<string>();
  return {
    channel: 'direct-action',
    findNodes: (query, max) => collectBotNodeViews(scene, query, max),
    nearestOfType: (type, from) => nearestBotNode(scene, type, from),
    raycast: (from, dir) => raycastBotNodes(scene, from, dir),
    pointIn: (query, x, y) => botPointInNode(scene, query, x, y),
    gameState,
    pressAction: action => {
      const input = resolveLiveInput(runner);
      if (!input) {
        return `no live InputService could be reached to set "${action}" directly (is the scene still running?).`;
      }
      input.setButton(buttonName(action), true);
      heldButtons.add(buttonName(action));
      return null;
    },
    releaseAction: action => {
      resolveLiveInput(runner)?.setButton(buttonName(action), false);
      heldButtons.delete(buttonName(action));
      return null;
    },
    tapDown: target => {
      const node = runner.getLiveNodeById(target) ?? runner.findLiveNodeByName(target);
      if (!node) return `no live node named or with id "${target}" in the running scene.`;
      const hidden = hiddenReason(node, target);
      if (hidden) return hidden;
      const owner = findInteractionOwner(node, 'click');
      if (!owner) {
        return `"${target}" declares no "click" interaction, so the direct channel has nothing to call. game_controls lists what each node offers; on \`physical-input\` this same call would be a real pointer press instead.`;
      }
      return owner.invokeInteraction('click')
        ? null
        : `"${target}" refused "click" — the control is disabled, or an ancestor scroll container holds the pointer.`;
    },
    tapUp: () => {},
    setAxisValue: (name, value) => {
      const input = resolveLiveInput(runner);
      if (typeof input?.setAxis !== 'function') {
        return `no live InputService could be reached to set axis "${name}" directly.`;
      }
      input.setAxis(name, value);
      return null;
    },
    pointAt: () =>
      PHYSICAL_ONLY('moveTo()', 'Aim through the game: a command(), or an axis it reads.'),
    pointerAt: () =>
      PHYSICAL_ONLY(
        'swipe()',
        'Run the policy on `physical-input`, or drive the intent with command().'
      ),
    tapAtDown: () =>
      PHYSICAL_ONLY(
        'tapAt()',
        'Tap a control by name with tap(), run on `physical-input`, or drive the intent with command().'
      ),
    tapAtUp: () => {},
    pinchAt: () =>
      PHYSICAL_ONLY(
        'pinch()',
        'Run the policy on `physical-input`, or drive the intent with command().'
      ),
    dispatchCommand: (name, args) => dispatchBotCommand(runner, name, args),
    requestScreenshot: (name, frame) =>
      `screenshot "${name}" at frame ${frame}: a marker here — nothing is painted on this channel (pix3 play --bot takes the picture).`,
    sendToBackground: awayMs => {
      runner.simulateBackground(awayMs);
      return null;
    },
    releaseAll: () => {
      const input = resolveLiveInput(runner);
      for (const name of heldButtons) input?.setButton(name, false);
      heldButtons.clear();
    },
  };
}

/**
 * Tick `session` once per logic tick, from the runner's frame hook (the timing contract of
 * `game-bots.ts`: after the tick, actuators land on the next one); `onFinished` runs on the tick
 * the policy reached its verdict, crashed or ended. Returns the unsubscribe.
 */
export function tickBotOnFrames(
  runner: SceneRunner,
  session: BotSession,
  onFinished?: () => void
): () => void {
  return runner.subscribeFrameStats(() => {
    if (session.finished) return;
    session.tick();
    if (session.finished) onFinished?.();
  });
}

/** A policy playing on `direct-action` (Node): its session and the stop that reports it. */
export interface DirectBot {
  readonly session: BotSession;
  /** End the run: `end()` runs, everything held is released, the frame hook is dropped. */
  stop(): BotReport;
}

/**
 * Start a policy module (its namespace, as imported) on `direct-action` against a running
 * game: `pix3 smoke --bot`. A sentence when the module holds no policy.
 */
export function startDirectBot(
  runner: SceneRunner,
  options: {
    readonly name: string;
    readonly module: unknown;
    readonly args?: Record<string, unknown>;
    readonly gameState: () => Json | null;
    readonly onError?: (error: { message: string; stack?: string }) => void;
  }
): DirectBot | { error: string } {
  const resolved = resolveBotPolicy(options.module);
  if ('error' in resolved) return resolved;
  const session = new BotSession(
    options.name,
    resolved.policy,
    directActionWorld(runner, options.gameState),
    options.onError,
    options.args ?? {}
  );
  const detach = tickBotOnFrames(runner, session);
  let stopped = false;
  return {
    session,
    stop: () => {
      if (!stopped) {
        stopped = true;
        detach();
        session.dispose();
      }
      return session.report();
    },
  };
}
