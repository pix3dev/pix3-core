import type { SavedSceneDocument } from '@pix3/runtime';
import {
  deepEqual,
  diffScenes,
  indexNodes,
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
 * - structural deltas (a node added / removed / moved) → dropped against any E (N5).
 */

export type DropReason = 'same-key' | 'node-gone' | 'structural';

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
