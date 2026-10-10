import { describe, expect, it } from 'vitest';
import { Texture, Vector2 } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Group2D } from '../nodes/2D/Group2D';

function createLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

describe('Node2D anchor layout', () => {
  it('serializes and parses the shared Node2D layout payload for Sprite2D', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-anchor',
      name: 'Anchored Sprite',
      position: new Vector2(-810, -430),
      width: 200,
      height: 100,
      layout: {
        enabled: true,
        horizontalAlign: 'left',
        verticalAlign: 'bottom',
      },
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
    });

    expect(yaml).toContain('layout:');
    expect(yaml).toContain('horizontalAlign: left');
    expect(yaml).toContain('verticalAlign: bottom');
    expect(yaml).not.toContain('offsetMin:');
    expect(yaml).not.toContain('offsetMax:');

    const graph = await createLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Sprite2D;

    expect(loaded.layoutEnabled).toBe(true);
    expect(loaded.horizontalAlign).toBe('left');
    expect(loaded.verticalAlign).toBe('bottom');
  });

  it('keeps authored left and bottom margins when the runtime viewport expands', () => {
    const sprite = new Sprite2D({
      id: 'sprite-runtime',
      name: 'Runtime Sprite',
      position: new Vector2(-810, -430),
      width: 200,
      height: 100,
      layout: {
        enabled: true,
        horizontalAlign: 'left',
        verticalAlign: 'bottom',
      },
    });

    sprite.applyAnchoredLayoutRecursive(
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 }
    );

    expect(sprite.position.x).toBeCloseTo(-1130);
    expect(sprite.position.y).toBeCloseTo(-610);
    expect(sprite.width).toBe(200);
    expect(sprite.height).toBe(100);
  });

  it('stretches Group2D using authored left and right margins', () => {
    const group = new Group2D({
      id: 'stretch-group',
      name: 'Stretch Group',
      position: new Vector2(0, 0),
      width: 200,
      height: 80,
      layout: {
        enabled: true,
        horizontalAlign: 'stretch',
        verticalAlign: 'center',
      },
    });

    group.applyAnchoredLayoutRecursive({ width: 600, height: 300 }, { width: 400, height: 300 });

    expect(group.position.x).toBeCloseTo(0);
    expect(group.position.y).toBeCloseTo(0);
    expect(group.width).toBeCloseTo(400);
    expect(group.height).toBeCloseTo(80);
  });
});

/**
 * W21 (`.plans/write-model.md`): the `layout:` block stores the margins of the anchored axes, the
 * saver writes nothing they derive, and a file without them (every scene before W21) derives them
 * once from the rect against the parent's authored size — the same placement as before.
 */
