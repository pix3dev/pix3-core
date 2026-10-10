// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getNodePropertySchema,
  Group2D,
  Node2D,
  type NodeBase,
  type SavedSceneDocument,
  type SceneGraph,
} from '@pix3/runtime';
import { installCanvasOnlyDocument } from '@pix3/runtime/node';
import { createSceneHarness, type SceneHarness } from '@pix3/runtime/node/scene-corpus';
import {
  diffScenes,
  indexNodes,
  isLeafOp,
  leafKey,
  type SceneOp,
} from '@/core/scene-patch/scene-diff';
import { layoutDerivedLeaves, maskLayoutDerived } from '@/core/scene-patch/layout-derived';
import { withLegacyAnchorConversion } from '@/core/scene-patch/legacy-anchor-conversion';
import { applySceneOps } from '@/core/scene-patch/scene-patch-writer';
import { planMerge } from '@/core/scene-patch/scene-merge';

/**
 * Write-model debt "layout-derived values" (plan §C.2, S12 §4.1): what the flow layout computes
 * must not be a pending key — not on open, not after an unrelated edit, not as instance overrides —
 * and leaving it out of the file must lose nothing (the flow puts it back on load).
 */

let uninstall: () => void = () => {};
let dir = '';
beforeAll(() => {
  uninstall = installCanvasOnlyDocument();
  for (const level of ['debug', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  dir = mkdtempSync(join(tmpdir(), 'pix3-layout-derived-'));
  mkdirSync(join(dir, 'prefabs'));
  writeFileSync(join(dir, 'prefabs/column.pix3scene'), COLUMN_PREFAB);
  writeFileSync(join(dir, 'prefabs/stack.pix3scene'), STACK_PREFAB);
});
afterAll(() => {
  uninstall();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const VIEW = { width: 720, height: 1280 };

const row = (id: string, extra: string[] = []): string[] => [
  `      - id: ${id}`,
  '        type: Group2D',
  `        name: ${id}`,
  '        properties:',
  '          width: 200',
  '          height: 40',
  ...extra,
];

/** A vertical flow column: three plain rows and one anchored to the left edge. */
const FLOW_SCENE = [
  'version: 1.0.0',
  'root:',
  '  - id: col',
  '    type: Group2D',
  '    name: Column',
  '    properties:',
  '      width: 300',
  '      height: 400',
  '      flow:',
  '        enabled: true',
  '        gap: 10',
  '    children:',
  ...row('a'),
  ...row('b'),
  ...row('c', [
    '          layout:',
    '            enabled: true',
    '            horizontalAlign: left',
    '          transform:',
    '            position: [-30, 0]',
  ]),
  '',
].join('\n');

/** A prefab whose root stacks its children (the flow is inside the instance). */
const COLUMN_PREFAB = [
  'version: 1.0.0',
  'root:',
  '  - id: p-col',
  '    type: Group2D',
  '    name: Column',
  '    properties:',
  '      width: 300',
  '      height: 400',
  '      flow:',
  '        enabled: true',
  '        gap: 8',
  '    children:',
  ...row('p-a'),
  ...row('p-b'),
  '',
].join('\n');

/** A prefab with no flow: S12's case is switching it on at the instance root. */
const STACK_PREFAB = COLUMN_PREFAB.replace(
  '        enabled: true\n        gap: 8\n',
  '        enabled: false\n        gap: 8\n'
);

const INSTANCE_SCENE = (prefab: string): string =>
  [
    'version: 1.0.0',
    'root:',
    '  - id: ui',
    '    type: Group2D',
    '    name: UI',
    '    properties:',
    '      width: 720',
    '      height: 1280',
    '    children:',
    '      - id: inst',
    '        name: Instance',
    `        instance: res://prefabs/${prefab}`,
    '',
  ].join('\n');

/** What the editor does after the parse: the viewport lays the roots out (`resizeRoot`). */
const layOut = (graph: SceneGraph): SceneGraph => {
  for (const root of graph.rootNodes) {
    if (root instanceof Node2D) root.applyAnchoredLayoutRecursive(VIEW, VIEW);
  }
  return graph;
};

const setProp = (node: NodeBase, name: string, value: unknown): void => {
  const prop = getNodePropertySchema(node).properties.find(p => p.name === name);
  if (!prop) throw new Error(`no ${name} on ${node.type}`);
  prop.setValue(node, value);
};

/** `pending` as the editor computes it: diff(baseline, masked norm of the live graph). */
const pendingOf = (h: SceneHarness, B: SavedSceneDocument, graph: SceneGraph) =>
  diffScenes(B, maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph)));

const keys = (ops: readonly SceneOp[]): string[] =>
  ops.map(op => (isLeafOp(op) ? leafKey(op.nodeId, op.path) : `${op.kind}`)).sort();

const livePositions = (graph: SceneGraph, ids: string[]) =>
  ids.map(id => {
    const n = graph.nodeMap.get(id) as Node2D;
    return [Math.round(n.position.x * 1000) / 1000, Math.round(n.position.y * 1000) / 1000];
  });

describe('flow-computed values are not pending', () => {
  it('opening a flow column: the flow moved the rows, nothing is pending', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(FLOW_SCENE, 'scenes/a.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    // The problem: the raw norm of the laid-out graph differs in every row's position.
    expect(keys(diffScenes(B, h.normOf(graph)))).toEqual([
      'a::properties.transform.position',
      'b::properties.transform.position',
      'c::properties.transform.position',
    ]);
    expect(pendingOf(h, B, graph)).toEqual([]);
  });

  it('an unrelated edit flushes alone, and the reloaded file lays out the same', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(FLOW_SCENE, 'scenes/a.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    setProp(graph.nodeMap.get('b')!, 'name', 'Row B');
    setProp(graph.nodeMap.get('col')!, 'flowGap', 24);
    layOut(graph);
    const ops = pendingOf(h, B, graph);
    expect(keys(ops)).toEqual(['b::name', 'col::properties.flow.gap']);
    const text = applySceneOps(FLOW_SCENE, ops);
    const reloaded = layOut(await h.parse(text, 'scenes/a.pix3scene'));
    expect(livePositions(reloaded, ['a', 'b', 'c'])).toEqual(livePositions(graph, ['a', 'b', 'c']));
  });

  it("an anchored row's cross axis is authored: moving it is an edit", async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(FLOW_SCENE, 'scenes/a.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    const c = graph.nodeMap.get('c') as Node2D;
    setProp(c, 'position', { x: c.position.x + 15, y: c.position.y });
    // What the editor's operations do after a position edit: the margins follow the rect (W21),
    // so the edit is the left margin, not the position (the file's x on that axis is a `0`).
    c.captureAuthoredLayoutRectFromCurrent(true);
    layOut(graph);
    expect(keys(pendingOf(h, B, graph))).toEqual(['c::properties.layout.left']);
    expect(c.getLayoutMargin('left')).toBe(35);
  });

  it('switching the flow off writes where it left the rows (they keep them)', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(FLOW_SCENE, 'scenes/a.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    const before = livePositions(graph, ['a', 'b', 'c']);
    setProp(graph.nodeMap.get('col')!, 'flowEnabled', false);
    layOut(graph);
    const ops = pendingOf(h, B, graph);
    expect(keys(ops)).toEqual([
      'a::properties.transform.position',
      'b::properties.transform.position',
      'c::properties.transform.position',
      'col::properties.flow.enabled',
    ]);
    // The flush carries the legacy file's conversion with the ops (`c` gets its margin).
    const written = withLegacyAnchorConversion(FLOW_SCENE, B, ops.filter(isLeafOp));
    const reloaded = layOut(
      await h.parse(applySceneOps(FLOW_SCENE, written), 'scenes/a.pix3scene')
    );
    expect(livePositions(reloaded, ['a', 'b', 'c'])).toEqual(before);
  });

  it('autoSize: the main-axis size of the column is the flow’s', async () => {
    const h = createSceneHarness(dir);
    const text = FLOW_SCENE.replace(
      '        gap: 10\n',
      '        gap: 10\n        autoSize: true\n'
    );
    const graph = await h.parse(text, 'scenes/a.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    expect(keys(diffScenes(B, h.normOf(graph)))).toContain('col::properties.height');
    expect(pendingOf(h, B, graph)).toEqual([]);
  });
});

describe('flow inside a prefab instance: no position overrides', () => {
  it('opening a scene with an instance of a flow prefab: nothing pending', async () => {
    const h = createSceneHarness(dir);
    const text = INSTANCE_SCENE('column.pix3scene');
    const graph = await h.parse(text, 'scenes/b.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    // The prefab base is captured from the laid-out prefab, so this one was already quiet.
    expect(pendingOf(h, B, graph)).toEqual([]);
  });

  it('S12 §4.1: flowEnabled on an instance root is one override, not one per child', async () => {
    const h = createSceneHarness(dir);
    const text = INSTANCE_SCENE('stack.pix3scene');
    const graph = await h.parse(text, 'scenes/b.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    setProp(graph.nodeMap.get('inst')!, 'flowEnabled', true);
    layOut(graph);
    // The saver writes the flowed children as position overrides (S12: +33 lines).
    expect(keys(diffScenes(B, h.normOf(graph)))).toEqual([
      'inst::overrides.byLocalId.p-a.properties.position',
      'inst::overrides.byLocalId.p-b.properties.position',
      'inst::properties.flowEnabled',
    ]);
    const ops = pendingOf(h, B, graph);
    expect(keys(ops)).toEqual(['inst::properties.flowEnabled']);
    const patched = applySceneOps(text, ops);
    const reloaded = layOut(await h.parse(patched, 'scenes/b.pix3scene'));
    const inner = (g: SceneGraph) =>
      [...g.nodeMap.values()].filter(n => n.name === 'p-a' || n.name === 'p-b').map(n => n.nodeId);
    expect(livePositions(reloaded, inner(reloaded))).toEqual(livePositions(graph, inner(graph)));
    expect(indexNodes(h.normOf(reloaded)).get('inst')?.def.properties).toMatchObject({
      flowEnabled: true,
    });
  });
});

describe('W21: a parent resize writes only the parent; the anchored children live in their margins', () => {
  const PANEL = [
    'version: 1.0.0',
    'root:',
    '  - id: panel',
    '    type: Group2D',
    '    name: Panel',
    '    properties:',
    '      width: 400',
    '      height: 300',
    '    children:',
    '      - id: bar',
    '        type: Group2D',
    '        name: Bar',
    '        properties:',
    '          width: 360',
    '          height: 20',
    '          layout:',
    '            enabled: true',
    '            horizontalAlign: stretch',
    '        children:',
    '          - id: knob',
    '            type: Group2D',
    '            name: Knob',
    '            properties:',
    '              width: 10',
    '              height: 10',
    '              layout:',
    '                enabled: true',
    '                horizontalAlign: right',
    '              transform:',
    '                position: [170, 0]',
    '      - id: title',
    '        type: Group2D',
    '        name: Title',
    '        properties:',
    '          width: 100',
    '          height: 20',
    '          transform:',
    '            position: [0, 100]',
    '',
  ].join('\n');

  const resizedPanel = async (h: SceneHarness) => {
    const graph = await h.parse(PANEL, 'scenes/p.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    setProp(graph.nodeMap.get('panel')!, 'width', 500);
    return { graph, B, G: maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph)) };
  };

  it('the designer resizes the panel: the stretched bar and its right-anchored knob follow, and only the panel is pending', async () => {
    const h = createSceneHarness(dir);
    const { graph, B, G } = await resizedPanel(h);
    const bar = graph.nodeMap.get('bar') as Group2D;
    const knob = graph.nodeMap.get('knob') as Node2D;
    // The margins (20 each side of the bar, 5 for the knob) hold at the new width.
    expect(bar.width).toBe(460);
    expect(knob.position.x).toBeCloseTo(460 / 2 - 5 - 5);
    expect(keys(diffScenes(B, G))).toEqual(['panel::properties.width']);
    // The baseline already carries the margins (derived from the legacy rects), not the rects.
    const barDef = indexNodes(B).get('bar')!.def.properties!;
    expect(barDef.layout).toEqual({
      enabled: true,
      horizontalAlign: 'stretch',
      left: 20,
      right: 20,
    });
    expect(barDef.width).toBeUndefined();
    expect(barDef.transform).toEqual({ position: [0, 0], scale: [1, 1], rotation: 0 });
    expect(indexNodes(B).get('knob')!.def.properties!.layout).toEqual({
      enabled: true,
      horizontalAlign: 'right',
      right: 5,
    });
  });

  it('an agent resized the panel too: its size wins, nothing else is dropped', async () => {
    const h = createSceneHarness(dir);
    const { B, G } = await resizedPanel(h);
    const E = await h.norm(
      applySceneOps(PANEL, [
        { kind: 'set', nodeId: 'panel', path: ['properties', 'width'], value: 450 },
      ]),
      'scenes/p.pix3scene'
    );
    const plan = planMerge(B, E, G);
    expect(plan.accepted).toEqual([]);
    expect(plan.dropped.map(d => [d.key, d.reason])).toEqual([
      ['panel::properties.width', 'same-key'],
    ]);
  });

  it('an agent renamed the title: the resize is accepted, alone', async () => {
    const h = createSceneHarness(dir);
    const { B, G } = await resizedPanel(h);
    const E = await h.norm(
      applySceneOps(PANEL, [{ kind: 'set', nodeId: 'title', path: ['name'], value: 'Heading' }]),
      'scenes/p.pix3scene'
    );
    const plan = planMerge(B, E, G);
    expect(plan.dropped).toEqual([]);
    expect(keys(plan.accepted)).toEqual(['panel::properties.width']);
  });

  it('a child the designer moved by hand is an edit of its margin, kept through a dropped resize', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(PANEL, 'scenes/p.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    setProp(graph.nodeMap.get('panel')!, 'width', 500);
    setProp(graph.nodeMap.get('title')!, 'position', { x: 30, y: 100 });
    const knob = graph.nodeMap.get('knob') as Node2D;
    setProp(knob, 'position', { x: knob.position.x - 10, y: 0 });
    knob.captureAuthoredLayoutRectFromCurrent(true);
    const G = maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph));
    expect(keys(diffScenes(B, G))).toEqual([
      'knob::properties.layout.right',
      'panel::properties.width',
      'title::properties.transform.position',
    ]);
    const E = await h.norm(
      applySceneOps(PANEL, [
        { kind: 'set', nodeId: 'panel', path: ['properties', 'width'], value: 450 },
      ]),
      'scenes/p.pix3scene'
    );
    expect(keys(planMerge(B, E, G).accepted)).toEqual([
      'knob::properties.layout.right',
      'title::properties.transform.position',
    ]);
  });

  it('the re-saved file lays out as the legacy one, and the panel resize changes one line', async () => {
    const h = createSceneHarness(dir);
    const legacy = layOut(await h.parse(PANEL, 'scenes/p.pix3scene'));
    const saved = h.save(await h.parse(PANEL, 'scenes/p.pix3scene'));
    const reloaded = layOut(await h.parse(saved, 'scenes/p.pix3scene'));
    const ids = ['panel', 'bar', 'knob', 'title'];
    expect(livePositions(reloaded, ids)).toEqual(livePositions(legacy, ids));
    expect((reloaded.nodeMap.get('bar') as Group2D).width).toBe(360);
    // Resize the panel in the reloaded graph: the full save differs from `saved` in one line.
    setProp(reloaded.nodeMap.get('panel')!, 'width', 500);
    const resized = h.save(reloaded);
    const changed = saved.split('\n').filter((line, i) => resized.split('\n')[i] !== line);
    expect(changed).toEqual(['      width: 400']);
    expect(resized.split('\n').length).toBe(saved.split('\n').length);
  });
});

/**
 * The same for a square (`size`: Checkbox2D, `radius`: Joystick2D): under `stretch` its side is the
 * stretched span, so its one size key is the margins' (`Node2D.marginDerivedSizeKeys`) — a parent
 * resize is the parent's line alone, and the legacy file's `size`/`radius` goes on its first write.
 */
describe('W21 for a square: a parent resize does not write the stretched child’s size/radius', () => {
  const PANEL = [
    'version: 1.0.0',
    'root:',
    '  - id: panel',
    '    type: Group2D',
    '    name: Panel',
    '    properties:',
    '      width: 400',
    '      height: 300',
    '    children:',
    '      - id: check',
    '        type: Checkbox2D',
    '        name: Check',
    '        properties:',
    '          size: 40',
    '          label: Sound',
    '          layout:',
    '            enabled: true',
    '            horizontalAlign: stretch',
    '            verticalAlign: top',
    '          transform:',
    '            position: [0, 110]',
    '      - id: stick',
    '        type: Joystick2D',
    '        name: Stick',
    '        properties:',
    '          radius: 30',
    '          layout:',
    '            enabled: true',
    '            horizontalAlign: left',
    '            verticalAlign: stretch',
    '          transform:',
    '            position: [-150, 0]',
    '',
  ].join('\n');

  type Square = Node2D & { size?: number; radius?: number };
  const squares = (graph: SceneGraph) =>
    ['check', 'stick'].map(id => {
      const n = graph.nodeMap.get(id) as Square;
      return [n.position.x, n.position.y, n.size ?? n.radius];
    });
  /** The editor's parent resize: set the size, the children keep the rects the margins gave. */
  const resizePanel = (graph: SceneGraph, width: number, height: number) => {
    const panel = graph.nodeMap.get('panel') as Group2D;
    setProp(panel, 'width', width);
    setProp(panel, 'height', height);
    for (const child of panel.children) {
      if (child instanceof Node2D) child.captureAuthoredLayoutRectFromCurrent();
    }
  };

  it('the designer resizes the panel: the squares follow their spans, only the panel is pending', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(PANEL, 'scenes/p.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    expect(squares(graph)).toEqual([
      [0, 110, 40],
      [-150, 0, 30],
    ]);
    resizePanel(graph, 500, 400);
    // check: 500 − 180 − 180 wide, hung 20 below the top; stick: (400 − 120 − 120) / 2.
    expect(squares(graph)).toEqual([
      [0, 200 - 20 - 70, 140],
      [-250 + 20 + 80, 0, 80],
    ]);
    const G = maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph));
    expect(keys(diffScenes(B, G))).toEqual(['panel::properties.height', 'panel::properties.width']);
    expect(indexNodes(B).get('check')!.def.properties!.size).toBeUndefined();
    expect(indexNodes(B).get('stick')!.def.properties!.radius).toBeUndefined();
  });

  it('the first flush converts the legacy squares; the written file reloads to the same squares', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(PANEL, 'scenes/p.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    resizePanel(graph, 500, 400);
    const G = maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph));
    const ops = diffScenes(B, G).filter(isLeafOp);
    const written = applySceneOps(PANEL, withLegacyAnchorConversion(PANEL, B, ops));
    expect(written).not.toMatch(/^\s+(size|radius):/m);
    expect(await h.norm(written, 'scenes/p.pix3scene')).toEqual(G);
    const reloaded = await h.parse(written, 'scenes/p.pix3scene');
    layOut(reloaded);
    expect(squares(reloaded)).toEqual(squares(graph));
    // The next resize, onto the converted file: the panel's lines and nothing else.
    resizePanel(reloaded, 600, 400);
    const B2 = await h.norm(written, 'scenes/p.pix3scene');
    const next = diffScenes(B2, h.normOf(reloaded)).filter(isLeafOp);
    const again = applySceneOps(written, withLegacyAnchorConversion(written, B2, next));
    const changed = written.split('\n').filter((line, i) => again.split('\n')[i] !== line);
    expect(changed).toEqual(['      width: 500']);
  });

  it('an inspector edit of the child’s size writes: its margins, and the reload has the new size', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(PANEL, 'scenes/p.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    // UpdateObjectPropertyOperation on `size`: set it, re-derive the margins, lay out again.
    const check = graph.nodeMap.get('check') as Node2D;
    setProp(check, 'size', 60);
    check.captureAuthoredLayoutRectFromCurrent(true);
    layOut(graph);
    const G = maskLayoutDerived(h.normOf(graph), B, layoutDerivedLeaves(graph));
    expect(keys(diffScenes(B, G))).toEqual([
      'check::properties.layout.left',
      'check::properties.layout.right',
      'check::properties.layout.top',
    ]);
    const written = applySceneOps(
      PANEL,
      withLegacyAnchorConversion(PANEL, B, diffScenes(B, G).filter(isLeafOp))
    );
    const reloaded = await h.parse(written, 'scenes/p.pix3scene');
    layOut(reloaded);
    expect(squares(reloaded)[0]).toEqual([0, 110, 60]);
  });
});
