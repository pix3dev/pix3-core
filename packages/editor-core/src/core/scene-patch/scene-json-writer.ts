import { isPlainObject, type LeafPath, type SceneOp } from '@/core/scene-patch/scene-diff';

/**
 * The JSON path of the writer: a scene file that is a JSON document (valid YAML — agents and
 * tools write them; DeepCore has some) is patched as data and printed back with its own layout.
 * JSON carries no comments, so nothing is lost by re-printing — provided the file IS what
 * `JSON.stringify` prints with that indent; {@link detectJsonLayout} checks exactly that, and a
 * file that is not (hand-aligned JSON, flow YAML) is not taken here.
 */

export interface JsonLayout {
  readonly indent: number;
  readonly trailingNewline: boolean;
}

/** The layout `text` was printed with, or null when `text` is not a re-printable JSON scene. */
export function detectJsonLayout(text: string): JsonLayout | null {
  const body = text.trimEnd();
  if (!body.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.root)) return null;
  const trailingNewline = text.endsWith('\n');
  for (const indent of [0, 2, 4, 1, 3]) {
    if (JSON.stringify(parsed, null, indent) === body) return { indent, trailingNewline };
  }
  return null;
}

type Json = Record<string, unknown>;

interface Located {
  readonly node: Json;
  readonly siblings: Json[];
}

const locate = (doc: Json, id: string): Located | null => {
  const walk = (list: unknown): Located | null => {
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      if (item.id === id) return { node: item, siblings: list as Json[] };
      const found = walk(item.children);
      if (found) return found;
    }
    return null;
  };
  return walk(doc.root);
};

const childList = (doc: Json, parentId: string | null): Json[] => {
  if (parentId === null) return doc.root as Json[];
  const parent = locate(doc, parentId)?.node;
  if (!parent) throw new Error(`parent ${parentId} not found`);
  if (!Array.isArray(parent.children)) parent.children = [];
  return parent.children as Json[];
};

interface Walk {
  /** The map holding the path's last key. */
  readonly target: Json;
  /** How each map on the way hangs off its parent; null where a component was entered. */
  readonly links: Array<{ readonly parent: Json; readonly key: string } | null>;
}

const lastKey = (path: LeafPath): string => {
  const key = path[path.length - 1];
  if (typeof key !== 'string') throw new Error('a path that ends at a component');
  return key;
};

/** Follow a leaf path to the map holding its last key, creating maps when `create`. */
const walkPath = (holder: Json, path: LeafPath, create: boolean): Walk | null => {
  const links: Walk['links'] = [];
  let current = holder;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = path[i + 1];
    if (typeof segment !== 'string') throw new Error('a component segment out of place');
    if (typeof next !== 'string') {
      const list = current[segment];
      const component = Array.isArray(list)
        ? list.find(c => isPlainObject(c) && c.id === next.id)
        : undefined;
      if (!isPlainObject(component)) throw new Error(`component ${next.id} not found`);
      current = component;
      links.push(null);
      i++;
      continue;
    }
    if (!isPlainObject(current[segment])) {
      if (!create) return null;
      current[segment] = {};
    }
    links.push({ parent: current, key: segment });
    current = current[segment] as Json;
  }
  return { target: current, links };
};

/** Apply `ops` to a parsed scene document in place (same semantics as the text writer). */
function applyToObject(doc: Json, ops: readonly SceneOp[]): void {
  const holderOf = (nodeId: string | null): Json => {
    if (nodeId === null) return doc;
    const node = locate(doc, nodeId)?.node;
    if (!node) throw new Error(`node ${nodeId} not found`);
    return node;
  };
  const structural = ops.filter(op => op.kind !== 'set' && op.kind !== 'delete');
  const leaves = ops.filter(op => op.kind === 'set' || op.kind === 'delete');
  for (const op of structural) {
    if (op.kind === 'removeNode' || op.kind === 'moveNode') {
      const found = locate(doc, op.nodeId);
      if (!found) throw new Error(`node ${op.nodeId} not found`);
      found.siblings.splice(found.siblings.indexOf(found.node), 1);
      if (op.kind === 'moveNode') childList(doc, op.parentId).splice(op.index, 0, found.node);
    } else if (op.kind === 'addNode') {
      childList(doc, op.parentId).splice(op.index, 0, structuredClone(op.def) as unknown as Json);
    }
  }
  for (const op of leaves) {
    if (op.kind === 'set') {
      walkPath(holderOf(op.nodeId), op.path, true)!.target[lastKey(op.path)] = structuredClone(
        op.value
      );
    } else if (op.kind === 'delete') {
      const walk = walkPath(holderOf(op.nodeId), op.path, false);
      if (!walk) continue;
      delete walk.target[lastKey(op.path)];
      // Climb while a map emptied — never past the node or into a component's parent.
      let target = walk.target;
      for (let i = walk.links.length - 1; i >= 0; i--) {
        const link = walk.links[i];
        if (!link || Object.keys(target).length > 0) break;
        delete link.parent[link.key];
        target = link.parent;
      }
    }
  }
}

/** `text` (a JSON scene with `layout`) with `ops` applied, printed with the same layout. */
export function applySceneOpsToJson(
  text: string,
  ops: readonly SceneOp[],
  layout: JsonLayout
): string {
  const doc = JSON.parse(text) as Json;
  applyToObject(doc, ops);
  const printed = JSON.stringify(doc, null, layout.indent);
  return layout.trailingNewline ? `${printed}\n` : printed;
}
