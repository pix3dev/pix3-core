import type { SavedSceneDocument, SceneNodeDefinition } from '@pix3/runtime';

/**
 * Semantic diff of two normalised scene documents (`SavedSceneDocument`, the saver's plain output)
 * — the `pending` of plan §C.1: `pending = diff(baseline.norm, norm(graph))`, computed at flush or
 * reload, so perform / undo / redo / coalesce need no bookkeeping (N8).
 *
 * Addressing (S12 §1.2): a leaf is `(nodeId | null for the document head, path)`. Path segments are
 * map keys, or `{ id }` for an element of `components` (a component is addressed by its id, never
 * by index). Arrays other than `components` / `children` / `root` are atomic (vectors, groups,
 * effect stacks), and so are `{x, y[, z]}` objects (prefab override vectors, S12 §4.3). Other plain
 * objects recurse, so `transform.position` or `overrides.byLocalId.<localId>.properties.<prop>` are
 * leaves.
 */

export type PathSegment = string | { readonly id: string };
export type LeafPath = readonly PathSegment[];

export type SceneOp =
  | {
      readonly kind: 'set';
      readonly nodeId: string | null;
      readonly path: LeafPath;
      readonly value: unknown;
    }
  | { readonly kind: 'delete'; readonly nodeId: string | null; readonly path: LeafPath }
  | {
      readonly kind: 'addNode';
      readonly parentId: string | null;
      readonly index: number;
      readonly def: SceneNodeDefinition;
    }
  | { readonly kind: 'removeNode'; readonly nodeId: string }
  | {
      readonly kind: 'moveNode';
      readonly nodeId: string;
      readonly parentId: string | null;
      readonly index: number;
    };

export type LeafOp = Extract<SceneOp, { kind: 'set' | 'delete' }>;
export type StructuralOp = Exclude<SceneOp, LeafOp>;

