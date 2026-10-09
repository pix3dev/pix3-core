import { Node2D, NodeBase, type SavedSceneDocument, type SceneGraph } from '@pix3/runtime';
import { deepEqual, indexNodes, isPlainObject } from '@/core/scene-patch/scene-diff';

/**
 * Values the flow layout computes (`Node2D.applyFlowLayout`), which the saver writes like authored
 * ones (plan §C.2 "Значения, производные от раскладки", S12 §4.1):
 *
 * - the position of every visible 2D child of a container whose `flow` is enabled — the flow
 *   overwrites it on every layout pass in the editor and in the game, so the file's value never
 *   matters; for a child with its own anchor (`layout.enabled`) only the main axis is the flow's,
 *   the cross axis stays authored;
 * - the main-axis size of a container with `flow.autoSize`;
 * - the same values written as prefab-instance overrides (a flow container inside an instance, or
 *   an instance root with a flow), which is where S12 found them: +33 lines for one toggle.
 *
 * In the editor the baseline is normalised from a freshly parsed graph (before any layout pass,
 * W1) and the live graph after the viewport laid it out, so without this every one of these values
 * is a `pending` key from the moment the scene opens: the first flush writes them, and a merge
 * treats them as the designer's edits. {@link maskLayoutDerived} puts the baseline's value back
 * for each of them, so the diff, the flush, the draft and the merge see only authored changes.
 *
 * Not covered here, on purpose: sizes and positions the ANCHOR layout (`layout:` stretch/edges)
 * gives children when their parent is resized. Those are not recomputable from the file — a
 * child's rect relative to its parent's authored size is how the margins are stored — so a parent
 * resize has to write them (see `planMerge` for how a merge keeps them consistent).
 */

/** One derived leaf of the norm: the node definition it lives on and the path inside it. */
export interface DerivedLeaf {
  /** Id of the node definition in the norm (an instance root for an override). */
  readonly nodeId: string;
  readonly path: readonly string[];
  /**
   * For an anchored flow child: the authored cross-axis component (`0`/`x` or `1`/`y`). The leaf
   * is masked only when that component is unchanged; a changed cross coordinate is an edit.
   */
  readonly crossAxis?: 'x' | 'y';
}

/** The leaves of `graph`'s norm that the flow layout computed. */
export function layoutDerivedLeaves(graph: SceneGraph): DerivedLeaf[] {
  const out: DerivedLeaf[] = [];
  const visit = (node: NodeBase): void => {
    if (node instanceof Node2D && node.flow.enabled) {
      const vertical = node.flow.direction === 'vertical';
      for (const child of node.children) {
        if (!(child instanceof Node2D) || !child.visible) continue;
        const crossAxis = child.layoutEnabled ? (vertical ? 'x' : 'y') : undefined;
        const leaf = positionLeaf(child);
        if (leaf) out.push(crossAxis ? { ...leaf, crossAxis } : leaf);
      }
      if (node.flow.autoSize) {
        const leaf = propertyLeaf(node, vertical ? 'height' : 'width');
        if (leaf) out.push(leaf);
      }
    }
    for (const child of node.children) if (child instanceof NodeBase) visit(child);
  };
  for (const root of graph.rootNodes) visit(root);
  return out;
}

/**
 * `norm` (of the live graph) with every leaf in `leaves` set back to its value in `baseline` (or
 * removed when the baseline has none). Mutates and returns `norm`, which must be the caller's own
 * copy (`normOfGraph` makes one).
 */
export function maskLayoutDerived(
  norm: SavedSceneDocument,
  baseline: SavedSceneDocument,
  leaves: readonly DerivedLeaf[]
): SavedSceneDocument {
  if (leaves.length === 0) return norm;
  const live = indexNodes(norm);
  const base = indexNodes(baseline);
  for (const leaf of leaves) {
    const target = live.get(leaf.nodeId)?.def as Record<string, unknown> | undefined;
    if (!target) continue;
    const source = base.get(leaf.nodeId)?.def as Record<string, unknown> | undefined;
    const now = readPath(target, leaf.path);
    const before = source ? readPath(source, leaf.path) : undefined;
    if (leaf.crossAxis && !sameComponent(now, before, leaf.crossAxis)) continue;
    if (deepEqual(now, before)) continue;
    writePath(target, leaf.path, before);
  }
  return norm;
}

