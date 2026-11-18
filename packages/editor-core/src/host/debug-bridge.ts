import { NodeBase, SceneManager, type SceneNodeDefinition } from '@pix3/runtime';

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
import { AgentKeepaliveService } from '@/services/core/AgentKeepaliveService';
import { PlayPageLink } from '@/services/play/PlayPageLink';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { FlushService } from '@/services/project/FlushService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { diffScenes, indexNodes, leafKey } from '@/core/scene-patch/scene-diff';
import { normOfGraph } from '@/core/scene-patch/scene-norm';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { appState } from '@/state';

import {
  BRIDGE_GROUP_DESCRIPTION,
  BRIDGE_GROUP_NAME,
  BRIDGE_TOOLS,
  validateParams,
  type BridgeToolSpec,
} from './bridge-tools';
import {
  pageErrors,
  pageGameRun,
  pageLiveSource,
  pagePlay,
  pagePlayStatus,
  PageRefusal,
  pageScreenshot,
  type LiveSource,
} from './bridge-play-page';
import { bake, hideModelSheet, renderModel } from './bridge-model';
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
  /** `pix3_play` on your own game page (plan play-in-page D7). */
  readonly play: {
    status(): Promise<Record<string, unknown>>;
    start(scenePath?: string): Promise<BridgeResult>;
    stop(): Promise<BridgeResult>;
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

const nodeRead = async (
  found: NonNullable<ReturnType<typeof graphOf>>,
  nodeId: string,
  live: LiveSource
): Promise<
  BridgeResult<{
    node: NodeDTO;
    saved: SceneNodeDefinition | null;
    screen: { x: number; y: number } | null;
    live?: { components: ComponentDTO[] };
    runtimeOnly?: true;
  }>
> => {
  const { graph, descriptor } = found;
  const node = graph.nodeMap.get(nodeId);
  const active = descriptor.id === appState.scenes.activeSceneId;
  if (!(node instanceof NodeBase)) {
    // A node a script made during play (a gem, a bullet) or one of the scene `changeScene` went to
    // is only in the running game: answer it from there, by id or by name (core-tests/game7, where
    // every gem was spawned and `--node gem-1` read not_found).
    const spawned = active ? await live.node(nodeId, true) : null;
    if (!spawned)
      return refuse('not_found', `No node "${nodeId}" in the scene or the running game.`);
    return {
      ok: true,
      node: spawned.dto,
      saved: null,
      screen: spawned.screen,
      live: { components: spawned.components },
      runtimeOnly: true,
      ...(spawned.page ? { page: spawned.page } : {}),
    };
  }
  const savedNodes = savedNodesOf(found);
  const dto = nodeToDTO(node, 0, savedPropertiesOf(savedNodes));
  dto.components = node.components.map((c, i) => componentToDTO(c, i));
  const saved = savedNodes.get(nodeId)?.def ?? null;
  const running = active ? await live.node(nodeId, false) : null;
  // While the game runs, `screen` is where the RUNNING node is on the game's canvas (the Game
  // tab, or the game page `page` names), and `live` its components' play-time state (`node` stays
  // what the editor holds — the scene as authored).
  const screen = running
    ? running.screen
    : active
      ? service(ViewportRendererService).projectNodeToClient(node)
      : null;
  return {
    ok: true,
    node: dto,
    saved,
    screen,
    ...(running ? { live: { components: running.components } } : {}),
    ...(running?.page ? { page: running.page } : {}),
  };
};

/**
 * Nodes whose name or type contains `text`: the editor's scene, then — while the game runs — the
 * nodes only the running game has (`runtimeOnly: true`: spawned by a script, or in a scene the
 * game changed to).
 */
const findNodes = async (
  graph: NonNullable<ReturnType<typeof graphOf>>['graph'],
  text: string,
  live: LiveSource
): Promise<Array<NodeSummary & { runtimeOnly?: true }>> => {
  const needle = text.toLowerCase();
  const matches: Array<NodeSummary & { runtimeOnly?: true }> = [];
  for (const node of graph.nodeMap.values()) {
    if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
      matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
    }
  }
  for (const found of await live.find(text)) {
    if (!graph.nodeMap.has(found.nodeId)) matches.push({ ...found, runtimeOnly: true });
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
      // Paths whose external version is seen but not applied yet (settling, unreadable).
      pendingExternal: service(SceneBaselineService).getPendingExternalPaths(),
      play: await pagePlayStatus(),
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
    // The readiness barrier of the game pages (D6): a page older than this is stale.
    if (typeof reply.rev === 'number') service(PlayPageLink).noteSync(reply.rev);
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
    const live = pageLiveSource(params.page);
    if (typeof params.nodeId === 'string') {
      return { ...(await nodeRead(found, params.nodeId, live)), path };
    }
    if (typeof params.find === 'string') {
      return { ok: true, path, matches: await findNodes(found.graph, params.find, live) };
    }
    const maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 3;
    return { ok: true, path, scene: sceneTree(found, maxDepth), selection: selection() };
  },

  async pix3_render_model(params) {
    const found = graphOf(undefined);
    if (!found) return refuse('no_scene', 'No active scene.');
    return renderModel(found.graph, service(ViewportRendererService), params);
  },

  async pix3_bake(params) {
    const found = graphOf(undefined);
    if (!found) return refuse('no_scene', 'No active scene.');
    return bake(found.graph, service(ViewportRendererService), params);
  },

  pix3_play: pagePlay,
  pix3_game_run: pageGameRun,

  async pix3_screenshot(params) {
    if (params.target === 'game') return pageScreenshot(params);
    const descriptor = descriptorFor(undefined);
    if (!descriptor) return refuse('no_scene', 'No active scene.');
    await service(EditorTabService).focusOrOpenScene(descriptor.filePath);
    service(ViewportRendererService).requestRender();
    return { ok: true, target: 'viewport', next: 'take_screenshot' };
  },

  async pix3_errors(params) {
    return pageErrors(params);
  },
};

/** One call of the bridge, whichever transport asked: validate, keep alive, never throw. */
export async function callBridgeTool(
  name: string,
  params: unknown = {}
): Promise<Record<string, unknown>> {
  const spec = BRIDGE_TOOLS.find(tool => tool.name === name);
  const execute = EXECUTES[name];
  if (!spec || !execute) {
    return refuse(
      'unknown_tool',
      `No tool "${name}"; the tools are ${BRIDGE_TOOLS.map(tool => tool.name).join(', ')}.`
    );
  }
  const problem = validateParams(spec.inputSchema, params ?? {});
  if (problem) return refuse('invalid_params', problem);
  // A model sheet left over the editor by pix3_render_model goes with the next call.
  hideModelSheet();
  return asAgentCall(async () => {
    try {
      return await execute((params ?? {}) as Params);
    } catch (error) {
      if (error instanceof PageRefusal) return error.answer;
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
      status: () => callBridgeTool('pix3_play', { action: 'status' }),
      start: async scenePath =>
        asResult(await callBridgeTool('pix3_play', { action: 'start', scenePath })),
      stop: async () => asResult(await callBridgeTool('pix3_play', { action: 'stop' })),
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
