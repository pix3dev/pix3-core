import type { SavedSceneDocument, SceneNodeDefinition } from '@pix3/runtime';
import { NODE2D_MARGIN_SIDES, Node2D } from '@pix3/runtime';
import { parse as parseYaml } from 'yaml';
import {
  deepEqual,
  isLeafOp,
  isPlainObject,
  leafKey,
  type LeafOp,
  type SceneOp,
} from '@/core/scene-patch/scene-diff';

/**
 * The one-time conversion of a scene written before W21 (`.plans/write-model.md`): its anchored
 * nodes keep their margins implicitly, as a rect against the parent's *authored* size, while the
 * norm (what the editor diffs and what a flush writes) carries them explicitly in `layout:` and
 * writes nothing the margins derive. A key-level patch of such a file cannot be partial:
 *
 * - a parent's new `width` would change what every child rect in the file means;
 * - a position written on an anchored axis is a `0` placeholder, which only a margin beside it
 *   makes sense of.
 *
 * So the first write of a legacy scene converts every anchored node whose entry in the TEXT lacks
 * a margin the norm has: the missing margins go in, the position of the anchored axes goes to
 * the norm's (`0`), and under `stretch` the derived `width`/`height` (a square's `size`/`radius`)
 * go out. All leaf ops, so the patch writer keeps everything else byte-identical; values are the
 * baseline norm's, so a flush that carries them still satisfies `norm(patch(text)) == G`. A file already in the margin form
 * yields nothing; overrides of an instance's inner nodes are left alone (their margins live in the
 * prefab file, which converts on its own first write).
 */
export function legacyAnchorConversionOps(
  text: string,
  norm: SavedSceneDocument,
  except: ReadonlySet<string> = new Set()
): LeafOp[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return [];
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.root)) return [];
  const rawById = new Map<string, Record<string, unknown>>();
  const indexRaw = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!isPlainObject(node) || typeof node.id !== 'string') continue;
      rawById.set(node.id, node);
      if (Array.isArray(node.children)) indexRaw(node.children);
    }
  };
  indexRaw(raw.root);

  const ops: LeafOp[] = [];
  const push = (op: LeafOp): void => {
    if (!except.has(leafKey(op.nodeId, op.path))) ops.push(op);
  };
  const visit = (def: SceneNodeDefinition): void => {
    const rawNode = rawById.get(def.id);
    if (rawNode) {
      if (def.instance) convertInstanceRoot(def, rawNode, push);
      else convertNode(def, rawNode, push);
    }
    for (const child of def.children ?? []) visit(child);
  };
  for (const def of norm.root) visit(def);
  return ops;
}

/**
 * `[...conversion, ...ops]`: what a flush of `ops` onto the baseline text has to write. A key `ops`
 * sets wins over its conversion value, and a node `ops` removes is not converted (the writer
 * would not find it).
 */
export function withLegacyAnchorConversion(
  text: string,
  norm: SavedSceneDocument,
  ops: readonly SceneOp[]
): SceneOp[] {
  const except = new Set<string>();
  const removed = new Set<string>();
  for (const op of ops) {
    if (isLeafOp(op)) except.add(leafKey(op.nodeId, op.path));
    else if (op.kind === 'removeNode') removed.add(op.nodeId);
  }
  const conversion = legacyAnchorConversionOps(text, norm, except).filter(
    op => op.nodeId === null || !removed.has(op.nodeId)
  );
  return [...conversion, ...ops];
}

/** The size keys `stretch` derives (`Node2D.marginDerivedSizeKeys`): a rect's, a square's. */
const MARGIN_DERIVED_SIZE_KEYS = ['width', 'height', 'size', 'radius'] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  isPlainObject(value) ? value : null;

function convertNode(
  def: SceneNodeDefinition,
  rawNode: Record<string, unknown>,
  push: (op: LeafOp) => void
): void {
  const props = record(def.properties);
  const rawProps = record(rawNode.properties);
  const layout = props && record(props.layout);
  const rawLayout = rawProps && record(rawProps.layout);
  if (!props || !rawProps || !layout || !rawLayout) return;
  let converted = false;
  for (const side of NODE2D_MARGIN_SIDES) {
    if (typeof layout[side] !== 'number' || typeof rawLayout[side] === 'number') continue;
    push({
      kind: 'set',
      nodeId: def.id,
      path: ['properties', 'layout', side],
      value: layout[side],
    });
    converted = true;
  }
  if (!converted) return;
  const transform = record(props.transform);
  const rawTransform = record(rawProps.transform);
  if (transform && Array.isArray(transform.position)) {
    const rawPosition = rawTransform ? rawTransform.position : rawProps.position;
    if (!deepEqual(rawPosition, transform.position)) {
      push({
        kind: 'set',
        nodeId: def.id,
        path: ['properties', 'transform', 'position'],
        value: transform.position,
      });
    }
  }
  for (const key of MARGIN_DERIVED_SIZE_KEYS) {
    if (props[key] === undefined && typeof rawProps[key] === 'number') {
      push({ kind: 'delete', nodeId: def.id, path: ['properties', key] });
    }
  }
}

/** An instance root carries schema names: `layoutLeft`, `position: {x, y}`, `width`. */
function convertInstanceRoot(
  def: SceneNodeDefinition,
  rawNode: Record<string, unknown>,
  push: (op: LeafOp) => void
): void {
  const props = record(def.properties);
  const rawProps = record(rawNode.properties);
  if (!props || !rawProps) return;
  let converted = false;
  for (const side of NODE2D_MARGIN_SIDES) {
    const name = Node2D.marginPropertyName(side);
    if (typeof props[name] !== 'number' || typeof rawProps[name] === 'number') continue;
    push({ kind: 'set', nodeId: def.id, path: ['properties', name], value: props[name] });
    converted = true;
  }
  if (!converted) return;
  // The norm spells an instance root's placement as `position: {x, y}`, and only when it differs
  // from the prefab's; a `transform.position` the text carries is the legacy rect, now derived.
  const rawTransform = record(rawProps.transform);
  if (rawTransform && rawTransform.position !== undefined) {
    push({ kind: 'delete', nodeId: def.id, path: ['properties', 'transform', 'position'] });
  }
  if (isPlainObject(props.position) && !deepEqual(rawProps.position, props.position)) {
    push({ kind: 'set', nodeId: def.id, path: ['properties', 'position'], value: props.position });
  }
  for (const key of MARGIN_DERIVED_SIZE_KEYS) {
    if (props[key] === undefined && typeof rawProps[key] === 'number') {
      push({ kind: 'delete', nodeId: def.id, path: ['properties', key] });
    }
  }
}
