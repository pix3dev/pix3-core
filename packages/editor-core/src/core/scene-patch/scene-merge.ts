import type { SavedSceneDocument, SceneNodeDefinition } from '@pix3/runtime';
import {
  deepEqual,
  diffScenes,
  indexNodes,
  isPlainObject,
  leafKey,
  leafValues,
  type LeafOp,
  type SceneOp,
} from '@/core/scene-patch/scene-diff';

/**
 * Plan §C.3 on normalised documents: B = baseline (disk at the last load/flush), E = the external
 * version, G = the editor graph. `pending = diff(B, G)`; for each key of `pending`:
 * - E left it as in B → **accepted** (it stays the editor's, patched onto E);
 * - E already has the editor's value → nothing to do (not a conflict);
 * - E changed it too → **dropped** (the agent touched the same thing);
 * - the node is gone in E → dropped;
 * - structural deltas (a node added / removed / moved) → dropped against any E (N5);
 * - a position or size the anchor layout gave a node because its parent was resized, when that
 *   resize is dropped → dropped with it (`laid-out`): it was computed for the editor's parent
 *   size, and on top of E's it would silently change the node's margins.
 */

export type DropReason = 'same-key' | 'node-gone' | 'structural' | 'laid-out';

export interface DroppedKey {
  readonly op: SceneOp;
  /** `leafKey`, or `<kind>:<nodeId>` for a structural op. */
  readonly key: string;
  /** The node the key belongs to (null: the scene head, or a structural op's node is new). */
  readonly nodeId: string | null;
  readonly reason: DropReason;
}

export interface MergePlan {
  /** Leaf ops to patch onto E's text; they become the new `pending`. */
  readonly accepted: readonly LeafOp[];
  readonly dropped: readonly DroppedKey[];
}

export function planMerge(
  B: SavedSceneDocument,
  E: SavedSceneDocument,
  G: SavedSceneDocument
): MergePlan {
  const pending = diffScenes(B, G);
  const lb = leafValues(B);
  const le = leafValues(E);
  const lg = leafValues(G);
  const ib = indexNodes(B);
  const ie = indexNodes(E);
  const ig = indexNodes(G);
  const accepted: LeafOp[] = [];
  const dropped: DroppedKey[] = [];
  for (const op of pending) {
    if (op.kind !== 'set' && op.kind !== 'delete') {
      const nodeId = op.kind === 'addNode' ? op.def.id : op.nodeId;
      dropped.push({ op, key: `${op.kind}:${nodeId}`, nodeId, reason: 'structural' });
      continue;
    }
    const key = leafKey(op.nodeId, op.path);
    if (op.nodeId !== null && !ie.has(op.nodeId)) {
      dropped.push({ op, key, nodeId: op.nodeId, reason: 'node-gone' });
      continue;
    }
    const wholeComponents = op.path.length === 1 && op.path[0] === 'components';
    const valueIn = (
      leaves: Map<string, unknown>,
      index: ReturnType<typeof indexNodes>
    ): unknown => (wholeComponents ? index.get(op.nodeId!)?.def.components : leaves.get(key));
    const eValue = valueIn(le, ie);
    if (deepEqual(eValue, valueIn(lg, ig))) continue;
    if (deepEqual(eValue, valueIn(lb, ib))) accepted.push(op);
    else dropped.push({ op, key, nodeId: op.nodeId, reason: 'same-key' });
  }
  return dropLaidOutWithParent({ accepted, dropped }, ig);
}

const SIZE_KEYS = new Set(['width', 'height', 'size', 'radius']);
const RECT_PATHS = new Set([
  'properties.transform.position',
  'properties.width',
  'properties.height',
]);

/** `layout:` of a node definition: anchored, and how (centre on both axes = not anchored to size). */
const anchorOf = (def: SceneNodeDefinition): { sized: boolean; stretched: boolean } | null => {
  const layout = def.properties?.layout;
  if (!isPlainObject(layout) || layout.enabled !== true) return null;
  const h = layout.horizontalAlign ?? 'center';
  const v = layout.verticalAlign ?? 'center';
  return {
    sized: h !== 'center' || v !== 'center',
    stretched: h === 'stretch' || v === 'stretch',
  };
};

/**
 * The anchor layout keeps a child's margins by rewriting its rect when the parent's size changes
 * (`Node2D.applyAnchoredLayout`; the editor then takes that rect as authored). So when a parent's
 * size key is dropped, the rect keys of every descendant the resize moved or resized go too —
 * through stretched children, which pass the resize down.
 */
function dropLaidOutWithParent(plan: MergePlan, ig: ReturnType<typeof indexNodes>): MergePlan {
  const resized = new Set<string>();
  for (const d of plan.dropped) {
    const op = d.op;
    if ((op.kind === 'set' || op.kind === 'delete') && op.nodeId !== null) {
      const [first, second] = op.path;
      if (
        op.path.length === 2 &&
        first === 'properties' &&
        typeof second === 'string' &&
        SIZE_KEYS.has(second)
      ) {
        resized.add(op.nodeId);
      }
    }
  }
  if (resized.size === 0) return plan;
  const children = new Map<string, string[]>();
  for (const [id, entry] of ig) {
    if (entry.parentId === null) continue;
    children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), id]);
  }
  const laidOut = new Set<string>();
  const walk = (parentId: string): void => {
    for (const childId of children.get(parentId) ?? []) {
      const anchor = anchorOf(ig.get(childId)!.def);
      if (!anchor?.sized || laidOut.has(childId)) continue;
      laidOut.add(childId);
      if (anchor.stretched) walk(childId);
    }
  };
  for (const id of resized) walk(id);
  if (laidOut.size === 0) return plan;
  const accepted: LeafOp[] = [];
  const dropped = [...plan.dropped];
  for (const op of plan.accepted) {
    const path = op.path.map(s => (typeof s === 'string' ? s : `[${s.id}]`)).join('.');
    if (op.nodeId !== null && laidOut.has(op.nodeId) && RECT_PATHS.has(path)) {
      dropped.push({ op, key: leafKey(op.nodeId, op.path), nodeId: op.nodeId, reason: 'laid-out' });
    } else {
      accepted.push(op);
    }
  }
  return { accepted, dropped };
}

/**
 * "Затирание по устаревшему чтению" (§C.3): keys the last flush changed (`before` → `after`) that
 * the external version E puts back to their pre-flush value — an agent wrote a file it read before
 * that flush. Only the last flush is caught (a known regression against 1.x's protected set).
 */
export function findClobberedKeys(
  before: SavedSceneDocument,
  after: SavedSceneDocument,
  E: SavedSceneDocument
): LeafOp[] {
  const lb = leafValues(before);
  const le = leafValues(E);
  const ie = indexNodes(E);
  const clobbered: LeafOp[] = [];
  for (const op of diffScenes(before, after)) {
    if (op.kind !== 'set' && op.kind !== 'delete') continue;
    const key = leafKey(op.nodeId, op.path);
    const eValue = le.get(key);
    if (op.nodeId !== null && !ie.has(op.nodeId)) continue;
    if (
      deepEqual(eValue, lb.get(key)) &&
      !deepEqual(eValue, op.kind === 'set' ? op.value : undefined)
    ) {
      clobbered.push(op);
    }
  }
  return clobbered;
}
