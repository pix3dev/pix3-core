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
import { AgentKeepaliveService } from '@/services/core/AgentKeepaliveService';
import { resolveCommandDispatcher } from '@/services/core/CommandDispatcher';
import { FlushService } from '@/services/project/FlushService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { diffScenes, indexNodes, leafKey } from '@/core/scene-patch/scene-diff';
import { editorNormOfGraph, normOfGraph } from '@/core/scene-patch/scene-norm';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { appState } from '@/state';

import type { HookReply } from './EditorHost';
import { HostService } from './HostService';

/**
 * `window.__PIX3_DEBUG__` v1 (plan §D.1): what an agent reads and drives in the open editor tab
 * through Chrome DevTools MCP. Scenes change through FILES, never through this bridge — there is no
 * `setProperty`/`command` here. Every refusal says why: `{ok:false, reason, detail}`.
 *
 * The 3p tool registration (`devtoolstooldiscovery`) arrives with the bridge work item; until then
 * `registerThirdPartyTools` is the seam and the same object is reachable by `evaluate_script`.
 */

export type BridgeResult<T extends object = object> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

export interface Pix3DebugBridge {
  readonly version: 1;
  help(): Record<string, string>;
  status(): Record<string, unknown>;
  scene(maxDepth?: number): (NodeDTO & { sceneVersion: string }) | null;
  node(nodeId: string): (NodeDTO & { saved: SceneNodeDefinition | null }) | null;
  /**
   * Edits of open scenes not on disk yet, per scene path: the keys a flush would write (plan
   * §C.1 `pending = diff(baseline, graph)`). Empty object = everything is on disk.
   */
  pending(): Record<string, string[]>;
  /** A node's origin on the page in CSS px (to click or drag it), or null when not in view. */
  screen(nodeId: string): { x: number; y: number } | null;
  find(text: string): NodeSummary[];
  selection(): { nodeIds: string[]; primaryNodeId: string | null };
  errors(): CapturedError[];
  clearErrors(): void;
  /** Flush editor edits → rescan → barrier (plan §B.3). Not ok is not a barrier: retry. */
  sync(options?: { expect?: Record<string, string>; timeoutMs?: number }): Promise<HookReply>;
  readonly play: {
    status(): {
      playing: boolean;
      status: string;
      playOwner: string | null;
      startedAt: number | null;
    };
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

const activeGraph = () => service(SceneManager).getActiveSceneGraph();

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

/** The designer's play session is theirs: the agent may not stop or restart it, even with force. */
const refuseDesignerSession = (): BridgeResult | null =>
  appState.ui.isPlaying && appState.ui.playOwner === 'designer'
    ? {
        ok: false,
        reason: 'not_owner',
        detail: 'The designer started this play session; wait for them to stop it, or ask.',
      }
    : null;

const ran = (executed: boolean, action: string): BridgeResult =>
  executed
    ? { ok: true }
    : { ok: false, reason: 'refused', detail: `The editor refused "${action}" (see errors()).` };

export function createDebugBridge(): Pix3DebugBridge {
  return {
    version: 1,

    help() {
      return {
        'status()':
          'Versions, project, active scene, script status, writer, connection, dirty scenes, flushing, gestureInProgress, pendingExternal, error count.',
        'sync({expect?, timeoutMs?})':
          'Write the editor’s edits, rescan, and wait until the editor runs the files on disk. ' +
          'Not ok is not a barrier: on gesture_in_progress / stale_modules retry; on ' +
          'expect_mismatch re-read; on stale follow `playing`.',
        'scene(maxDepth=3) / node(id) / find(text) / selection()':
          'Read the active scene; node(id).saved is the node as the scene file gets it.',
        'screen(id)':
          'A node’s origin on the page (CSS px) to click or drag it; null when not in view.',
        'pending()':
          'Unsaved edits per scene path (the keys the next write carries); {} = all on disk.',
        'play.status() / start(scenePath?) / stop() / restart() / pause()':
          'Play mode. The agent may stop or restart only a session it started.',
        'errors() / clearErrors()': 'Captured console / runtime errors.',
      };
    },

    status() {
      const host = service(HostService);
      const activeId = appState.scenes.activeSceneId;
      return {
        versions: host.info.versions,
        project: appState.project.projectName,
        activeScene: activeId ? (appState.scenes.descriptors[activeId]?.filePath ?? null) : null,
        scriptsStatus: appState.project.scriptsStatus,
        writer: appState.project.host.writer,
        connection: appState.project.host.connection,
        // Scenes with edits not on disk yet (plan §C.1 "грязно"); a flush in flight still counts.
        dirty: Object.values(appState.scenes.descriptors)
          .filter(descriptor => descriptor.isDirty)
          .map(descriptor => descriptor.filePath),
        flushing: service(FlushService).isFlushing(),
        // A viewport drag is mid-edit: nothing is written until it ends (plan §C.1).
        gestureInProgress: appState.ui.gestureInProgress,
        // Paths whose external version is seen but not applied yet (settling, unreadable, play).
        pendingExternal: service(SceneBaselineService).getPendingExternalPaths(),
        errorCount: errors().length,
      };
    },

    scene(maxDepth = 3) {
      const graph = activeGraph();
      if (!graph) return null;
      const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
      const tree: NodeDTO = {
        nodeId: '<scene-root>',
        type: 'SceneRoot',
        name: graph.description ?? 'Scene',
        visible: true,
        transform: { position: null, rotation: null, scale: null },
        groups: [],
        componentCount: 0,
        properties: null,
        children: roots.map(root => nodeToDTO(root, maxDepth - 1)),
      };
      return { ...tree, sceneVersion: graph.version };
    },

    node(nodeId) {
      const graph = activeGraph();
      const node = graph?.nodeMap.get(nodeId);
      if (!graph || !(node instanceof NodeBase)) return null;
      const dto = nodeToDTO(node, 0);
      dto.components = node.components.map((c, i) => componentToDTO(c, i));
      // What the scene file gets for this node — `properties` above is the loaded YAML bag, which
      // does not show sizes a texture set or values only the node's fields hold.
      const descriptorPath =
        appState.scenes.descriptors[appState.scenes.activeSceneId ?? '']?.filePath;
      const baseline = descriptorPath ? service(SceneBaselineService).get(descriptorPath) : null;
      const norm = baseline ? editorNormOfGraph(graph, baseline.norm) : normOfGraph(graph);
      const saved = indexNodes(norm).get(nodeId)?.def ?? null;
      return { ...dto, saved };
    },

    screen(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return null;
      return service(ViewportRendererService).projectNodeToClient(node);
    },

    pending() {
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
    },

    find(text) {
      const graph = activeGraph();
      if (!graph) return [];
      const needle = text.toLowerCase();
      const matches: NodeSummary[] = [];
      for (const node of graph.nodeMap.values()) {
        if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
          matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
        }
      }
      return matches;
    },

    selection() {
      return {
        nodeIds: [...appState.selection.nodeIds],
        primaryNodeId: appState.selection.primaryNodeId,
      };
    },

    errors: () => errors(),
    clearErrors: () => clearErrors(),

    sync(options = {}) {
      return asAgentCall(() => service(HostService).host.sync.run(options));
    },

    play: {
      status() {
        return {
          playing: appState.ui.isPlaying,
          status: appState.ui.playModeStatus,
          playOwner: appState.ui.playOwner,
          startedAt: appState.ui.playStartedAt,
        };
      },
      start(scenePath) {
        return asAgentCall(async () => {
          if (appState.ui.isPlaying) {
            return {
              ok: false,
              reason: 'already_playing',
              detail: `Play is running (owner: ${appState.ui.playOwner ?? 'unknown'}).`,
            };
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
        });
      },
      stop(options = {}) {
        return asAgentCall(async () => {
          void options.force; // force never overrides a designer session (plan §B.3)
          const refused = refuseDesignerSession();
          if (refused) return refused;
          return ran(await resolveCommandDispatcher().executeById('game.stop'), 'game.stop');
        });
      },
      restart() {
        return asAgentCall(async () => {
          const refused = refuseDesignerSession();
          if (refused) return refused;
          const executed = await resolveCommandDispatcher().executeById('game.restart');
          if (executed && appState.ui.isPlaying) appState.ui.playOwner = 'agent';
          return ran(executed, 'game.restart');
        });
      },
      pause() {
        return asAgentCall(async () => {
          const refused = refuseDesignerSession();
          if (refused) return refused;
          return ran(await resolveCommandDispatcher().executeById('game.pause'), 'game.pause');
        });
      },
    },
  };
}

interface WindowWithDebug extends Window {
  __PIX3_DEBUG__?: Pix3DebugBridge;
}

/** Seam for the 3p tools of chrome-devtools-mcp (plan §D.1, bridge work item). */
export function registerThirdPartyTools(_bridge: Pix3DebugBridge): void {
  // Registered by the bridge work item (`devtoolstooldiscovery`).
}

/** Install the bridge on `window.__PIX3_DEBUG__`. Idempotent. */
export function installDebugBridge(): Pix3DebugBridge {
  const target = window as unknown as WindowWithDebug;
  if (target.__PIX3_DEBUG__) return target.__PIX3_DEBUG__;
  installErrorCapture();
  const bridge = createDebugBridge();
  target.__PIX3_DEBUG__ = bridge;
  registerThirdPartyTools(bridge);
  return bridge;
}
