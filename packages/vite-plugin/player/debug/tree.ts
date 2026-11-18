/**
 * The running game's object tree as plain data: what `__PIX3_PLAYER__.debug.tree()` answers, the
 * overlay's Scene tab draws and `pix3 play --tree` prints. It walks the live `THREE.Scene` the
 * runner registered (`getRuntimeSceneRoot`), not the authored scene, so objects a script spawned
 * (sprites, instanced meshes, raw `THREE` children of a node) are in it.
 *
 * No value imports, `three` and `@pix3/runtime` included: the CLI bundles this file into a page
 * script for a built `dist/index.html` (`packages/cli/src/play/bundle.ts`), beside the page's own
 * runtime. Objects are read by shape.
 */

/** The fields of a live `THREE.Object3D` the walk reads. */
export interface LiveObject {
  readonly uuid: string;
  readonly name?: string;
  readonly type?: string;
  readonly visible?: boolean;
  readonly children?: readonly LiveObject[];
  readonly parent?: LiveObject | null;
  readonly userData?: Record<string, unknown>;
  readonly isInstancedMesh?: boolean;
  readonly count?: number;
  /** A `NodeBase`'s authored id. */
  readonly nodeId?: unknown;
  readonly components?: unknown;
}

export interface LiveTreeNode {
  /** The object's `uuid` (a node's is its authored id): what `debug.node()` / `highlight()` take. */
  readonly id: string;
  /** The authored node id of a `NodeBase`; null for an object the game made at run time. */
  readonly nodeId: string | null;
  /** The node type (`Sprite2D`) or the three.js type (`Mesh`). */
  readonly type: string;
  readonly name: string;
  /** The object's own `visible` (a parent can still hide it). */
  readonly visible: boolean;
  /** An `InstancedMesh`'s instance count, else null. */
  readonly instances: number | null;
  readonly children: readonly LiveTreeNode[];
  /** Children left out by the per-node or the total cap. */
  readonly more: number;
}

export interface LiveTree {
  /** Objects listed. */
  readonly count: number;
  /** Whether a cap left objects out (see `more` on their parents). */
  readonly truncated: boolean;
  /** The scene root's children. */
  readonly roots: readonly LiveTreeNode[];
}

const MAX_CHILDREN = 250;
const MAX_OBJECTS = 5000;

/** Set on what the debug tools add to the live scene themselves (the highlight box). */
export const DEBUG_HELPER_FLAG = 'isRuntimeHighlight';

const isHelper = (object: LiveObject): boolean => object.userData?.[DEBUG_HELPER_FLAG] === true;

const childrenOf = (object: LiveObject): LiveObject[] =>
  (object.children ?? []).filter(child => !isHelper(child));

const nodeIdOf = (object: LiveObject): string | null =>
  typeof object.nodeId === 'string' && Array.isArray(object.components) ? object.nodeId : null;

/** Walk `root` (a live `THREE.Scene`) into a {@link LiveTree}; an empty tree without one. */
export const liveTree = (root: LiveObject | null): LiveTree => {
  const budget = { left: MAX_OBJECTS, truncated: false };
  const visit = (object: LiveObject): LiveTreeNode => {
    budget.left -= 1;
    const all = childrenOf(object);
    const listed = all.slice(0, Math.min(MAX_CHILDREN, Math.max(0, budget.left)));
    const children: LiveTreeNode[] = [];
    for (const child of listed) {
      if (budget.left <= 0) break;
      children.push(visit(child));
    }
    const more = all.length - children.length;
    if (more > 0) budget.truncated = true;
    return {
      id: object.uuid,
      nodeId: nodeIdOf(object),
      type: object.type || 'Object3D',
      name: object.name ?? '',
      visible: object.visible !== false,
      instances: object.isInstancedMesh ? (object.count ?? null) : null,
      children,
      more,
    };
  };
  const roots: LiveTreeNode[] = [];
  for (const child of root ? childrenOf(root) : []) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    roots.push(visit(child));
  }
  return { count: MAX_OBJECTS - budget.left, truncated: budget.truncated, roots };
};

/** The live object whose `uuid` is `id` (a node's `uuid` is its authored id). */
export const findLiveObject = <T extends LiveObject>(root: T | null, id: string): T | null => {
  const stack: T[] = root ? [root] : [];
  while (stack.length > 0) {
    const object = stack.pop() as T;
    if (object.uuid === id) return object;
    stack.push(...((object.children ?? []) as T[]));
  }
  return null;
};

/** Whether `object` still hangs under `root` (a scene change replaces the root). */
export const isUnder = (object: LiveObject, root: LiveObject | null): boolean => {
  for (let at: LiveObject | null | undefined = object; at; at = at.parent) {
    if (at === root) return true;
  }
  return false;
};
