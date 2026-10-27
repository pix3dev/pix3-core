import { NodeBase, SceneManager, type RunOverrides, type SceneNodeDefinition } from '@pix3/runtime';

import {
  clearErrors,
  componentToDTO,
  errors,
  installErrorCapture,
  nodeToDTO,
  safeSerialize,
  type Json,
  type CapturedError,
  type ComponentDTO,
  type NodeDTO,
  type NodeSummary,
} from '@/core/agent-introspection';
import { ServiceContainer } from '@/fw/di';
import { StartSceneGameCommand } from '@/features/scripts/StartSceneGameCommand';
import { openGameSurface } from '@/features/scripts/play-workspace';
import { AgentKeepaliveService } from '@/services/core/AgentKeepaliveService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { resolveCommandDispatcher } from '@/services/core/CommandDispatcher';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { GameTestService } from '@/services/game-test/GameTestService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { FlushService } from '@/services/project/FlushService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { diffScenes, indexNodes, leafKey } from '@/core/scene-patch/scene-diff';
import { normOfGraph } from '@/core/scene-patch/scene-norm';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { appState } from '@/state';
import type { GameAspectRatio } from '@/state/AppState';

import {
  BRIDGE_GROUP_DESCRIPTION,
  BRIDGE_GROUP_NAME,
  BRIDGE_TOOLS,
  validateParams,
  type BridgeToolSpec,
} from './bridge-tools';
import type { HookReply } from './EditorHost';
import { HostService } from './HostService';

/**
 * The agent bridge (plan §D.1): what a coding agent reads and drives in the open editor tab
 * through Chrome DevTools MCP. ONE implementation — the tool table of `bridge-tools.ts` with the
 * executes below — behind two transports:
 *
 * - the page's third-party developer tools: the tab answers chrome-devtools-mcp's
 *   `devtoolstooldiscovery` event with the `pix3` group, and the agent calls
 *   `list_3p_developer_tools` / `execute_3p_developer_tool {toolName, params}`;
 * - the inline fallback: `window.__PIX3_DEBUG__.call(name, params)` from `evaluate_script`,
 *   plus the short forms (`status()`, `sync()`, `play.start()`, …) that map onto the same calls.
 *
 * Scenes change through FILES, never through this bridge. Every refusal says why:
 * `{ok:false, reason, detail}`. Every call keeps the editor awake (plan §D.4 keepalive).
 */

export type BridgeResult<T extends object = object> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

type Params = Record<string, unknown>;

export type PlayAspect = 'free' | '16:9' | '9:16' | '4:3';

export interface PlayStatus {
  playing: boolean;
  status: string;
  playOwner: string | null;
  startedAt: number | null;
  /** The Game tab's aspect preset (`free` fills the panel). */
  aspect: PlayAspect;
}

/** `window.__PIX3_DEBUG__`: the tool table, `call`, and short forms over the same calls. */
export interface Pix3DebugBridge {
  readonly version: 2;
  /** The tools as `list_3p_developer_tools` lists them. */
  tools(): BridgeToolSpec[];
  /** The inline transport: the same tool, the same params, the same answer as the 3p path. */
  call(name: string, params?: Params): Promise<Record<string, unknown>>;
  help(): Record<string, string>;
  status(): Promise<Record<string, unknown>>;
  sync(options?: { expect?: Record<string, string>; timeoutMs?: number }): Promise<HookReply>;
  scene(maxDepth?: number): Promise<(NodeDTO & { sceneVersion: string }) | null>;
  node(nodeId: string): Promise<(NodeDTO & { saved: SceneNodeDefinition | null }) | null>;
  find(text: string): Promise<NodeSummary[]>;
  /** A node's origin on the page in CSS px (to click or drag it), or null when not in view. */
  screen(nodeId: string): Promise<{ x: number; y: number } | null>;
  /** Unsaved edits per scene path: the keys a flush would write; `{}` = everything on disk. */
  pending(): Promise<Record<string, string[]>>;
  selection(): { nodeIds: string[]; primaryNodeId: string | null };
  errors(): CapturedError[];
  clearErrors(): void;
  readonly play: {
    status(): PlayStatus;
    start(scenePath?: string): Promise<BridgeResult>;
    stop(options?: { force?: boolean }): Promise<BridgeResult>;
    restart(): Promise<BridgeResult>;
    pause(): Promise<BridgeResult>;
    resume(): Promise<BridgeResult>;
  };
}

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

