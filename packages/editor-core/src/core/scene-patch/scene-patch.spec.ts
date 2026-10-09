// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Lexer } from 'yaml';
import {
  getNodePropertySchema,
  Node2D,
  NodeBase,
  type SavedSceneDocument,
  type SceneGraph,
} from '@pix3/runtime';
import { installCanvasOnlyDocument } from '@pix3/runtime/node';
import {
  createSceneHarness,
  extraCorpus,
  templateCorpus,
  type CorpusScene,
  type SceneHarness,
} from '@pix3/runtime/node/scene-corpus';
import {
  deepEqual,
  diffScenes,
  indexNodes,
  isLeafOp,
  type SceneOp,
} from '@/core/scene-patch/scene-diff';
import { applySceneOps, ScenePatchError } from '@/core/scene-patch/scene-patch-writer';
import { findClobberedKeys, planMerge } from '@/core/scene-patch/scene-merge';

/**
 * `ScenePatchWriter` + `norm` + the §C.3 rule on the template corpus — the S12 harness
 * (`../pix3-core-spikes/s12-patch/src/run-corpus.ts`) as a spec. Every case starts from a fresh
 * graph, edits it the way an operation does (`PropertyDefinition.setValue`, tree surgery), then
 * `patched = applySceneOps(text, diff(norm(text), normOf(graph)))` must satisfy
 * `norm(patched) == normOf(graph)`, keep every comment, and stay within the line budget.
 */

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installCanvasOnlyDocument();
  for (const level of ['debug', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});
afterAll(() => {
  uninstall();
  vi.restoreAllMocks();
});