describe('Node2D anchor margins in the scene file', () => {
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
    '      - id: knob',
    '        type: Group2D',
    '        name: Knob',
    '        properties:',
    '          width: 20',
    '          height: 20',
    '          layout: { enabled: true, horizontalAlign: right, verticalAlign: top }',
    '          transform: { position: [170, 120], scale: [1, 1], rotation: 0 }',
    '      - id: bar',
    '        type: Group2D',
    '        name: Bar',
    '        properties:',
    '          width: 360',
    '          height: 20',
    '          layout: { enabled: true, horizontalAlign: stretch }',
    '          transform: { position: [0, -100], scale: [1, 1], rotation: 0 }',
    '',
  ].join('\n');

  const parsed = async (text: string) =>
    createLoader().parseScene(text, { filePath: 'res://scenes/p.pix3scene' });
  const layOut = (graph: Awaited<ReturnType<typeof parsed>>) => {
    for (const root of graph.rootNodes) {
      if (root instanceof Group2D) root.applyAnchoredLayoutRecursive({ width: 400, height: 300 });
    }
    return graph;
  };
  const save = (graph: Awaited<ReturnType<typeof parsed>>) =>
    new SceneSaver().serializeScene(graph);
  const docOf = (graph: Awaited<ReturnType<typeof parsed>>) =>
    JSON.parse(JSON.stringify(new SceneSaver().serializeSceneDocument(graph))) as {
      root: Array<{ children?: Array<{ id: string; properties?: Record<string, unknown> }> }>;
    };
  const child = (graph: Awaited<ReturnType<typeof parsed>>, id: string) =>
    docOf(graph).root[0].children!.find(c => c.id === id)!.properties!;

  it('a legacy file: margins derived from the rect, written in layout:, the derived rect left out', async () => {
    const graph = await parsed(PANEL);
    // Before any layout pass (the editor's baseline is taken here) and after one: the same file.
    const fresh = child(graph, 'knob');
    expect(fresh.layout).toEqual({
      enabled: true,
      horizontalAlign: 'right',
      verticalAlign: 'top',
      right: 20,
      top: 20,
    });
    expect(fresh.transform).toEqual({ position: [0, 0], scale: [1, 1], rotation: 0 });
    expect(fresh.width).toBe(20);
    const bar = child(graph, 'bar');
    expect(bar.layout).toEqual({ enabled: true, horizontalAlign: 'stretch', left: 20, right: 20 });
    expect(bar.transform).toEqual({ position: [0, -100], scale: [1, 1], rotation: 0 });
    expect(bar.width).toBeUndefined();
    expect(bar.height).toBe(20);
    const beforeLayout = save(graph);
    layOut(graph);
    expect(save(graph)).toBe(beforeLayout);
  });

  it('the margin file loads to the same rects as the legacy one, and is a fixed point', async () => {
    const legacy = layOut(await parsed(PANEL));
    const saved = save(await parsed(PANEL));
    const reloaded = layOut(await parsed(saved));
    for (const id of ['knob', 'bar']) {
      const a = legacy.nodeMap.get(id) as Group2D;
      const b = reloaded.nodeMap.get(id) as Group2D;
      expect([b.position.x, b.position.y, b.width, b.height]).toEqual([
        a.position.x,
        a.position.y,
        a.width,
        a.height,
      ]);
    }
    expect(save(reloaded)).toBe(saved);
  });

  it('a parent resize changes the parent only; the children keep their margins and their entries', async () => {
    const graph = layOut(await parsed(PANEL));
    const before = save(graph);
    (graph.nodeMap.get('panel') as Group2D).width = 500;
    const knob = graph.nodeMap.get('knob') as Group2D;
    const bar = graph.nodeMap.get('bar') as Group2D;
    expect(knob.position.x).toBe(250 - 20 - 10);
    expect(bar.width).toBe(460);
    const after = save(graph);
    const changed = before.split('\n').filter((line, i) => after.split('\n')[i] !== line);
    expect(changed).toEqual(['      width: 400']);
  });

  it('a drag re-derives the margins against the parent (the editor’s capture); a reflow does not', async () => {
    const graph = layOut(await parsed(PANEL));
    const knob = graph.nodeMap.get('knob') as Group2D;
    knob.position.x -= 30;
    knob.captureAuthoredLayoutRectFromCurrent(true);
    expect(knob.getLayoutMargin('right')).toBe(50);
    (graph.nodeMap.get('panel') as Group2D).width = 600;
    knob.captureAuthoredLayoutRectFromCurrent();
    expect(knob.getLayoutMargin('right')).toBe(50);
    expect(knob.position.x).toBe(300 - 50 - 10);
  });

  it('a margin set in the inspector places the node; switching the alignment keeps the node where it is', async () => {
    const graph = layOut(await parsed(PANEL));
    const knob = graph.nodeMap.get('knob') as Group2D;
    knob.setLayoutMargin('right', 100);
    layOut(graph);
    expect(knob.position.x).toBe(200 - 100 - 10);
    knob.horizontalAlign = 'left';
    expect(knob.getLayoutMargin('right')).toBeUndefined();
    layOut(graph);
    expect(knob.position.x).toBe(200 - 100 - 10);
    expect(knob.getLayoutMargin('left')).toBe(400 - 100 - 20);
    expect(child(graph, 'knob').layout).toEqual({
      enabled: true,
      horizontalAlign: 'left',
      verticalAlign: 'top',
      left: 280,
      top: 20,
    });
  });

  it('a root keeps its authored rect (its reference is the viewport, not a node)', async () => {
    const graph = await parsed(
      PANEL.replace(
        '    properties:\n      width: 400\n      height: 300\n',
        '    properties:\n      width: 400\n      height: 300\n      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch }\n'
      )
    );
    const root = docOf(graph).root[0] as unknown as { properties: Record<string, unknown> };
    expect(root.properties.layout).toEqual({
      enabled: true,
      horizontalAlign: 'stretch',
      verticalAlign: 'stretch',
    });
    expect(root.properties.width).toBe(400);
    const panel = graph.rootNodes[0] as Group2D;
    panel.applyAnchoredLayoutRecursive({ width: 800, height: 300 }, { width: 400, height: 300 });
    expect(panel.width).toBe(800);
    panel.applyAnchoredLayoutRecursive({ width: 400, height: 300 }, { width: 400, height: 300 });
    expect(panel.width).toBe(400);
  });

  it("a flow owns its main axis: the child's anchor there is neither applied nor written", async () => {
    const text = PANEL.replace(
      '      height: 300\n    children:',
      '      height: 300\n      flow: { enabled: true, gap: 10 }\n    children:'
    );
    const graph = layOut(await parsed(text));
    const knob = graph.nodeMap.get('knob') as Group2D;
    expect(knob.usesLayoutMargin('top')).toBe(false);
    expect(knob.usesLayoutMargin('right')).toBe(true);
    expect(child(graph, 'knob').layout).toEqual({
      enabled: true,
      horizontalAlign: 'right',
      verticalAlign: 'top',
      right: 20,
    });
    // The flow placed the knob at the top of the column; the anchor placed it at the right.
    expect(knob.position.y).toBe(150 - 10);
    expect(knob.position.x).toBe(200 - 20 - 10);
  });
});

describe('Sprite2D fills only the axis the file leaves out', () => {
  it('an authored width survives a texture with another size', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 200, height: undefined });
    sprite.setTexture(new Texture({ width: 64, height: 32 } as unknown as HTMLImageElement));
    expect([sprite.width, sprite.height]).toEqual([200, 32]);
  });
});