const refuse = <T extends object = object>(reason: string, detail?: string): BridgeResult<T> => ({
  ok: false,
  reason,
  detail,
});

let callCounter = 0;

/** How long a restart waits for the versions held during play to be applied. */
const RESTART_SETTLE_MS = 15_000;

/** Keep the editor awake for the agent while `work` runs (plan §D.4). */
const asAgentCall = async <T>(work: () => Promise<T>): Promise<T> => {
  const keepalive = service(AgentKeepaliveService);
  const id = `bridge-${++callCounter}`;
  keepalive.noteCallStarted(id);
  try {
    return await work();
  } finally {
    keepalive.noteCallFinished(id);
  }
};

// --- scene reads ---------------------------------------------------------------------------------

const descriptorFor = (path: string | undefined) => {
  if (path === undefined) {
    const activeId = appState.scenes.activeSceneId;
    return activeId ? (appState.scenes.descriptors[activeId] ?? null) : null;
  }
  const wanted = toProjectPath(path);
  return (
    Object.values(appState.scenes.descriptors).find(d => toProjectPath(d.filePath) === wanted) ??
    null
  );
};

const graphOf = (path: string | undefined) => {
  const descriptor = descriptorFor(path);
  const graph = descriptor ? service(SceneManager).getSceneGraph(descriptor.id) : null;
  return descriptor && graph ? { descriptor, graph } : null;
};

/**
 * Each node as the scene file gets it (W13): the saver's view of the live graph, layout-derived
 * values masked with the baseline's. The nodes' `properties` bag is only what the YAML said at
 * load time — an inspector edit lands in a field, so reading the bag answered the old value.
 */
const savedNodesOf = (found: NonNullable<ReturnType<typeof graphOf>>) => {
  const { graph, descriptor } = found;
  const baseline = service(SceneBaselineService).get(descriptor.filePath);
  const norm = baseline
    ? service(FlushService).editorNorm(graph, baseline.norm)
    : normOfGraph(graph);
  return indexNodes(norm);
};

const savedPropertiesOf =
  (saved: ReturnType<typeof savedNodesOf>) =>
  (node: NodeBase): Json | undefined => {
    const def = saved.get(node.nodeId)?.def;
    return def ? safeSerialize(def.properties ?? {}, 4) : undefined;
  };

const sceneTree = (
  found: NonNullable<ReturnType<typeof graphOf>>,
  maxDepth: number
): NodeDTO & { sceneVersion: string } => {
  const { graph } = found;
  const propertiesOf = savedPropertiesOf(savedNodesOf(found));
  const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
  return {
    nodeId: '<scene-root>',
    type: 'SceneRoot',
    name: graph.description ?? 'Scene',
    visible: true,
    transform: { position: null, rotation: null, scale: null },
    groups: [],
    componentCount: 0,
    properties: null,
    children: roots.map(root => nodeToDTO(root, maxDepth - 1, propertiesOf)),
    sceneVersion: graph.version,
  };
};

const nodeRead = (
  found: NonNullable<ReturnType<typeof graphOf>>,
  nodeId: string
): BridgeResult<{
  node: NodeDTO;
  saved: SceneNodeDefinition | null;
  screen: { x: number; y: number } | null;
  live?: { components: ComponentDTO[] };
  runtimeOnly?: true;
}> => {
  const { graph, descriptor } = found;
  const node = graph.nodeMap.get(nodeId);
  const active = descriptor.id === appState.scenes.activeSceneId;
  if (!(node instanceof NodeBase)) {
    // A node a script made during play (a gem, a bullet) or one of the scene `changeScene` went to
    // is only in the running game: answer it from there, by id or by name (core-tests/game7, where
    // every gem was spawned and `--node gem-1` read not_found).
    const spawned = active ? livePlayNode(nodeId, { byName: true }) : null;
    if (!spawned)
      return refuse('not_found', `No node "${nodeId}" in the scene or the running game.`);
    return {
      ok: true,
      node: spawned.dto,
      saved: null,
      screen: spawned.screen,
      live: { components: spawned.components },
      runtimeOnly: true,
    };
  }
  const savedNodes = savedNodesOf(found);
  const dto = nodeToDTO(node, 0, savedPropertiesOf(savedNodes));
  dto.components = node.components.map((c, i) => componentToDTO(c, i));
  const saved = savedNodes.get(nodeId)?.def ?? null;
  const live = active ? livePlayNode(nodeId) : null;
  // During play the editor viewport is hidden behind the Game tab: `screen` is where the RUNNING
  // node is on the game canvas, and `live` its components' play-time state (`node` stays what the
  // editor holds — the scene as authored).
  const screen = live
    ? live.screen
    : active
      ? service(ViewportRendererService).projectNodeToClient(node)
      : null;
  return {
    ok: true,
    node: dto,
    saved,
    screen,
    ...(live ? { live: { components: live.components } } : {}),
  };
};

