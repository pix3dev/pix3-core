import type { SavedSceneDocument, SceneNodeDefinition } from '@pix3/runtime';
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

/** A leaf's value in a document; a whole `components` list is compared as one value. */
const valueAt = (
  nodeId: string | null,
  path: LeafPath,
  leaves: Map<string, unknown>,
  index: ReturnType<typeof indexNodes>
): unknown =>
  path.length === 1 && path[0] === 'components' && nodeId !== null
    ? index.get(nodeId)?.def.components
    : leaves.get(leafKey(nodeId, path));

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
    const eValue = valueAt(op.nodeId, op.path, le, ie);
    if (deepEqual(eValue, valueAt(op.nodeId, op.path, lg, ig))) continue;
    if (deepEqual(eValue, valueAt(op.nodeId, op.path, lb, ib))) accepted.push(op);
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

/**
 * Where a node sits: its parent and the sibling right before it (`null`: first). Not an index — an
 * agent adding a sibling elsewhere shifts indices, not this. `null` as a whole: no such node.
 */
export type NodePlacement = {
  readonly parentId: string | null;
  readonly after: string | null;
} | null;

/**
 * One node the editor's flushes added, removed or moved since the last external version: where
 * they put it last (`null` = removed) and every placement they took it from on the way.
 */
export interface FlushedNode {
  readonly nodeId: string;
  readonly written: NodePlacement;
  readonly replaced: readonly NodePlacement[];
}

/** What the editor's flushes changed since the last external version; immutable, a flush makes a new one. */
export interface FlushLedger {
  /** `leafKey` → {@link FlushedKey}. */
  readonly keys: ReadonlyMap<string, FlushedKey>;
  /** Node id → {@link FlushedNode}: the structural ops (`addNode` / `removeNode` / `moveNode`). */
  readonly nodes: ReadonlyMap<string, FlushedNode>;
}

export const EMPTY_FLUSH_LEDGER: FlushLedger = { keys: new Map(), nodes: new Map() };

/** How many replaced values a key remembers (oldest dropped first). */
const MAX_REPLACED = 16;

/** `history` without `written` and repeats, newest {@link MAX_REPLACED} kept. */
const replacedValues = <T>(history: readonly T[], written: T): T[] => {
  const replaced: T[] = [];
  for (const value of history) {
    if (deepEqual(value, written) || replaced.some(v => deepEqual(v, value))) continue;
    replaced.push(value);
  }
  return replaced.slice(-MAX_REPLACED);
};

export const placementOf = (
  doc: SavedSceneDocument,
  index: ReturnType<typeof indexNodes>,
  nodeId: string
): NodePlacement => {
  const entry = index.get(nodeId);
  if (!entry) return null;
  const siblings =
    (entry.parentId === null ? doc.root : index.get(entry.parentId)?.def.children) ?? [];
  return { parentId: entry.parentId, after: siblings[entry.index - 1]?.id ?? null };
};

/**
 * Whether a `moveNode` of the diff really moved the node: another parent, or another order among
 * the siblings it has on both sides. The diff also emits moves that only make room (a sibling
 * after a group whose removal waits for a child to escape).
 */
const reallyMoved = (
  before: SavedSceneDocument,
  ib: ReturnType<typeof indexNodes>,
  after: SavedSceneDocument,
  ia: ReturnType<typeof indexNodes>,
  nodeId: string
): boolean => {
  const parentId = ia.get(nodeId)?.parentId ?? null;
  if ((ib.get(nodeId)?.parentId ?? null) !== parentId) return true;
  const siblings = (doc: SavedSceneDocument, index: ReturnType<typeof indexNodes>) =>
    ((parentId === null ? doc.root : index.get(parentId)?.def.children) ?? []).map(d => d.id);
  const was = siblings(before, ib);
  const is = siblings(after, ia);
  const common = (ids: string[], other: string[]) => ids.filter(id => other.includes(id));
  const a = common(was, is);
  const b = common(is, was);
  return a.some((id, i) => id !== b[i]);
};

