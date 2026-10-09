import { NodeBase, SceneManager, type SceneNodeDefinition } from '@pix3/runtime';

import {
  clearErrors,
  componentToDTO,
  errors,
  installErrorCapture,
  nodeToDTO,
  type CapturedError,
  type NodeDTO,
  type NodeSummary,
} from '@/core/agent-introspection';
import { ServiceContainer } from '@/fw/di';
import { StartSceneGameCommand } from '@/features/scripts/StartSceneGameCommand';
import { openGameSurface } from '@/features/scripts/play-workspace';
import { AgentKeepaliveService } from '@/services/core/AgentKeepaliveService';
import { resolveCommandDispatcher } from '@/services/core/CommandDispatcher';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { GameTestService, type GameRunSpec } from '@/services/game-test/GameTestService';
import { FlushService } from '@/services/project/FlushService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { diffScenes, indexNodes, leafKey } from '@/core/scene-patch/scene-diff';
import { editorNormOfGraph, normOfGraph } from '@/core/scene-patch/scene-norm';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { appState } from '@/state';

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

export interface PlayStatus {
  playing: boolean;
  status: string;
  playOwner: string | null;
  startedAt: number | null;
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

const sceneTree = (
  graph: NonNullable<ReturnType<typeof graphOf>>['graph'],
  maxDepth: number
): NodeDTO & { sceneVersion: string } => {
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
    children: roots.map(root => nodeToDTO(root, maxDepth - 1)),
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
}> => {
  const { graph, descriptor } = found;
  const node = graph.nodeMap.get(nodeId);
  if (!(node instanceof NodeBase)) return refuse('not_found', `No node "${nodeId}" in the scene.`);
  const dto = nodeToDTO(node, 0);
  dto.components = node.components.map((c, i) => componentToDTO(c, i));
  // What the scene file gets for this node — `properties` above is the loaded YAML bag, which
  // does not show sizes a texture set or values only the node's fields hold.
  const baseline = service(SceneBaselineService).get(descriptor.filePath);
  const norm = baseline ? editorNormOfGraph(graph, baseline.norm) : normOfGraph(graph);
  const saved = indexNodes(norm).get(nodeId)?.def ?? null;
  const screen =
    descriptor.id === appState.scenes.activeSceneId
      ? service(ViewportRendererService).projectNodeToClient(node)
      : null;
  return { ok: true, node: dto, saved, screen };
};

const findNodes = (
  graph: NonNullable<ReturnType<typeof graphOf>>['graph'],
  text: string
): NodeSummary[] => {
  const needle = text.toLowerCase();
  const matches: NodeSummary[] = [];
  for (const node of graph.nodeMap.values()) {
    if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
      matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
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
    const ops = diffScenes(baseline.norm, editorNormOfGraph(graph, baseline.norm));
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
});

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
  async restart(): Promise<BridgeResult> {
    const refused = refuseDesignerSession();
    if (refused) return refused;
    const executed = await resolveCommandDispatcher().executeById('game.restart');
    if (executed && appState.ui.isPlaying) {
      appState.ui.playOwner = 'agent';
      service(AgentKeepaliveService).notePlayStartedByAgent();
    }
    return ran(executed, 'game.restart');
  },
  async pause(): Promise<BridgeResult> {
    const refused = refuseDesignerSession();
    if (refused) return refused;
    if (!appState.ui.isPlaying) return refuse('not_playing', 'Nothing is playing.');
    return ran(await resolveCommandDispatcher().executeById('game.pause'), 'game.pause');
  },
};

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
    return { ok: true, path, scene: sceneTree(found.graph, maxDepth), selection: selection() };
  },

  async pix3_play(params) {
    const action = params.action as 'start' | 'stop' | 'restart' | 'pause' | 'status';
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
    const result = await service(GameTestService).run(params as unknown as GameRunSpec);
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
          'Short forms over call(): status → pix3_status, sync → pix3_sync, scene/node/find/screen → pix3_scene, play.start/stop/restart/pause/status → pix3_play, errors → pix3_errors.',
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