/**
 * The play clone of `nodeId` in the running game (or, with `byName`, the first live node of that
 * name), its page position and component state.
 */
const livePlayNode = (
  nodeId: string,
  options: { byName?: boolean } = {}
): {
  dto: NodeDTO;
  screen: { x: number; y: number } | null;
  components: ComponentDTO[];
} | null => {
  const runtime = service(GamePlaySessionService).getActiveRuntime();
  if (!runtime) return null;
  const node =
    runtime.runner.getLiveNodeById(nodeId) ??
    (options.byName ? runtime.runner.findLiveNodeByName(nodeId) : null);
  if (!node) return null;
  const components = node.components.map((c, i) => componentToDTO(c, i));
  const dto = nodeToDTO(node, 0);
  dto.components = components;
  const backing = runtime.runner.projectNodeToCanvas(node);
  const canvas = runtime.canvas;
  const rect = canvas.getBoundingClientRect();
  // A popped-out game window is another page: its coordinates would not click this one.
  if (!backing || runtime.windowRef !== window || rect.width <= 0 || canvas.width <= 0) {
    return { dto, screen: null, components };
  }
  return {
    dto,
    screen: {
      x: rect.left + (backing.x / canvas.width) * rect.width,
      y: rect.top + (backing.y / canvas.height) * rect.height,
    },
    components,
  };
};

/** At most this many `find` matches from the running game (a board of gems is 64). */
const MAX_LIVE_MATCHES = 200;

/**
 * Nodes whose name or type contains `text`: the editor's scene, then — during play — the nodes
 * only the running game has (`runtimeOnly: true`: spawned by a script, or in a scene the game
 * changed to).
 */
const findNodes = (
  graph: NonNullable<ReturnType<typeof graphOf>>['graph'],
  text: string
): Array<NodeSummary & { runtimeOnly?: true }> => {
  const needle = text.toLowerCase();
  const hit = (node: NodeBase) =>
    node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle);
  const matches: Array<NodeSummary & { runtimeOnly?: true }> = [];
  for (const node of graph.nodeMap.values()) {
    if (hit(node)) matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
  }
  const runtime = service(GamePlaySessionService).getActiveRuntime();
  if (!runtime) return matches;
  const stack: NodeBase[] = [...runtime.runner.getLiveRootNodes()].reverse();
  let live = 0;
  while (stack.length > 0 && live < MAX_LIVE_MATCHES) {
    const node = stack.pop() as NodeBase;
    if (hit(node) && !graph.nodeMap.has(node.nodeId)) {
      matches.push({ nodeId: node.nodeId, type: node.type, name: node.name, runtimeOnly: true });
      live += 1;
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child instanceof NodeBase) stack.push(child);
    }
  }
  return matches;
};

const pendingKeys = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  const manager = service(SceneManager);
  const baselines = service(SceneBaselineService);
  for (const descriptor of Object.values(appState.scenes.descriptors)) {
    const graph = manager.getSceneGraph(descriptor.id);
    const baseline = baselines.get(descriptor.filePath);
    if (!graph || !baseline) continue;
    const ops = diffScenes(baseline.norm, service(FlushService).editorNorm(graph, baseline.norm));
    if (ops.length === 0) continue;
    out[toProjectPath(descriptor.filePath)] = ops.map(op =>
      op.kind === 'set' || op.kind === 'delete'
        ? leafKey(op.nodeId, op.path)
        : `${op.kind}:${op.kind === 'addNode' ? op.def.id : op.nodeId}`
    );
  }
  return out;
};

