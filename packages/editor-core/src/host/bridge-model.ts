import {
  MERGED_MESH_FLAG,
  Node3D,
  NodeBase,
  mergeStatic,
  mergeStaticOptionsOf,
  measureLook,
  parseModelViews,
  unmergeStatic,
  type SceneGraph,
} from '@pix3/runtime';

import type { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/**
 * The model tools of the agent bridge: `pix3_render_model` (a node of the open scene drawn from
 * several sides, with what it costs to draw) and `pix3_bake` (`core:MergeStatic`'s merge and bake
 * shown in the viewport). Both work on the editor's scene as it is, unsaved edits included, and
 * write nothing: a bake lives in the viewport until it is cleared or the scene reloads.
 */

type Answer = Record<string, unknown>;

const MERGE_STATIC = 'core:MergeStatic';

const componentsOf = (node: NodeBase) =>
  (node as { components?: readonly { type?: string; config?: Record<string, unknown> }[] })
    .components ?? [];

const nodesOf = (graph: SceneGraph): NodeBase[] =>
  [...graph.nodeMap.values()].filter((n): n is NodeBase => n instanceof NodeBase);

/** Whether `mergeStatic` has merged meshes under `node` now. */
const isBaked = (node: NodeBase): boolean =>
  node.children.some(child => child.userData[MERGED_MESH_FLAG] === true);

const mergeSummary = (node: NodeBase) => {
  let vertices = 0;
  let meshes = 0;
  for (const child of node.children) {
    if (child.userData[MERGED_MESH_FLAG] !== true) continue;
    meshes += 1;
    vertices +=
      (
        child as { geometry?: { getAttribute(n: string): { count: number } | undefined } }
      ).geometry?.getAttribute('position')?.count ?? 0;
  }
  return { nodeId: node.nodeId, name: node.name, meshes, vertices };
};

// --- the sheet overlay ---------------------------------------------------------------------------

const OVERLAY_ID = 'pix3-model-sheet';

/** Remove the sheet `pix3_render_model` laid over the editor (every bridge call does it first). */
export function hideModelSheet(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/** Lay the sheet over the whole editor tab, so a page screenshot shows it; a click removes it. */
function showModelSheet(dataUrl: string): void {
  hideModelSheet();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#1b1d22;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer';
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = 'Model sheet';
  image.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
  overlay.appendChild(image);
  overlay.addEventListener('click', hideModelSheet);
  document.body.appendChild(overlay);
}

// --- pix3_render_model ---------------------------------------------------------------------------

export function renderModel(
  graph: SceneGraph,
  viewport: ViewportRendererService,
  params: Answer
): Answer {
  const views = parseModelViews(
    typeof params.views === 'string' ? params.views : 'iso,front,right,top'
  );
  if ('error' in views) return { ok: false, reason: 'invalid_params', detail: views.error };
  let targets: NodeBase[];
  if (typeof params.nodeId === 'string') {
    const node = graph.nodeMap.get(params.nodeId);
    if (!(node instanceof NodeBase)) {
      return {
        ok: false,
        reason: 'not_found',
        detail: `No node "${params.nodeId}" in the active scene (pix3_scene {find} gives ids).`,
      };
    }
    targets = [node];
  } else {
    targets = graph.rootNodes.filter((n): n is NodeBase => n instanceof Node3D);
  }
  const image = params.image === true;
  let drawn;
  try {
    drawn = viewport.renderModelSheet(targets, {
      views,
      size: typeof params.size === 'number' ? params.size : 384,
      lights: (params.lights as 'auto' | 'studio' | 'scene' | undefined) ?? 'auto',
      background: typeof params.background === 'string' ? params.background : '#8f9aa6',
      capture: true,
    });
  } catch (error) {
    return { ok: false, reason: 'refused', detail: (error as Error).message };
  }
  if (!drawn) return { ok: false, reason: 'refused', detail: 'The viewport is not initialized.' };
  const dataUrl = drawn.sheet.toDataURL('image/png');
  const baked = nodesOf(graph)
    .filter(node => isBaked(node) && targets.some(t => t === node || isAncestor(t, node)))
    .map(mergeSummary);
  const answer: Answer = {
    ok: true,
    nodeId: params.nodeId ?? null,
    views: views.map(v => v.name),
    ...drawn.info,
    look: measureLook(drawn.captures),
    baked,
    sheet: { width: drawn.sheet.width, height: drawn.sheet.height },
  };
  if (image) answer.image = dataUrl;
  else {
    showModelSheet(dataUrl);
    answer.next =
      'take_screenshot (the sheet covers the editor until your next pix3_* call or a click)';
  }
  return answer;
}

const isAncestor = (ancestor: NodeBase, node: NodeBase): boolean => {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
};

// --- pix3_bake -----------------------------------------------------------------------------------

export function bake(graph: SceneGraph, viewport: ViewportRendererService, params: Answer): Answer {
  const action = (params.action as 'apply' | 'clear' | 'status' | undefined) ?? 'apply';
  let targets: NodeBase[];
  if (typeof params.nodeId === 'string') {
    const node = graph.nodeMap.get(params.nodeId);
    if (!(node instanceof NodeBase)) {
      return {
        ok: false,
        reason: 'not_found',
        detail: `No node "${params.nodeId}" in the active scene.`,
      };
    }
    targets = [node];
  } else {
    const all = nodesOf(graph);
    targets =
      action === 'apply'
        ? all.filter(node => componentsOf(node).some(c => c.type === MERGE_STATIC))
        : all.filter(isBaked);
  }
  if (action === 'status') {
    return { ok: true, action, baked: targets.filter(isBaked).map(mergeSummary) };
  }
  if (action === 'apply' && targets.length === 0) {
    return {
      ok: false,
      reason: 'not_found',
      detail: `No node in the active scene carries ${MERGE_STATIC}; pass nodeId to bake one anyway.`,
    };
  }
  const nodes: Answer[] = [];
  for (const node of targets) {
    unmergeStatic(node);
    if (action === 'clear') {
      nodes.push({ nodeId: node.nodeId, name: node.name, cleared: true });
      continue;
    }
    const config = componentsOf(node).find(c => c.type === MERGE_STATIC)?.config ?? {};
    // No cache in the editor: the model changes between bakes under the same key.
    const result = mergeStatic(node, { ...mergeStaticOptionsOf(config), cacheKey: undefined });
    nodes.push({
      nodeId: node.nodeId,
      name: node.name,
      merged: result.merged,
      meshes: result.meshes.length,
      vertices: result.vertices,
      ms: Math.round(result.ms),
      bake: config.bake !== false,
    });
  }
  viewport.requestRender();
  return { ok: true, action, nodes };
}