/** The ledger after a flush that turned `before` into `after`. */
export function recordFlushedKeys(
  ledger: FlushLedger,
  before: SavedSceneDocument,
  after: SavedSceneDocument
): FlushLedger {
  const keys = new Map(ledger.keys);
  const nodes = new Map(ledger.nodes);
  const lb = leafValues(before);
  const ib = indexNodes(before);
  const ia = indexNodes(after);
  for (const op of diffScenes(before, after)) {
    if (op.kind !== 'set' && op.kind !== 'delete') {
      const nodeId = op.kind === 'addNode' ? op.def.id : op.nodeId;
      if (op.kind === 'moveNode' && !reallyMoved(before, ib, after, ia, nodeId)) continue;
      const written = placementOf(after, ia, nodeId);
      const known = nodes.get(nodeId);
      const history = known
        ? [...known.replaced, known.written]
        : [placementOf(before, ib, nodeId)];
      nodes.set(nodeId, { nodeId, written, replaced: replacedValues(history, written) });
      continue;
    }
    const key = leafKey(op.nodeId, op.path);
    const written = op.kind === 'set' ? op.value : undefined;
    const known = keys.get(key);
    const history = known
      ? [...known.replaced, known.written]
      : [valueAt(op.nodeId, op.path, lb, ib)];
    keys.set(key, {
      nodeId: op.nodeId,
      path: op.path,
      written,
      replaced: replacedValues(history, written),
    });
  }
  return { keys, nodes };
}

/**
 * `older` followed by `newer` (a ledger kept from an earlier session, then the flushes made since
 * on top of the version it ended with): one window, as if every flush had gone into one ledger.
 */
export function mergeFlushLedgers(older: FlushLedger, newer: FlushLedger): FlushLedger {
  const keys = new Map(older.keys);
  for (const [key, entry] of newer.keys) {
    const known = keys.get(key);
    keys.set(
      key,
      known
        ? {
            ...entry,
            replaced: replacedValues(
              [...known.replaced, known.written, ...entry.replaced],
              entry.written
            ),
          }
        : entry
    );
  }
  const nodes = new Map(older.nodes);
  for (const [nodeId, entry] of newer.nodes) {
    const known = nodes.get(nodeId);
    nodes.set(
      nodeId,
      known
        ? {
            ...entry,
            replaced: replacedValues(
              [...known.replaced, known.written, ...entry.replaced],
              entry.written
            ),
          }
        : entry
    );
  }
  return { keys, nodes };
}