const selection = () => ({
  nodeIds: [...appState.selection.nodeIds],
  primaryNodeId: appState.selection.primaryNodeId,
});

// --- play ----------------------------------------------------------------------------------------

const playStatus = (): PlayStatus => ({
  playing: appState.ui.isPlaying,
  status: appState.ui.playModeStatus,
  playOwner: appState.ui.playOwner,
  startedAt: appState.ui.playStartedAt,
  aspect: ASPECT_NAMES[appState.ui.gameAspectRatio],
});

/** Why `run` is not `{seed?: integer, config?: {nodeId: {componentId: {…}}}}`, or null. */
const runOverridesProblem = (run: RunOverrides): string | null => {
  if (run.seed !== undefined && !Number.isInteger(run.seed)) return 'run.seed must be an integer';
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (run.config === undefined) return null;
  if (!isObject(run.config)) return 'run.config must be {"<nodeId>": {"<componentId>": {…}}}';
  for (const [nodeId, components] of Object.entries(run.config)) {
    if (!isObject(components)) return `run.config["${nodeId}"] must map component ids to config`;
    for (const [componentId, values] of Object.entries(components)) {
      if (!isObject(values)) return `run.config["${nodeId}"]["${componentId}"] must be an object`;
    }
  }
  return null;
};

/** The Game tab's presets as the bridge names them (the tab's own button labels). */
const ASPECT_NAMES: Record<GameAspectRatio, PlayAspect> = {
  free: 'free',
  '16:9-landscape': '16:9',
  '16:9-portrait': '9:16',
  '4:3': '4:3',
};

const aspectPreset = (aspect: PlayAspect): GameAspectRatio =>
  (Object.keys(ASPECT_NAMES) as GameAspectRatio[]).find(key => ASPECT_NAMES[key] === aspect) ??
  'free';

const setPaused = async (paused: boolean): Promise<BridgeResult> => {
  const refused = refuseDesignerSession();
  if (refused) return refused;
  if (!appState.ui.isPlaying) return refuse('not_playing', 'Nothing is playing.');
  if (service(GamePlaySessionService).runnerPaused === paused) return { ok: true };
  return ran(await resolveCommandDispatcher().executeById('game.pause'), 'game.pause');
};

/** The designer's play session is theirs: the agent may not stop or restart it, even with force. */
const refuseDesignerSession = (): BridgeResult | null =>
  appState.ui.isPlaying && appState.ui.playOwner === 'designer'
    ? refuse(
        'not_owner',
        'The designer started this play session; wait for them to stop it, or ask. `force` does not override this.'
      )
    : null;

const ran = (executed: boolean, action: string): BridgeResult =>
  executed ? { ok: true } : refuse('refused', `The editor refused "${action}" (see pix3_errors).`);

const play = {
  async start(scenePath?: string): Promise<BridgeResult> {
    if (appState.ui.isPlaying) {
      return refuse(
        'already_playing',
        `Play is running (owner: ${appState.ui.playOwner ?? 'unknown'}).`
      );
    }
    const dispatcher = resolveCommandDispatcher();
    const executed = scenePath
      ? await dispatcher.execute(new StartSceneGameCommand({ scenePath }))
      : await dispatcher.executeById('game.start');
    if (executed && appState.ui.isPlaying) {
      appState.ui.playOwner = 'agent';
      service(AgentKeepaliveService).notePlayStartedByAgent();
    }
    return ran(executed, 'game.start');
  },
  async stop(): Promise<BridgeResult> {
    const refused = refuseDesignerSession();
    if (refused) return refused;
    if (!appState.ui.isPlaying) return refuse('not_playing', 'Nothing is playing.');
    return ran(await resolveCommandDispatcher().executeById('game.stop'), 'game.stop');
  },
  /**
   * Plan §B.3: stop → apply the file changes held for play → start (just start when stopped). The editor's own
   * `game.restart` restarts the runtime in place and keeps the hold, so the version an agent
   * wrote during play would still be waiting after it; this one goes through a real stop.
   */
  async restart(): Promise<BridgeResult> {
    const refused = refuseDesignerSession();
    if (refused) return refused;
    // Nothing playing: a restart is a start. The kit's loop is sync → restart → game_run, and a
    // not_playing refusal after a stop broke it on the first iteration (core-tests/game10).
    if (!appState.ui.isPlaying) return play.start();
    const dispatcher = resolveCommandDispatcher();
    const stopped = await dispatcher.executeById('game.stop');
    if (!stopped) return ran(false, 'game.stop');
    // Script roots re-imported during play (a sync's, or a `pix3:scripts` frame's) register now,
    // before the held scene versions reload — their parked `user:*` components resolve against the
    // new registry — and before the start builds the game from it. Explicit, not left to the valtio
    // subscription that also does it: that one fires asynchronously, after this start could.
    const scripts = service(ProjectScriptLoaderService);
    if (scripts.applyQueuedRoots()) await scripts.componentsSettled();
    // Held external versions are re-read and delivered once play is off; the reloads they
    // trigger complete before `whenSettled` resolves. Bounded: an unreadable file settles too.
    await Promise.race([
      service(ExternalChangeService).whenSettled(),
      new Promise(resolve => setTimeout(resolve, RESTART_SETTLE_MS)),
    ]);
    return play.start();
  },
  /** Pause (a no-op when already paused). `game.pause` is a toggle; the agent asks for a state. */
  async pause(): Promise<BridgeResult> {
    return setPaused(true);
  },
  /** Resume (a no-op when running) — e.g. after a `pix3_game_run` left the outcome frame paused. */
  async resume(): Promise<BridgeResult> {
    return setPaused(false);
  },
};

