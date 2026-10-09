import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  isLeafOp,
  isVectorObject,
  type LeafOp,
  type LeafPath,
  type SceneOp,
  type StructuralOp,
} from '@/core/scene-patch/scene-diff';

/**
 * `ScenePatchWriter` (plan §C.2, S12): applies semantic ops (`scene-diff.ts`) to the **text on disk**.
 *
 * The `yaml` AST only LOCATES things — node ranges, pairs, a scalar's quoting style, the id →
 * `YAMLMap` index over `root`/`children`; the file is changed by splices into the source, so
 * everything outside the diff stays byte-identical (style, indentation, quotes, the agent's
 * comments). `Document.toString()` is never used for the file: it is not byte-identical on 17–36 of
 * 36 corpus files (S12 §1.1).
 *
 * Leaf edits are computed against ONE parse and applied from the end of the file to the start.
 * When two of them would touch the same map (two keys added under one missing `transform:`, two
 * deletions that empty a map together) or overlap, the leaf ops run one at a time with a re-parse
 * between them instead — slower, same result. Structural ops (add / remove / move a node) always
 * run one at a time: each moves text the next one addresses.
 *
 * Refused with {@link ScenePatchError} (the caller falls back to full serialization, W6): anchors
 * and aliases (a splice inside an anchor edits every alias), non-empty flow `children: [...]`,
 * mixed line endings, a document that does not parse.
 */

type YMap = YAMLMap<unknown, unknown>;
type YSeq = YAMLSeq<unknown>;
type YPair = Pair<unknown, unknown>;

export class ScenePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenePatchError';
  }
}

interface NodeLocation {
  readonly map: YMap;
  readonly seq: YSeq;
  readonly index: number;
  readonly parentId: string | null;
}

interface Parsed {
  readonly src: string;
  readonly docMap: YMap;
  readonly rootSeq: YSeq;
  readonly nodes: Map<string, NodeLocation>;
}

/**
 * One splice into `Parsed.src`. `container` is the map an append or a deletion changes the shape
 * of (null for a value replacement): two such edits of one map interfere — two appends would both
 * add the same missing parent, two deletions would each leave the other's emptied map behind.
 */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly container: YMap | null;
}

