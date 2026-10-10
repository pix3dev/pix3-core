import type { SavedSceneDocument } from '@pix3/runtime';
import {
  deepEqual,
  diffScenes,
  indexNodes,
  leafKey,
  leafValues,
  type LeafOp,
  type LeafPath,
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
 *
 * A parent resize no longer drags its anchored children's rects into `pending`: those live in the
 * children's `layout:` margins (W21), so a dropped resize leaves nothing of theirs to drop — the
 * W16 `laid-out` reason is gone with it.
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
 * One key the editor's flushes changed since the last external version of the file: the value it
 * wrote last (`undefined` = removed) and every value its flushes replaced on the way.
 */
export interface FlushedKey {
  readonly nodeId: string | null;
  readonly path: LeafPath;
  readonly written: unknown;
  readonly replaced: readonly unknown[];
}

/** `leafKey` → {@link FlushedKey}; immutable, a flush makes a new one. */
export type FlushLedger = ReadonlyMap<string, FlushedKey>;

/** How many replaced values a key remembers (oldest dropped first). */
const MAX_REPLACED = 16;

const valueAt = (
  nodeId: string | null,
  path: LeafPath,
  leaves: Map<string, unknown>,
  index: ReturnType<typeof indexNodes>
): unknown =>
  path.length === 1 && path[0] === 'components' && nodeId !== null
    ? index.get(nodeId)?.def.components
    : leaves.get(leafKey(nodeId, path));

/** The ledger after a flush that turned `before` into `after`. */
export function recordFlushedKeys(
  ledger: FlushLedger,
  before: SavedSceneDocument,
  after: SavedSceneDocument
): FlushLedger {
  const next = new Map(ledger);
  const lb = leafValues(before);
  const ib = indexNodes(before);
  for (const op of diffScenes(before, after)) {
    if (op.kind !== 'set' && op.kind !== 'delete') continue;
    const key = leafKey(op.nodeId, op.path);
    const written = op.kind === 'set' ? op.value : undefined;
    const known = next.get(key);
    const history = known
      ? [...known.replaced, known.written]
      : [valueAt(op.nodeId, op.path, lb, ib)];
    const replaced: unknown[] = [];
    for (const value of history) {
      if (deepEqual(value, written) || replaced.some(v => deepEqual(v, value))) continue;
      replaced.push(value);
    }
    next.set(key, {
      nodeId: op.nodeId,
      path: op.path,
      written,
      replaced: replaced.slice(-MAX_REPLACED),
    });
  }
  return next;
}

/**
 * "Затирание по устаревшему чтению" (§C.3): keys the editor's flushes changed that the external
 * version E puts back to a value one of those flushes replaced — an agent wrote a file it read
 * before them. Every flush since the last external version counts, not only the last one (1.x's
 * protected set covered the same window: what the writer of E could not have seen). Returns the
 * ops that put the editor's values back.
 *
 * The ledger is spent by E either way: a key E holds at the editor's value was seen, one it changed
 * to something new is the agent's now, and a clobbered one is offered back once.
 */
export function findClobberedKeys(ledger: FlushLedger, E: SavedSceneDocument): LeafOp[] {
  const le = leafValues(E);
  const ie = indexNodes(E);
  const clobbered: LeafOp[] = [];
  for (const entry of ledger.values()) {
    if (entry.nodeId !== null && !ie.has(entry.nodeId)) continue;
    const eValue = valueAt(entry.nodeId, entry.path, le, ie);
    if (deepEqual(eValue, entry.written)) continue;
    if (!entry.replaced.some(value => deepEqual(eValue, value))) continue;
    clobbered.push(
      entry.written === undefined
        ? { kind: 'delete', nodeId: entry.nodeId, path: entry.path }
        : { kind: 'set', nodeId: entry.nodeId, path: entry.path, value: entry.written }
    );
  }
  return clobbered;
}