/**
 * Whether `/@vite/client` reached this page: the plugin's inline probe sets
 * `__PIX3_VITE_CLIENT__`; the resource timeline is the fallback for a page without it.
 */
/** A regex, so `dist/` never carries the client's path as text (`scripts/check-dist.mjs`). */
const VITE_CLIENT_PATH = /\/@vite\/client$/;

export function viteClientOnPage(): boolean {
  if ((globalThis as { __PIX3_VITE_CLIENT__?: boolean }).__PIX3_VITE_CLIENT__ === true) return true;
  if (typeof performance === 'undefined' || typeof location === 'undefined') return false;
  return performance
    .getEntriesByType('resource')
    .some(entry => VITE_CLIENT_PATH.test(new URL(entry.name, location.href).pathname));
}

// --- the executes --------------------------------------------------------------------------------

type Execute = (params: Params) => Promise<Record<string, unknown>>;

const EXECUTES: Record<string, Execute> = {
  async pix3_status() {
    const host = service(HostService);
    const activeId = appState.scenes.activeSceneId;
    return {
      ok: true,
      versions: host.info.versions,
      project: appState.project.projectName,
      activeScene: activeId ? (appState.scenes.descriptors[activeId]?.filePath ?? null) : null,
      openScenes: Object.values(appState.scenes.descriptors).map(d => d.filePath),
      scriptsStatus: appState.project.scriptsStatus,
      writer: appState.project.host.writer,
      connection: appState.project.host.connection,
      // Scenes with edits not on disk yet (plan §C.1 "грязно"); a flush in flight still counts.
      dirty: Object.values(appState.scenes.descriptors)
        .filter(descriptor => descriptor.isDirty)
        .map(descriptor => descriptor.filePath),
      pending: pendingKeys(),
      flushing: service(FlushService).isFlushing(),
      // A viewport drag is mid-edit: nothing is written until it ends (plan §C.1).
      gestureInProgress: appState.ui.gestureInProgress,
      // Paths whose external version is seen but not applied yet (settling, unreadable, play).
      pendingExternal: service(SceneBaselineService).getPendingExternalPaths(),
      play: playStatus(),
      selection: selection(),
      errorCount: errors().length,
      keepalive: service(AgentKeepaliveService).isKeepAlive(),
      // Contract B (plan §B.2): Vite's HMR client must never be on this page.
      viteClient: viteClientOnPage(),
    };
  },

  async pix3_sync(params) {
    const reply = await service(HostService).host.sync.run({
      expect: params.expect as Record<string, string> | undefined,
      timeoutMs: params.timeoutMs as number | undefined,
    });
    return reply as Record<string, unknown>;
  },

  async pix3_scene(params) {
    const found = graphOf(params.path as string | undefined);
    if (!found) {
      return refuse(
        'no_scene',
        params.path ? `"${params.path}" is not open in the editor.` : 'No active scene.'
      );
    }
    const path = found.descriptor.filePath;
    if (typeof params.nodeId === 'string') return { ...nodeRead(found, params.nodeId), path };
    if (typeof params.find === 'string') {
      return { ok: true, path, matches: findNodes(found.graph, params.find) };
    }
    const maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 3;
    return { ok: true, path, scene: sceneTree(found, maxDepth), selection: selection() };
  },

  async pix3_play(params) {
    const action = params.action as 'start' | 'stop' | 'restart' | 'pause' | 'resume' | 'status';
    // The Game tab's frame first, so a start already runs at it (any action takes it, `status` too).
    if (typeof params.aspect === 'string') {
      await service(GamePlaySessionService).setAspectRatio(
        aspectPreset(params.aspect as PlayAspect)
      );
    }
    // A test run's seed and component config: armed for this start / restart and the session's
    // in-place restarts, cleared when play stops (core-tests/game10).
    if (action === 'start' || action === 'restart') {
      const run = params.run as RunOverrides | undefined;
      if (run !== undefined) {
        const problem = runOverridesProblem(run);
        if (problem) return refuse('invalid_params', problem);
      }
      service(GamePlaySessionService).setRunOverrides(run ?? null);
    }
    if (action === 'status') return { ok: true, ...playStatus() };
    const result =
      action === 'start'
        ? await play.start(params.scenePath as string | undefined)
        : await play[action]();
    return { ...result, ...playStatus() };
  },

  async pix3_game_run(params) {
    if (!appState.ui.isPlaying) {
      return refuse('not_playing', 'Start play first: pix3_play {action:"start"}.');
    }
    // The tool payload is raw model JSON: parse it (defaults included — a `bot` without
    // `channel` is `physical-input`, a monkey/control spec is normalised) before running. Passing it
    // straight to `run` left `bot.channel` undefined, and every bot action read as direct-action.
    const parsed = GameTestService.parseSpec(params);
    if ('error' in parsed) return refuse('invalid_spec', parsed.error);
    const result = await service(GameTestService).run(parsed.spec);
    return result.ok
      ? (result as unknown as Record<string, unknown>)
      : refuse('refused', result.error ?? 'game run did not start');
  },

  async pix3_screenshot(params) {
    const target = params.target as 'game' | 'viewport';
    if (target === 'game') {
      if (!appState.ui.isPlaying) {
        return refuse(
          'not_playing',
          'Nothing is playing; start play first, or screenshot the viewport.'
        );
      }
      await openGameSurface(ServiceContainer.getInstance());
    } else {
      const descriptor = descriptorFor(undefined);
      if (!descriptor) return refuse('no_scene', 'No active scene.');
      await service(EditorTabService).focusOrOpenScene(descriptor.filePath);
      service(ViewportRendererService).requestRender();
    }
    return { ok: true, target, next: 'take_screenshot' };
  },

  async pix3_errors(params) {
    const list = errors(typeof params.since === 'number' ? params.since : undefined);
    if (params.clear === true) clearErrors();
    return { ok: true, count: list.length, errors: list };
  },
};