export const isLeafOp = (op: SceneOp): op is LeafOp => op.kind === 'set' || op.kind === 'delete';

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{x, y}` / `{x, y, z}` of numbers: a vector, written and merged as one value. */
export const isVectorObject = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || keys.length === 3) &&
    keys.every(key => (key === 'x' || key === 'y' || key === 'z') && typeof value[key] === 'number')
  );
};

/** Structural equality; numbers within 1e-9 (the saver's float noise, `29.999999999999996`). */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter(k => a[k] !== undefined);
    const kb = Object.keys(b).filter(k => b[k] !== undefined);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
};

/** Stable key of a leaf: `<nodeId|@doc>::a.b.[componentId].c`. */
export const leafKey = (nodeId: string | null, path: LeafPath): string =>
  `${nodeId ?? '@doc'}::${path.map(s => (typeof s === 'string' ? s : `[${s.id}]`)).join('.')}`;

/** Human label of a leaf for toasts: `Node name › properties.width`. */
export const describeLeaf = (nodeName: string | null, path: LeafPath): string =>
  `${nodeName ?? 'scene'} › ${path.map(s => (typeof s === 'string' ? s : s.id)).join('.')}`;

type LeafMap = Map<string, { path: LeafPath; value: unknown }>;

const componentsAddressable = (components: readonly unknown[]): boolean => {
  const ids = components.map(c => (isPlainObject(c) ? c.id : undefined));
  return ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length;
};

/** Leaves of one node definition (`children` and `id` excluded). */
export const flattenNode = (def: SceneNodeDefinition | Record<string, unknown>): LeafMap => {
  const out: LeafMap = new Map();
  const walk = (value: unknown, path: PathSegment[]): void => {
    if (isPlainObject(value) && Object.keys(value).length > 0 && !isVectorObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        if (path.length === 0 && (key === 'children' || key === 'id')) continue;
        if (
          path.length === 0 &&
          key === 'components' &&
          Array.isArray(child) &&
          componentsAddressable(child)
        ) {
          for (const component of child as Record<string, unknown>[]) {
            for (const [ck, cv] of Object.entries(component)) {
              if (ck === 'id' || cv === undefined) continue;
              walk(cv, ['components', { id: String(component.id) }, ck]);
            }
          }
          continue;
        }
        walk(child, [...path, key]);
      }
      return;
    }
    out.set(leafKey(null, path), { path, value });
  };
  walk(def, []);
  return out;
};

export interface NodeEntry {
  readonly def: SceneNodeDefinition;
  readonly parentId: string | null;
  readonly index: number;
}

export const indexNodes = (doc: SavedSceneDocument): Map<string, NodeEntry> => {
  const out = new Map<string, NodeEntry>();
  const walk = (
    defs: readonly SceneNodeDefinition[] | undefined,
    parentId: string | null
  ): void => {
    (defs ?? []).forEach((def, index) => {
      out.set(def.id, { def, parentId, index });
      walk(def.children, def.id);
    });
  };
  walk(doc.root, null);
  return out;
};

const childIds = (
  doc: SavedSceneDocument,
  parentId: string | null,
  index: Map<string, NodeEntry>
): string[] =>
  ((parentId === null ? doc.root : index.get(parentId)?.def.children) ?? []).map(d => d.id);

/** Document head leaves (`version`, `description`, `metadata.*`). */
const flattenHead = (doc: SavedSceneDocument): LeafMap => {
  const { root: _root, ...head } = doc;
  return flattenNode(head as Record<string, unknown>);
};

const componentIds = (def: SceneNodeDefinition): string =>
  JSON.stringify(
    Array.isArray(def.components) ? def.components.map(c => (isPlainObject(c) ? c.id : '?')) : null
  );

const leafOps = (nodeId: string | null, a: LeafMap, b: LeafMap): LeafOp[] => {
  const ops: LeafOp[] = [];
  for (const [key, { path, value }] of b) {
    const prev = a.get(key);
    if (!prev || !deepEqual(prev.value, value)) ops.push({ kind: 'set', nodeId, path, value });
  }
  for (const [key, { path }] of a) if (!b.has(key)) ops.push({ kind: 'delete', nodeId, path });
  return ops;
};

const nodeLeafOps = (
  nodeId: string,
  da: SceneNodeDefinition,
  db: SceneNodeDefinition
): LeafOp[] => {
  const a = flattenNode(da);
  const b = flattenNode(db);
  if (componentIds(da) === componentIds(db)) return leafOps(nodeId, a, b);
  // A component added, removed or reordered: the list is written as one value.
  const withoutComponents = (m: LeafMap): LeafMap =>
    new Map([...m].filter(([, v]) => v.path[0] !== 'components'));
  const ops = leafOps(nodeId, withoutComponents(a), withoutComponents(b));
  ops.push(
    db.components && db.components.length > 0
      ? { kind: 'set', nodeId, path: ['components'], value: db.components }
      : { kind: 'delete', nodeId, path: ['components'] }
  );
  return ops;
};

/**
 * `diff(A, B)`: the ops that turn a file whose norm is A into one whose norm is B. Structural ops
 * come first, computed against a simulated id tree (removals top-most only, then adds/moves in B's
 * DFS order); leaf ops of nodes on both sides and of the document head follow.
 */
export const diffScenes = (A: SavedSceneDocument, B: SavedSceneDocument): SceneOp[] => {
  const ia = indexNodes(A);
  const ib = indexNodes(B);
  const ops: SceneOp[] = [];

  const tree = new Map<string | null, string[]>();
  const parentOf = new Map<string, string | null>();
  tree.set(null, childIds(A, null, ia));
  for (const [id, entry] of ia) {
    tree.set(id, childIds(A, id, ia));
    parentOf.set(id, entry.parentId);
  }

  for (const [id, entry] of ia) {
    if (ib.has(id)) continue;
    if (entry.parentId !== null && !ib.has(entry.parentId)) continue;
    ops.push({ kind: 'removeNode', nodeId: id });
    const siblings = tree.get(entry.parentId)!;
    siblings.splice(siblings.indexOf(id), 1);
  }

  const visit = (
    parentId: string | null,
    defs: readonly SceneNodeDefinition[] | undefined
  ): void => {
    (defs ?? []).forEach((def, i) => {
      const id = def.id;
      if (!parentOf.has(id)) {
        // A new node carries its subtree when every descendant is new too.
        const allNew = (d: SceneNodeDefinition): boolean =>
          (d.children ?? []).every(c => !ia.has(c.id) && allNew(c));
        const whole = allNew(def);
        const carried = whole ? def : { ...def, children: undefined };
        ops.push({ kind: 'addNode', parentId, index: i, def: carried });
        tree.get(parentId)!.splice(i, 0, id);
        parentOf.set(id, parentId);
        if (whole) {
          const mark = (d: SceneNodeDefinition, p: string | null): void => {
            parentOf.set(d.id, p);
            tree.set(
              d.id,
              (d.children ?? []).map(c => c.id)
            );
            (d.children ?? []).forEach(c => mark(c, d.id));
          };
          mark(def, parentId);
        } else {
          tree.set(id, []);
          visit(id, def.children);
        }
        return;
      }
      const currentParent = parentOf.get(id)!;
      const siblings = tree.get(currentParent)!;
      if (currentParent !== parentId || siblings.indexOf(id) !== i) {
        siblings.splice(siblings.indexOf(id), 1);
        tree.get(parentId)!.splice(i, 0, id);
        parentOf.set(id, parentId);
        ops.push({ kind: 'moveNode', nodeId: id, parentId, index: i });
      }
      visit(id, def.children);
    });
  };
  visit(null, B.root);

  ops.push(...leafOps(null, flattenHead(A), flattenHead(B)));
  for (const [id, eb] of ib) {
    const ea = ia.get(id);
    if (ea) ops.push(...nodeLeafOps(id, ea.def, eb.def));
  }
  return ops;
};

/** Every leaf of a document: key → value. */
export const leafValues = (doc: SavedSceneDocument): Map<string, unknown> => {
  const out = new Map<string, unknown>();
  for (const [, { path, value }] of flattenHead(doc)) out.set(leafKey(null, path), value);
  for (const [id, entry] of indexNodes(doc)) {
    for (const [, { path, value }] of flattenNode(entry.def)) out.set(leafKey(id, path), value);
  }
  return out;
};