export const isEmptyFlushLedger = (ledger: FlushLedger): boolean =>
  ledger.keys.size === 0 && ledger.nodes.size === 0;

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
  for (const entry of ledger.keys.values()) {
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

/**
 * A structural edit of the editor's that an external version undid (the structural half of
 * {@link findClobberedKeys}): a node it added is gone, one it deleted is back, one it moved is
 * where it was. `placement` is where the editor put it; `def` is an added node as last flushed.
 */
export type ClobberedNode =
  | {
      readonly kind: 'added';
      readonly nodeId: string;
      readonly name: string;
      readonly placement: Exclude<NodePlacement, null>;
      readonly def: SceneNodeDefinition;
    }
  | { readonly kind: 'removed'; readonly nodeId: string; readonly name: string }
  | {
      readonly kind: 'moved';
      readonly nodeId: string;
      readonly name: string;
      readonly placement: Exclude<NodePlacement, null>;
    };

/**
 * The nodes of the ledger E put back where one of the editor's flushes took them from. `written`
 * is the norm of the editor's last write (the baseline E replaces): an added node's definition
 * comes from it, and the result is in its DFS order, so a parent is restored before its child.
 * An added node inside another restored addition rides with it.
 */
export function findClobberedNodes(
  ledger: FlushLedger,
  E: SavedSceneDocument,
  written: SavedSceneDocument
): ClobberedNode[] {
  const ie = indexNodes(E);
  const iw = indexNodes(written);
  const order = new Map([...iw.keys()].map((id, i) => [id, i]));
  const clobbered: ClobberedNode[] = [];
  for (const entry of ledger.nodes.values()) {
    const ePlacement = placementOf(E, ie, entry.nodeId);
    if (deepEqual(ePlacement, entry.written)) continue;
    if (!entry.replaced.some(p => deepEqual(ePlacement, p))) continue;
    const { nodeId } = entry;
    if (entry.written === null) {
      clobbered.push({ kind: 'removed', nodeId, name: ie.get(nodeId)?.def.name ?? nodeId });
      continue;
    }
    const def = iw.get(nodeId)?.def;
    if (!def) continue;
    clobbered.push(
      ePlacement === null
        ? { kind: 'added', nodeId, name: def.name ?? nodeId, placement: entry.written, def }
        : { kind: 'moved', nodeId, name: def.name ?? nodeId, placement: entry.written }
    );
  }
  const added = new Set(clobbered.filter(c => c.kind === 'added').map(c => c.nodeId));
  const insideAdded = (nodeId: string): boolean => {
    for (let p = iw.get(nodeId)?.parentId; p; p = iw.get(p)?.parentId)
      if (added.has(p)) return true;
    return false;
  };
  return clobbered
    .filter(c => c.kind !== 'added' || !insideAdded(c.nodeId))
    .sort((a, b) => (order.get(a.nodeId) ?? -1) - (order.get(b.nodeId) ?? -1));
}

/**
 * `doc` with the clobbered nodes put back where the editor had them: the target whose
 * `diffScenes(doc, ·)` is the restore. Judged against `doc` as it is now — a node already where
 * the editor put it, a parent that no longer exists, a move into the node's own subtree: skipped.
 * An added node keeps only the descendants `doc` does not have elsewhere (an id is unique).
 */
export function restoreClobberedNodes(
  doc: SavedSceneDocument,
  nodes: readonly ClobberedNode[]
): SavedSceneDocument {
  const out = JSON.parse(JSON.stringify(doc)) as SavedSceneDocument;
  out.root ??= [];
  const locate = (
    id: string,
    list: SceneNodeDefinition[] = out.root
  ): { list: SceneNodeDefinition[]; index: number } | null => {
    for (const [index, def] of list.entries()) {
      if (def.id === id) return { list, index };
      const found = def.children ? locate(id, def.children) : null;
      if (found) return found;
    }
    return null;
  };
  const detach = (id: string): SceneNodeDefinition | null => {
    const at = locate(id);
    return at ? at.list.splice(at.index, 1)[0]! : null;
  };
  const childrenOf = (parentId: string | null): SceneNodeDefinition[] | null => {
    if (parentId === null) return out.root;
    const at = locate(parentId);
    if (!at) return null;
    const parent = at.list[at.index]!;
    return (parent.children ??= []);
  };
  const insert = (def: SceneNodeDefinition, placement: Exclude<NodePlacement, null>): boolean => {
    const list = childrenOf(placement.parentId);
    if (!list) return false;
    const after = placement.after === null ? -1 : list.findIndex(d => d.id === placement.after);
    list.splice(placement.after === null ? 0 : after < 0 ? list.length : after + 1, 0, def);
    return true;
  };

  // Removals last: a node the editor moved out of a group it then deleted escapes first.
  for (const node of nodes) {
    if (node.kind === 'removed') continue;
    if (node.kind === 'added') {
      if (locate(node.nodeId)) continue;
      const present = (id: string) => locate(id) !== null;
      const prune = (def: SceneNodeDefinition): SceneNodeDefinition => {
        const children = (def.children ?? []).filter(c => !present(c.id)).map(prune);
        const { children: _children, ...rest } = def;
        return children.length > 0 ? { ...rest, children } : (rest as SceneNodeDefinition);
      };
      insert(prune(JSON.parse(JSON.stringify(node.def)) as SceneNodeDefinition), node.placement);
      continue;
    }
    const from = locate(node.nodeId);
    if (!from) continue;
    const def = from.list.splice(from.index, 1)[0]!;
    // The parent is gone, or it is inside the node itself: put the node back where it was.
    if (!insert(def, node.placement)) from.list.splice(from.index, 0, def);
  }
  for (const node of nodes) if (node.kind === 'removed') detach(node.nodeId);
  return out;
}