const SPECS = new Map(BRIDGE_TOOLS.map(tool => [tool.name, tool]));

/** One call of the bridge, whichever transport asked: validate, keep alive, never throw. */
export async function callBridgeTool(
  name: string,
  params: unknown = {}
): Promise<Record<string, unknown>> {
  const spec = SPECS.get(name);
  const execute = EXECUTES[name];
  if (!spec || !execute) {
    return refuse(
      'unknown_tool',
      `No tool "${name}"; the tools are ${[...SPECS.keys()].join(', ')}.`
    );
  }
  const problem = validateParams(spec.inputSchema, params ?? {});
  if (problem) return refuse('invalid_params', problem);
  return asAgentCall(async () => {
    try {
      return await execute((params ?? {}) as Params);
    } catch (error) {
      return refuse('error', error instanceof Error ? error.message : String(error));
    }
  });
}

// --- the two transports --------------------------------------------------------------------------

interface ThirdPartyTool extends BridgeToolSpec {
  execute(params: Params): Promise<unknown>;
}

interface ToolDiscoveryEvent extends Event {
  respondWith(group: { name: string; description?: string; tools: ThirdPartyTool[] }): void;
}

/** The group the tab answers `devtoolstooldiscovery` with. */
export function thirdPartyToolGroup(): {
  name: string;
  description: string;
  tools: ThirdPartyTool[];
} {
  return {
    name: BRIDGE_GROUP_NAME,
    description: BRIDGE_GROUP_DESCRIPTION,
    tools: BRIDGE_TOOLS.map(spec => ({
      ...spec,
      execute: params => callBridgeTool(spec.name, params),
    })),
  };
}