// --- where a node's values live in the norm ---------------------------------------------------------

/** `effectiveLocalId` of a node built from a prefab (the loader's `__pix3Prefab` marker). */
function prefabLocalId(node: NodeBase): string | null {
  const marker = (node.metadata as Record<string, unknown>).__pix3Prefab;
  const id = isPlainObject(marker) ? marker.effectiveLocalId : undefined;
  return typeof id === 'string' ? id : null;
}

function insideInstance(node: NodeBase): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) if (p.instancePath) return true;
  return false;
}

/**
 * Where a node's values live in the norm: its own definition (a file node, or an instance root),
 * or — for a node inside an instance — the overrides of the outermost instance root in the file,
 * keyed like `SceneSaver.serializeInstanceNode` keys them.
 */
function ownerOf(node: NodeBase): { ownerId: string; prefix: readonly string[] } | null {
  if (!insideInstance(node)) return { ownerId: node.nodeId, prefix: ['properties'] };
  const localId = prefabLocalId(node);
  if (localId === null) return null;
  let root: NodeBase | null = null;
  for (let p = node.parentNode; p; p = p.parentNode) if (p.instancePath) root = p;
  if (!root) return null;
  const rootKey = (prefabLocalId(root) ?? root.nodeId)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  const key = localId.startsWith(`${rootKey}/`) ? localId.slice(rootKey.length + 1) : localId;
  return { ownerId: root.nodeId, prefix: ['overrides', 'byLocalId', key, 'properties'] };
}

/**
 * The position leaf: `properties.transform.position` (`[x, y]`) on a file node, `properties.position`
 * (`{x, y}`, the schema name) on an instance root or in an override.
 */
function positionLeaf(node: NodeBase): DerivedLeaf | null {
  const owner = ownerOf(node);
  if (!owner) return null;
  // Instance roots and overrides carry schema values (`position: {x, y}`), file nodes the saver's
  // own `transform` block.
  const schemaNamed = owner.prefix[0] === 'overrides' || !!node.instancePath;
  return {
    nodeId: owner.ownerId,
    path: schemaNamed ? [...owner.prefix, 'position'] : [...owner.prefix, 'transform', 'position'],
  };
}

function propertyLeaf(node: NodeBase, name: string): DerivedLeaf | null {
  const owner = ownerOf(node);
  return owner ? { nodeId: owner.ownerId, path: [...owner.prefix, name] } : null;
}

// --- path helpers -------------------------------------------------------------------------------------

function readPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Set (or, for `undefined`, delete and prune emptied parents) the value at `path`. */
function writePath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const parents: Record<string, unknown>[] = [root];
  let current = root;
  for (const segment of path.slice(0, -1)) {
    let next = current[segment];
    if (!isPlainObject(next)) {
      if (value === undefined) return;
      next = {};
      current[segment] = next;
    }
    current = next as Record<string, unknown>;
    parents.push(current);
  }
  const last = path[path.length - 1];
  if (value !== undefined) {
    current[last] = structuredClone(value);
    return;
  }
  delete current[last];
  // An override map left empty is not written by the saver either.
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]).length > 0) break;
    delete parents[i - 1][path[i - 1]];
  }
}

function component(value: unknown, axis: 'x' | 'y'): unknown {
  if (Array.isArray(value)) return value[axis === 'x' ? 0 : 1];
  if (isPlainObject(value)) return value[axis];
  return undefined;
}

function sameComponent(a: unknown, b: unknown, axis: 'x' | 'y'): boolean {
  if (a === undefined || b === undefined) return a === b;
  return deepEqual(component(a, axis), component(b, axis));
}