const parse = (src: string): Parsed => {
  const doc = parseDocument(src);
  if (doc.errors.length > 0) throw new ScenePatchError(`yaml: ${doc.errors[0].message}`);
  let shared = false;
  visit(doc, {
    Alias() {
      shared = true;
      return visit.BREAK;
    },
    Node(_, node) {
      if (node.anchor) {
        shared = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (shared) throw new ScenePatchError('the scene uses anchors/aliases');
  const docMap = doc.contents;
  if (!isMap(docMap)) throw new ScenePatchError('the document is not a map');
  const rootSeq = docMap.get('root', true);
  if (!isSeq(rootSeq)) throw new ScenePatchError('no `root:` sequence');
  const nodes = new Map<string, NodeLocation>();
  const walk = (seq: YSeq, parentId: string | null): void => {
    seq.items.forEach((item, index) => {
      if (!isMap(item)) return;
      const id = item.get('id');
      if (typeof id !== 'string') return;
      if (nodes.has(id)) throw new ScenePatchError(`duplicate node id ${id}`);
      nodes.set(id, { map: item as YMap, seq, index, parentId });
      const children = item.get('children', true);
      if (isSeq(children)) walk(children as YSeq, id);
    });
  };
  walk(rootSeq as YSeq, null);
  return { src, docMap: docMap as YMap, rootSeq: rootSeq as YSeq, nodes };
};

// --- text helpers -------------------------------------------------------------------------------

const lineStart = (src: string, pos: number): number => src.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (src: string, pos: number): number => {
  const i = src.indexOf('\n', pos);
  return i < 0 ? src.length : i;
};
const column = (src: string, pos: number): number => pos - lineStart(src, pos);
const trimEnd = (src: string, pos: number): number => {
  while (pos > 0 && /\s/.test(src[pos - 1])) pos--;
  return pos;
};
const splice = (src: string, start: number, end: number, text: string): string =>
  src.slice(0, start) + text + src.slice(end);
const indentLines = (text: string, n: number): string =>
  text
    .split('\n')
    .map(line => (line.length > 0 ? ' '.repeat(n) + line : line))
    .join('\n');
const range = (node: unknown): [number, number, number] => {
  const r = (node as { range?: [number, number, number] | null }).range;
  if (!r) throw new ScenePatchError('a YAML node without a source range');
  return r;
};
/** End of a pair's last content character (value end, else key end). */
const pairEnd = (src: string, pair: YPair): number =>
  trimEnd(src, pair.value != null ? range(pair.value)[1] : range(pair.key)[1]);

// --- rendering of NEW content only --------------------------------------------------------------

const toYaml = (value: unknown): string => {
  const doc = new Document(value);
  visit(doc, {
    Seq(_, node) {
      if (node.items.length > 0 && node.items.every(item => isScalar(item))) node.flow = true;
    },
    Map(_, node) {
      if (isVectorObject(node.toJSON())) node.flow = true;
    },
  });
  return doc
    .toString({ indent: 2, indentSeq: true, flowCollectionPadding: false, lineWidth: 0 })
    .trimEnd();
};

const renderScalarLike = (value: unknown, existing: Scalar | null): string => {
  if (typeof value === 'string' && existing) {
    if (existing.type === 'QUOTE_DOUBLE') return JSON.stringify(value);
    if (existing.type === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`;
  }
  return toYaml(value);
};

// --- map helpers --------------------------------------------------------------------------------

const keyOf = (pair: YPair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);
const findPair = (map: YMap, key: string): YPair | undefined =>
  map.items.find(pair => keyOf(pair as YPair) === key) as YPair | undefined;

const dashColumn = (src: string, item: unknown): number => {
  const start = range(item)[0];
  const dash = src.lastIndexOf('-', start);
  if (dash < lineStart(src, start)) throw new ScenePatchError('a sequence item without its dash');
  return column(src, dash);
};

/** Indentation of block seq items relative to their key (2 in pix3 files; 0 is legal YAML). */
const seqOffset = (p: Parsed): number => {
  for (const [, location] of p.nodes) {
    const pair = findPair(location.map, 'children');
    const seq = pair?.value;
    if (pair && isSeq(seq) && !seq.flow && seq.items.length > 0) {
      return dashColumn(p.src, seq.items[0]) - column(p.src, range(pair.key)[0]);
    }
  }
  return 2;
};

/** A block-seq item's region: its leading comment lines + its lines, newline-terminated. */
const itemRegion = (
  src: string,
  seq: YSeq,
  i: number
): { start: number; end: number; dash: number } => {
  const item = seq.items[i];
  let start = lineStart(src, src.lastIndexOf('-', range(item)[0]));
  while (start > 0) {
    const previous = lineStart(src, start - 1);
    if (
      !src
        .slice(previous, start - 1)
        .trim()
        .startsWith('#')
    )
      break;
    start = previous;
  }
  let end = lineEnd(src, trimEnd(src, range(item)[1]));
  if (end < src.length) end += 1;
  return { start, end, dash: dashColumn(src, item) };
};

/** A block-map pair's own lines, newline-terminated. */
const pairRegion = (src: string, pair: YPair): { start: number; end: number } => {
  const keyStart = range(pair.key)[0];
  const start = lineStart(src, keyStart);
  if (src.slice(start, keyStart).trim() !== '') {
    throw new ScenePatchError('a pair shares its line (the first key of a sequence item)');
  }
  let end = lineEnd(src, pairEnd(src, pair));
  if (end < src.length) end += 1;
  return { start, end };
};

/** Append `rendered` (`key: value` lines at column 0) as new pair(s) of `map`. */
const appendPairs = (src: string, map: YMap, rendered: string, emptyFlowIndent: number): Edit => {
  if (map.flow) {
    const [start, end] = range(map);
    const close = trimEnd(src, end) - 1;
    if (src[close] !== '}') throw new ScenePatchError('a flow map without `}`');
    if (map.items.length === 0) {
      // `key: {}` becomes a block.
      return {
        start: trimEnd(src, start),
        end: close + 1,
        text: '\n' + indentLines(rendered, emptyFlowIndent),
        container: map,
      };
    }
    const inline = rendered.replace(/\n\s*/g, ' ');
    const padded = src[close - 1] === ' ';
    const at = trimEnd(src, close);
    return { start: at, end: close, text: `, ${inline}${padded ? ' ' : ''}`, container: map };
  }
  if (map.items.length === 0) throw new ScenePatchError('an empty block map');
  const indent = column(src, range(map.items[0].key)[0]);
  const at = lineEnd(src, pairEnd(src, map.items[map.items.length - 1] as YPair));
  return { start: at, end: at, text: '\n' + indentLines(rendered, indent), container: map };
};

// --- leaf ops -----------------------------------------------------------------------------------

interface Resolved {
  /** The map holding the last resolved segment. */
  readonly map: YMap;
  readonly pair?: YPair;
  /** Index of the first segment that does not exist. */
  readonly missingFrom?: number;
  /** `containers[i]` holds segment i. */
  readonly containers: YMap[];
}

const resolvePath = (nodeMap: YMap, path: LeafPath): Resolved => {
  let map = nodeMap;
  const containers: YMap[] = [];
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    containers.push(map);
    if (typeof segment !== 'string') throw new ScenePatchError('a component segment out of place');
    const pair = findPair(map, segment);
    if (!pair) return { map, missingFrom: i, containers };
    if (i === path.length - 1) return { map, pair, containers };
    const next = path[i + 1];
    if (typeof next !== 'string') {
      if (!isSeq(pair.value)) throw new ScenePatchError('`components` is not a sequence');
      const item = (pair.value as YSeq).items.find(c => isMap(c) && c.get('id') === next.id);
      if (!item) throw new ScenePatchError(`component ${next.id} not found`);
      map = item as YMap;
      i++;
      if (i === path.length - 1) throw new ScenePatchError('a path that ends at a component');
      continue;
    }
    if (!isMap(pair.value)) return { map, pair, missingFrom: i + 1, containers };
    map = pair.value as YMap;
  }
  throw new ScenePatchError('an empty path');
};

const nest = (path: LeafPath, value: unknown): Record<string, unknown> => {
  let nested: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) nested = { [path[i] as string]: nested };
  return nested as Record<string, unknown>;
};

/** Replace an existing pair's value, keeping the key and (for scalars) the quoting style. */
const replaceValue = (src: string, pair: YPair, value: unknown): Edit => {
  const current = pair.value;
  const keyColumn = column(src, range(pair.key)[0]);
  const scalarArray = Array.isArray(value) && value.every(x => x === null || typeof x !== 'object');
  if (isScalar(current) && (value === null || typeof value !== 'object')) {
    const [start, end] = range(current);
    const rendered = renderScalarLike(value, current as Scalar);
    const text = rendered.includes('\n')
      ? rendered.replace(/\n/g, '\n' + ' '.repeat(keyColumn + 2))
      : rendered;
    return { start, end: trimEnd(src, end), text, container: null };
  }
  if (isSeq(current) && (current as YSeq).flow && scalarArray) {
    const [start, end] = range(current);
    const padded = src[start + 1] === ' ' && (value as unknown[]).length > 0;
    const items = (value as unknown[]).map(x => toYaml(x)).join(', ');
    return {
      start,
      end: trimEnd(src, end),
      text: padded ? `[ ${items} ]` : `[${items}]`,
      container: null,
    };
  }
  // Anything else: re-render the whole value after the colon.
  const colon = src.indexOf(':', range(pair.key)[1]);
  const rendered = toYaml({ k: value }).replace(/^k:/, '');
  const text = rendered.startsWith('\n')
    ? '\n' + indentLines(rendered.slice(1).replace(/^ {2}/gm, ''), keyColumn + 2)
    : rendered;
  return { start: colon + 1, end: pairEnd(src, pair), text, container: null };
};

const setLeaf = (src: string, nodeMap: YMap, path: LeafPath, value: unknown): Edit => {
  const r = resolvePath(nodeMap, path);
  if (r.pair && r.missingFrom === undefined) return replaceValue(src, r.pair, value);
  if (r.pair && r.missingFrom !== undefined) {
    // An intermediate value is a scalar/null: replace it with the nested remainder.
    return replaceValue(src, r.pair, nest(path.slice(r.missingFrom), value));
  }
  const from = r.missingFrom!;
  const rendered = toYaml(nest(path.slice(from), value));
  const holder =
    from > 0 && typeof path[from - 1] === 'string'
      ? findPair(r.containers[from - 1], path[from - 1] as string)
      : undefined;
  const emptyFlowIndent = holder ? column(src, range(holder.key)[0]) + 2 : 0;
  return appendPairs(src, r.map, rendered, emptyFlowIndent);
};

const deleteLeaf = (src: string, nodeMap: YMap, path: LeafPath): Edit | null => {
  const r = resolvePath(nodeMap, path);
  if (!r.pair || r.missingFrom !== undefined) return null; // already absent
  // Climb while the container would become empty — never past the node map or a component.
  let depth = path.length - 1;
  while (
    depth > 0 &&
    r.containers[depth].items.length === 1 &&
    typeof path[depth - 1] === 'string'
  ) {
    depth--;
  }
  const map = r.containers[depth];
  const pair = findPair(map, path[depth] as string)!;
  if (map.flow) {
    const start = range(pair.key)[0];
    const end = pairEnd(src, pair);
    const after = /^\s*,\s*/.exec(src.slice(end));
    if (after) return { start, end: end + after[0].length, text: '', container: map };
    const before = /,\s*$/.exec(src.slice(0, start));
    return { start: start - (before ? before[0].length : 0), end, text: '', container: map };
  }
  const { start, end } = pairRegion(src, pair);
  return { start, end, text: '', container: map };
};

const leafEdit = (p: Parsed, op: LeafOp): Edit | null => {
  const nodeMap = op.nodeId === null ? p.docMap : p.nodes.get(op.nodeId)?.map;
  if (!nodeMap) throw new ScenePatchError(`node ${op.nodeId} not found`);
  return op.kind === 'set'
    ? setLeaf(p.src, nodeMap, op.path, op.value)
    : deleteLeaf(p.src, nodeMap, op.path);
};

/** All leaf ops against one parse, or null when two of them would interfere. */
const batchLeafOps = (src: string, ops: readonly LeafOp[]): string | null => {
  const p = parse(src);
  const edits: Array<Edit & { order: number }> = [];
  const containers = new Set<YMap>();
  for (const [order, op] of ops.entries()) {
    const edit = leafEdit(p, op);
    if (!edit) continue;
    if (edit.container) {
      if (containers.has(edit.container)) return null;
      containers.add(edit.container);
    }
    edits.push({ ...edit, order });
  }
  edits.sort((a, b) => b.start - a.start || b.order - a.order);
  for (let i = 1; i < edits.length; i++) {
    // Sorted by start descending: edits[i] must end at or before edits[i - 1] starts.
    if (edits[i].end > edits[i - 1].start) return null;
  }
  let out = src;
  for (const edit of edits) out = splice(out, edit.start, edit.end, edit.text);
  return out;
};

const sequentialLeafOps = (src: string, ops: readonly LeafOp[]): string => {
  let out = src;
  for (const op of ops) {
    const edit = leafEdit(parse(out), op);
    if (edit) out = splice(out, edit.start, edit.end, edit.text);
  }
  return out;
};

// --- structural ops -----------------------------------------------------------------------------

const childrenOf = (
  p: Parsed,
  parentId: string | null
): { seq: YSeq | null; pair: YPair | null; owner: YMap } => {
  if (parentId === null) {
    return { seq: p.rootSeq, pair: findPair(p.docMap, 'root') ?? null, owner: p.docMap };
  }
  const location = p.nodes.get(parentId);
  if (!location) throw new ScenePatchError(`parent ${parentId} not found`);
  const pair = findPair(location.map, 'children') ?? null;
  return {
    seq: pair && isSeq(pair.value) ? (pair.value as YSeq) : null,
    pair,
    owner: location.map,
  };
};

/** Insert an item (text with its dash at column 0) into a parent's children at `index`. */
const insertItem = (
  p: Parsed,
  parentId: string | null,
  index: number,
  itemText: string
): string => {
  const src = p.src;
  const { seq, pair, owner } = childrenOf(p, parentId);
  const body = itemText.endsWith('\n') ? itemText : itemText + '\n';
  if (seq && !seq.flow && seq.items.length > 0) {
    const text = indentLines(body, dashColumn(src, seq.items[0]));
    if (index < seq.items.length) {
      const { start } = itemRegion(src, seq, index);
      return splice(src, start, start, text);
    }
    const { end } = itemRegion(src, seq, seq.items.length - 1);
    const needNewline = end === src.length && !src.endsWith('\n');
    return splice(src, end, end, (needNewline ? '\n' : '') + text);
  }
  const offset = seqOffset(p);
  if (pair && seq && seq.flow && seq.items.length === 0) {
    const keyColumn = column(src, range(pair.key)[0]);
    const colon = src.indexOf(':', range(pair.key)[1]);
    const end = trimEnd(src, range(seq)[1]);
    return splice(
      src,
      colon + 1,
      end,
      '\n' + indentLines(body, keyColumn + offset).replace(/\n$/, '')
    );
  }
  if (!pair) {
    if (owner.items.length === 0) throw new ScenePatchError('an empty node map');
    const keyColumn = column(src, range(owner.items[0].key)[0]);
    const block = 'children:\n' + indentLines(body, offset).replace(/\n$/, '');
    const edit = appendPairs(src, owner, block, keyColumn);
    return splice(src, edit.start, edit.end, edit.text);
  }
  throw new ScenePatchError('unsupported `children` shape (a non-empty flow sequence or null)');
};

const removeItem = (p: Parsed, nodeId: string): { src: string; itemText: string } => {
  const src = p.src;
  const location = p.nodes.get(nodeId);
  if (!location) throw new ScenePatchError(`node ${nodeId} not found`);
  if (location.seq.flow) throw new ScenePatchError('a flow `children` sequence');
  const { start, end, dash } = itemRegion(src, location.seq, location.index);
  const itemText = src
    .slice(start, end)
    .split('\n')
    .map(line => line.slice(Math.min(dash, line.length - line.trimStart().length)))
    .join('\n');
  if (location.seq.items.length === 1 && location.parentId !== null) {
    const parent = p.nodes.get(location.parentId)!;
    const pair = findPair(parent.map, 'children')!;
    const colon = src.indexOf(':', range(pair.key)[1]);
    return { src: splice(src, colon, end - (src[end - 1] === '\n' ? 1 : 0), ': []'), itemText };
  }
  return { src: splice(src, start, end, ''), itemText };
};

const applyStructural = (src: string, op: StructuralOp): string => {
  const p = parse(src);
  switch (op.kind) {
    case 'removeNode':
      return removeItem(p, op.nodeId).src;
    case 'addNode':
      return insertItem(p, op.parentId, op.index, toYaml([op.def]));
    case 'moveNode': {
      const removed = removeItem(p, op.nodeId);
      return insertItem(parse(removed.src), op.parentId, op.index, removed.itemText);
    }
  }
};

// --- entry --------------------------------------------------------------------------------------

/**
 * Apply `ops` (from `diffScenes(baseline.norm, snapshot.norm)`) to `text`. Line endings and a
 * leading BOM are kept as they were. Throws {@link ScenePatchError} when the text cannot be patched.
 */
export function applySceneOps(text: string, ops: readonly SceneOp[]): string {
  if (ops.length === 0) return text;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let src = bom ? text.slice(1) : text;
  const crlf = src.includes('\r\n');
  if (crlf && /(^|[^\r])\n/.test(src)) throw new ScenePatchError('mixed line endings');
  if (crlf) src = src.replace(/\r\n/g, '\n');

  const structural = ops.filter((op): op is StructuralOp => !isLeafOp(op));
  const leaves = ops.filter(isLeafOp);
  for (const op of structural) src = applyStructural(src, op);
  if (leaves.length > 0) src = batchLeafOps(src, leaves) ?? sequentialLeafOps(src, leaves);

  // The result must still be a scene the writer can read.
  parse(src);
  return bom + (crlf ? src.replace(/\n/g, '\r\n') : src);
}