let discoveryListener: ((event: Event) => void) | null = null;

/**
 * Register the group with chrome-devtools-mcp (plan §D.1): it looks for a `devtoolstooldiscovery`
 * listener on `window` (`DOMDebugger.getEventListeners`), dispatches the event and keeps what
 * `respondWith` gets under `window.__dtmcp.toolGroups`. Re-asked after every page load.
 */
export function registerThirdPartyTools(): void {
  if (discoveryListener) return;
  discoveryListener = event => {
    (event as ToolDiscoveryEvent).respondWith(thirdPartyToolGroup());
  };
  window.addEventListener('devtoolstooldiscovery', discoveryListener);
}

const asResult = (answer: Record<string, unknown>): BridgeResult =>
  answer as unknown as BridgeResult;

export function createDebugBridge(): Pix3DebugBridge {
  return {
    version: 2,
    tools: () => BRIDGE_TOOLS.map(tool => ({ ...tool })),
    call: (name, params = {}) => callBridgeTool(name, params),
    help() {
      const out: Record<string, string> = {
        'call(name, params)':
          'Any tool by name — the same tools, params and answers as execute_3p_developer_tool.',
        'status() / sync({expect?, timeoutMs?}) / scene(maxDepth) / node(id) / find(text) / screen(id) / pending() / selection() / play.* / errors() / clearErrors()':
          'Short forms over call(): status → pix3_status, sync → pix3_sync, scene/node/find/screen → pix3_scene, play.start/stop/restart/pause/resume/status → pix3_play, errors → pix3_errors.',
      };
      for (const tool of BRIDGE_TOOLS) out[tool.name] = tool.description;
      return out;
    },
    status: () => callBridgeTool('pix3_status'),
    sync: options => callBridgeTool('pix3_sync', options ?? {}) as Promise<HookReply>,
    async scene(maxDepth = 3) {
      const answer = await callBridgeTool('pix3_scene', { maxDepth });
      return (answer.scene as (NodeDTO & { sceneVersion: string }) | undefined) ?? null;
    },
    async node(nodeId) {
      const answer = await callBridgeTool('pix3_scene', { nodeId });
      if (!answer.ok) return null;
      return { ...(answer.node as NodeDTO), saved: answer.saved as SceneNodeDefinition | null };
    },
    async find(text) {
      const answer = await callBridgeTool('pix3_scene', { find: text });
      return (answer.matches as NodeSummary[] | undefined) ?? [];
    },
    async screen(nodeId) {
      const answer = await callBridgeTool('pix3_scene', { nodeId });
      return (answer.screen as { x: number; y: number } | null | undefined) ?? null;
    },
    async pending() {
      const answer = await callBridgeTool('pix3_status');
      return (answer.pending as Record<string, string[]> | undefined) ?? {};
    },
    selection,
    errors: () => errors(),
    clearErrors: () => clearErrors(),
    play: {
      status: playStatus,
      start: async scenePath =>
        asResult(await callBridgeTool('pix3_play', { action: 'start', scenePath })),
      stop: async (options = {}) =>
        asResult(await callBridgeTool('pix3_play', { action: 'stop', force: options.force })),
      restart: async () => asResult(await callBridgeTool('pix3_play', { action: 'restart' })),
      pause: async () => asResult(await callBridgeTool('pix3_play', { action: 'pause' })),
      resume: async () => asResult(await callBridgeTool('pix3_play', { action: 'resume' })),
    },
  };
}

interface WindowWithDebug extends Window {
  __PIX3_DEBUG__?: Pix3DebugBridge;
}

/** Install the bridge: `window.__PIX3_DEBUG__` and the 3p tool group. Idempotent. */
export function installDebugBridge(): Pix3DebugBridge {
  const target = window as unknown as WindowWithDebug;
  if (target.__PIX3_DEBUG__) return target.__PIX3_DEBUG__;
  installErrorCapture();
  const bridge = createDebugBridge();
  target.__PIX3_DEBUG__ = bridge;
  registerThirdPartyTools();
  return bridge;
}