// --- helpers --------------------------------------------------------------------------------------

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash = (s: string): number =>
  [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/** Lines removed from a / added in b (LCS after common prefix/suffix). */
const lineDiff = (a: string, b: string): { removed: number; added: number } => {
  const x = a.split('\n');
  const y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const xm = x.slice(p, x.length - s);
  const ym = y.slice(p, y.length - s);
  const dp: number[][] = Array.from({ length: xm.length + 1 }, () =>
    new Array<number>(ym.length + 1).fill(0)
  );
  for (let i = xm.length - 1; i >= 0; i--)
    for (let j = ym.length - 1; j >= 0; j--)
      dp[i][j] = xm[i] === ym[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return { removed: xm.length - dp[0][0], added: ym.length - dp[0][0] };
};

const comments = (src: string): string[] =>
  [...new Lexer().lex(src)].filter(t => t.startsWith('#')).map(t => t.trim());
const sameOrder = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);
const sameMultiset = (a: string[], b: string[]): boolean => sameOrder([...a].sort(), [...b].sort());
const isSubsequence = (small: string[], big: string[]): boolean => {
  let j = 0;
  for (const c of big) if (j < small.length && small[j] === c) j++;
  return j === small.length;
};

const allNodes = (graph: SceneGraph): NodeBase[] => {
  const out: NodeBase[] = [];
  const walk = (n: NodeBase): void => {
    out.push(n);
    for (const c of n.children) if (c instanceof NodeBase) walk(c);
  };
  graph.rootNodes.forEach(walk);
  return out;
};
const insideInstance = (n: NodeBase): boolean => {
  for (let p = n.parent; p; p = p.parent) if (p instanceof NodeBase && p.instancePath) return true;
  return false;
};
const fileNodes = (graph: SceneGraph): NodeBase[] =>
  allNodes(graph).filter(n => !insideInstance(n));

const SKIP =
  /path|texture|url|src|resource|^id$|^type$|key$|font|action|axis|clip|animation|skin|scene/i;

const nudge = (type: string, v: unknown, r: () => number): unknown => {
  switch (type) {
    case 'number':
      return (typeof v === 'number' ? v : 0) + 1 + Math.floor(r() * 9);
    case 'boolean':
      return !v;
    case 'color':
      return (
        '#' +
        Math.floor(r() * 0xffffff)
          .toString(16)
          .padStart(6, '0')
      );
    case 'string':
      return `${typeof v === 'string' ? v : ''}X`;
    case 'vector2': {
      const o = (v ?? { x: 0, y: 0 }) as { x: number; y: number };
      return { x: o.x + 5, y: o.y };
    }
    case 'vector3': {
      const o = (v ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
      return { x: o.x + 5, y: o.y, z: o.z };
    }
    default:
      return undefined;
  }
};

/** One property edit the saver reflects (some edits are invisible to it, S12 §4.4). */
const editNode = (
  h: SceneHarness,
  graph: SceneGraph,
  node: NodeBase,
  r: () => number,
  before: SavedSceneDocument
): string | null => {
  const props = getNodePropertySchema(node).properties.filter(p => {
    if (p.ui?.hidden || SKIP.test(p.name)) return false;
    const ro = p.ui?.readOnly as unknown;
    if (ro === true || (typeof ro === 'function' && (ro as (n: unknown) => boolean)(node)))
      return false;
    return ['number', 'boolean', 'color', 'string', 'vector2', 'vector3'].includes(p.type);
  });
  for (let i = props.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [props[i], props[j]] = [props[j], props[i]];
  }
  for (const p of props) {
    const old = p.getValue(node);
    const next = nudge(p.type, old, r);
    if (next === undefined) continue;
    try {
      p.setValue(node, next);
    } catch {
      continue;
    }
    if (!deepEqual(h.normOf(graph), before)) return p.name;
    try {
      p.setValue(node, old);
    } catch {
      /* ignore */
    }
  }
  return null;
};

interface Flushed {
  patched: string;
  ops: SceneOp[];
  removed: number;
  added: number;
}

/** Flush the graph against `text`; asserts `norm(patched) == snapshot` and the comment rule. */
const flush = async (
  h: SceneHarness,
  scene: CorpusScene,
  text: string,
  base: SavedSceneDocument,
  graph: SceneGraph,
  rule: 'order' | 'multiset' | 'subset'
): Promise<Flushed> => {
  const snapshot = h.normOf(graph);
  const ops = diffScenes(base, snapshot);
  const patched = applySceneOps(text, ops);
  expect(await h.norm(patched, scene.path)).toEqual(snapshot);
  const a = comments(text);
  const b = comments(patched);
  const ok =
    rule === 'order'
      ? sameOrder(a, b)
      : rule === 'multiset'
        ? sameMultiset(a, b)
        : isSubsequence(b, a);
  expect(ok, `comments (${rule})`).toBe(true);
  return { patched, ops, ...lineDiff(text, patched) };
};

/** ≤3 lines per changed `norm` key, plus the nesting of a new path (S12 §7.3). */
const lineBudget = (ops: SceneOp[]): number =>
  ops.filter(isLeafOp).reduce((sum, op) => sum + 3 + Math.max(0, op.path.length - 2), 0);

// --- corpus ---------------------------------------------------------------------------------------

// `PIX3_EXTRA_CORPUS=<project dir>` adds another project's scenes (DeepCore before its migration).
const corpus = [...templateCorpus(), ...extraCorpus()];

describe.each(corpus.map(scene => [scene.name, scene] as const))('%s', (_name, scene) => {
  const h = createSceneHarness(scene.projectDir);
  const r = rng(hash(scene.name));

  it('noop: no ops, byte-identical text', async () => {
    const base = await h.norm(scene.text, scene.path);
    const ops = diffScenes(base, h.normOf(await h.parse(scene.text, scene.path)));
    expect(ops).toEqual([]);
    expect(applySceneOps(scene.text, ops)).toBe(scene.text);
  });

  it('three single-property edits, each a small patch with every comment in place', async () => {
    const base = await h.norm(scene.text, scene.path);
    const ids = fileNodes(await h.parse(scene.text, scene.path)).map(n => n.nodeId);
    let done = 0;
    for (let tries = 0; done < Math.min(3, ids.length) && tries < 40; tries++) {
      const graph = await h.parse(scene.text, scene.path);
      const node = graph.nodeMap.get(ids[Math.floor(r() * ids.length)])!;
      if (!editNode(h, graph, node, r, base)) continue;
      const result = await flush(h, scene, scene.text, base, graph, 'order');
      expect(Math.max(result.removed, result.added)).toBeLessThanOrEqual(lineBudget(result.ops));
      done++;
    }
  });

  it('prefab instance: an inner override and the instance root', async () => {
    const base = await h.norm(scene.text, scene.path);
    const graph = await h.parse(scene.text, scene.path);
    const inner = allNodes(graph).filter(n => insideInstance(n) && !n.instancePath);
    for (const node of inner) {
      if (!editNode(h, graph, node, r, base)) continue;
      const result = await flush(h, scene, scene.text, base, graph, 'order');
      expect(Math.max(result.removed, result.added)).toBeLessThanOrEqual(
        lineBudget(result.ops) + 4
      );
      break;
    }
    const rootGraph = await h.parse(scene.text, scene.path);
    const root = allNodes(rootGraph).find(n => n.instancePath);
    if (root && editNode(h, rootGraph, root, r, base)) {
      await flush(h, scene, scene.text, base, rootGraph, 'order');
    }
  });

  it('structure: add, delete, reparent, reorder', async () => {
    const base = await h.norm(scene.text, scene.path);
    const plain = (g: SceneGraph) => fileNodes(g).filter(n => !n.instancePath);

    const addGraph = await h.parse(scene.text, scene.path);
    const pool = plain(addGraph);
    const parent = pool[Math.floor(r() * pool.length)];
    const mini =
      parent instanceof Node2D
        ? 'root:\n  - id: spec-added\n    type: ColorRect2D\n    name: Added\n    properties:\n      width: 64\n      height: 32\n    children:\n      - id: spec-added-child\n        type: Group2D\n        name: Child\n'
        : 'root:\n  - id: spec-added\n    type: Node3D\n    name: Added\n    children:\n      - id: spec-added-child\n        type: Node3D\n        name: Child\n';
    const added = (await h.parse(mini, 'mini.pix3scene')).rootNodes[0];
    parent.adoptChild(added);
    parent.children.splice(parent.children.indexOf(added), 1);
    parent.children.unshift(added);
    await flush(h, scene, scene.text, base, addGraph, 'order');

    const deleteGraph = await h.parse(scene.text, scene.path);
    const victims = fileNodes(deleteGraph).filter(n => n.parent instanceof NodeBase);
    if (victims.length > 0) {
      const victim = victims[Math.floor(r() * victims.length)];
      (victim.parent as NodeBase).remove(victim);
      await flush(h, scene, scene.text, base, deleteGraph, 'subset');
    }

    const moveGraph = await h.parse(scene.text, scene.path);
    const movable = fileNodes(moveGraph).filter(n => n.parent instanceof NodeBase);
    const x = movable[Math.floor(r() * movable.length)];
    if (x) {
      const subtree = new Set<NodeBase>();
      x.traverse(o => {
        if (o instanceof NodeBase) subtree.add(o);
      });
      const targets = plain(moveGraph).filter(
        t => !subtree.has(t) && t !== x.parent && t instanceof Node2D === x instanceof Node2D
      );
      if (targets.length > 0) {
        targets[Math.floor(r() * targets.length)].adoptChild(x);
        await flush(h, scene, scene.text, base, moveGraph, 'multiset');
      }
    }

    const orderGraph = await h.parse(scene.text, scene.path);
    const parents = plain(orderGraph).filter(
      n => n.children.filter(c => c instanceof NodeBase).length >= 2
    );
    if (parents.length > 0) {
      const p = parents[Math.floor(r() * parents.length)];
      const first = p.children.find(c => c instanceof NodeBase)!;
      p.children.splice(p.children.indexOf(first), 1);
      p.children.push(first);
      await flush(h, scene, scene.text, base, orderGraph, 'multiset');
    }
  });

  it('§C.3: rename by the agent + edit by the designer both live; same key → designer dropped', async () => {
    const base = await h.norm(scene.text, scene.path);
    const graph = await h.parse(scene.text, scene.path);
    for (const node of fileNodes(graph).filter(n => !n.instancePath)) {
      const edited = editNode(h, graph, node, r, base);
      if (!edited) continue;
      if (edited === 'name') return; // the agent's rename below would be the same key
      const G = h.normOf(graph);
      const k = diffScenes(base, G).find(op => op.kind === 'set' && op.nodeId === node.nodeId);
      if (!k || k.kind !== 'set') return;

      const renamed = applySceneOps(scene.text, [
        { kind: 'set', nodeId: node.nodeId, path: ['name'], value: `${node.name} (agent)` },
      ]);
      const E1 = await h.norm(renamed, scene.path);
      const plan1 = planMerge(base, E1, G);
      expect(plan1.dropped).toEqual([]);
      const merged = await h.norm(applySceneOps(renamed, plan1.accepted), scene.path);
      const mergedNode = indexNodes(merged).get(node.nodeId)!.def;
      expect(mergedNode.name).toBe(`${node.name} (agent)`);
      expect(mergedNode.properties).toEqual(indexNodes(G).get(node.nodeId)!.def.properties);

      if (typeof k.value === 'boolean') return; // an agent can only agree with a flipped boolean
      const agentValue =
        typeof k.value === 'number'
          ? k.value + 1000
          : Array.isArray(k.value)
            ? k.value.map(v => (typeof v === 'number' ? v + 1000 : v))
            : `${String(k.value)}-agent`;
      const same = applySceneOps(scene.text, [
        { kind: 'set', nodeId: k.nodeId, path: k.path, value: agentValue },
      ]);
      const plan2 = planMerge(base, await h.norm(same, scene.path), G);
      expect(plan2.dropped.map(d => d.key)).toContain(`${k.nodeId}::${k.path.join('.')}`);
      // The agent's value wins; other keys of the edit (layout-derived ones) are still accepted.
      const merged2 = await h.norm(applySceneOps(same, plan2.accepted), scene.path);
      const agentNorm = await h.norm(same, scene.path);
      const value = (doc: SavedSceneDocument) =>
        k.path.reduce<unknown>(
          (v, seg) => (v as Record<string, unknown> | undefined)?.[seg as string],
          indexNodes(doc).get(k.nodeId!)!.def
        );
      expect(value(merged2)).toEqual(value(agentNorm));
      return;
    }
  });
});

// --- targeted ---------------------------------------------------------------------------------------

describe('targeted cases', () => {
  const tapper = corpus.find(s => s.name === 'recipe-tapper-2d:scenes/main.pix3scene')!;
  const h = createSceneHarness(tapper.projectDir);

  it('N2: an omitted default and an agent writing it explicitly are the same document', async () => {
    const text =
      'root:\n  - id: g\n    type: Group2D\n    name: G\n  - id: o\n    type: Group2D\n    name: O\n';
    const B = await h.norm(text, 'n2.pix3scene');
    const explicit = applySceneOps(text, [
      { kind: 'set', nodeId: 'g', path: ['properties', 'width'], value: 100 },
    ]);
    const E2 = await h.norm(explicit, 'n2.pix3scene');
    expect(diffScenes(B, E2)).toEqual([]);

    const graph = await h.parse(text, 'n2.pix3scene');
    const node = graph.nodeMap.get('g')!;
    getNodePropertySchema(node)
      .properties.find(p => p.name === 'width')!
      .setValue(node, 240);
    const renamed = applySceneOps(text, [
      { kind: 'set', nodeId: 'o', path: ['name'], value: 'Agent' },
    ]);
    for (const E of [E2, await h.norm(renamed, 'n2.pix3scene')]) {
      const plan = planMerge(B, E, h.normOf(graph));
      expect(plan.dropped).toEqual([]);
      expect(plan.accepted.map(op => op.path.join('.'))).toEqual(['properties.width']);
    }
  });

  it('two keys under one missing map are written as one block (batch → sequential)', async () => {
    const text = 'root:\n  - id: a\n    type: Node2D\n    name: A\n';
    const patched = applySceneOps(text, [
      { kind: 'set', nodeId: 'a', path: ['properties', 'opacity'], value: 0.5 },
      { kind: 'set', nodeId: 'a', path: ['properties', 'visible'], value: false },
      { kind: 'set', nodeId: 'a', path: ['name'], value: 'B' },
    ]);
    expect(patched).toBe(
      'root:\n  - id: a\n    type: Node2D\n    name: B\n    properties:\n      opacity: 0.5\n      visible: false\n'
    );
  });

  it('keeps CRLF and a BOM, and a trailing comment on the edited line', async () => {
    const text = '\uFEFFroot:\r\n  - id: a # the hero\r\n    name: A # rename me\r\n';
    const patched = applySceneOps(text, [{ kind: 'set', nodeId: 'a', path: ['name'], value: 'B' }]);
    expect(patched).toBe('\uFEFFroot:\r\n  - id: a # the hero\r\n    name: B # rename me\r\n');
  });

  it('writes a prefab override vector as one flow value', async () => {
    const text =
      'root:\n  - id: i\n    instance: res://p.pix3scene\n    overrides:\n      byLocalId:\n        x:\n          properties:\n            position: {x: 1, y: 2}\n';
    const patched = applySceneOps(text, [
      {
        kind: 'set',
        nodeId: 'i',
        path: ['overrides', 'byLocalId', 'x', 'properties', 'position'],
        value: { x: 5, y: 2 },
      },
    ]);
    expect(patched).toContain('position: {x: 5, y: 2}');
    expect(diffScenes({ version: '1', root: [] }, { version: '1', root: [] })).toEqual([]);
  });

  it('a JSON scene is patched as data and keeps its layout (minified, indented)', async () => {
    const doc = {
      version: '1.0.0',
      root: [{ id: 'a', type: 'Group2D', name: 'A', properties: { width: 10, height: 5 } }],
    };
    const ops = [
      { kind: 'set' as const, nodeId: 'a', path: ['properties', 'width'], value: 20 },
      { kind: 'delete' as const, nodeId: 'a', path: ['properties', 'height'] },
      { kind: 'set' as const, nodeId: 'a', path: ['properties', 'layout', 'enabled'], value: true },
    ];
    const expected = {
      ...doc,
      root: [{ ...doc.root[0], properties: { width: 20, layout: { enabled: true } } }],
    };
    expect(applySceneOps(JSON.stringify(doc), ops)).toBe(JSON.stringify(expected));
    expect(applySceneOps(`${JSON.stringify(doc, null, 2)}\n`, ops)).toBe(
      `${JSON.stringify(expected, null, 2)}\n`
    );
    const norm = await h.norm(applySceneOps(JSON.stringify(doc), ops), 'j.pix3scene');
    expect(norm.root[0].properties).toMatchObject({ width: 20 });
    // Not what JSON.stringify prints (hand-aligned): not the JSON path — YAML splices as before.
    const aligned = '{ "version": "1.0.0", "root": [ { "id": "a", "name": "A" } ] }';
    expect(() =>
      applySceneOps(aligned, [{ kind: 'set', nodeId: 'a', path: ['name'], value: 'B' }])
    ).not.toThrow();
  });

  it('refuses anchors and aliases', () => {
    const text =
      'root:\n  - id: a\n    properties: &p\n      width: 1\n  - id: b\n    properties: *p\n';
    expect(() =>
      applySceneOps(text, [{ kind: 'set', nodeId: 'a', path: ['name'], value: 'x' }])
    ).toThrow(ScenePatchError);
  });

  it('finds keys of the last flush an agent put back', async () => {
    const before = await h.norm(
      'root:\n  - id: a\n    type: Group2D\n    name: A\n',
      'c.pix3scene'
    );
    const after = await h.norm('root:\n  - id: a\n    type: Group2D\n    name: B\n', 'c.pix3scene');
    const stale = await h.norm(
      'root:\n  - id: a\n    type: Group2D\n    name: A\n    properties:\n      width: 7\n',
      'c.pix3scene'
    );
    expect(findClobberedKeys(before, after, stale).map(op => op.path.join('.'))).toEqual(['name']);
    expect(findClobberedKeys(before, after, after)).toEqual([]);
  });
});
