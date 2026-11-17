import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { GeometryMesh, Node3D, NodeBase, type SceneGraph } from '@pix3/runtime';

import type { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

import { bake, hideModelSheet, renderModel } from './bridge-model';

const part = (id: string, y: number) =>
  new GeometryMesh({
    id,
    name: id,
    position: new Vector3(0, y, 0),
    geometry: 'box',
    size: [1, 1, 1],
    material: { type: 'lambert', color: '#808080' },
  });

/** A scene with one model carrying core:MergeStatic (without the light bake, so it is quick). */
const sceneWithModel = () => {
  const model = new Node3D({ id: 'house', name: 'house' });
  model.add(part('a', 0), part('b', 1));
  (model as unknown as { components: unknown[] }).components = [
    { type: 'core:MergeStatic', config: { bake: false } },
  ];
  const nodeMap = new Map<string, NodeBase>();
  model.traverse(o => {
    if (o instanceof NodeBase) nodeMap.set(o.nodeId, o);
  });
  return { model, graph: { nodeMap, rootNodes: [model] } as unknown as SceneGraph };
};

const shownMeshes = (root: Node3D) => {
  let count = 0;
  root.traverse(o => {
    let shown = true;
    for (let n: typeof o | null = o; n; n = n.parent) if (!n.visible) shown = false;
    if ((o as { isMesh?: boolean }).isMesh && shown) count += 1;
  });
  return count;
};

describe('pix3_bake', () => {
  it('merges the nodes that carry core:MergeStatic, reports them and clears them', () => {
    const { model, graph } = sceneWithModel();
    const viewport = { requestRender: vi.fn() } as unknown as ViewportRendererService;
    const applied = bake(graph, viewport, { action: 'apply' });
    expect(applied).toMatchObject({
      ok: true,
      nodes: [{ nodeId: 'house', merged: 2, meshes: 1, bake: false }],
    });
    expect(shownMeshes(model)).toBe(1);
    expect(viewport.requestRender).toHaveBeenCalled();
    expect(bake(graph, viewport, { action: 'status' })).toMatchObject({
      baked: [{ nodeId: 'house', meshes: 1 }],
    });
    // Applying again re-merges instead of merging the merged mesh.
    expect(bake(graph, viewport, {})).toMatchObject({ nodes: [{ merged: 2, meshes: 1 }] });
    expect(bake(graph, viewport, { action: 'clear' })).toMatchObject({
      nodes: [{ nodeId: 'house', cleared: true }],
    });
    expect(shownMeshes(model)).toBe(2);
    expect(bake(graph, viewport, { action: 'status' })).toMatchObject({ baked: [] });
  });

  it('says so when nothing carries core:MergeStatic or the node is unknown', () => {
    const { graph } = sceneWithModel();
    const viewport = { requestRender: vi.fn() } as unknown as ViewportRendererService;
    expect(bake(graph, viewport, { nodeId: 'nope' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    (graph.nodeMap.get('house') as unknown as { components: unknown[] }).components = [];
    expect(bake(graph, viewport, {})).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('pix3_render_model', () => {
  const drawn = () => {
    const sheet = document.createElement('canvas');
    sheet.width = 768;
    sheet.height = 768;
    vi.spyOn(sheet, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    const info = {
      meshes: 2,
      drawCalls: 2,
      triangles: 24,
      size: [1, 2, 1] as [number, number, number],
      center: [0, 0.5, 0] as [number, number, number],
      lights: 'studio (the scene has none)',
    };
    // One 8×8 view, all of it the model: too small for the look to say anything.
    const captures = [
      {
        name: 'iso',
        pixels: { width: 8, height: 8, data: new Uint8ClampedArray(256).fill(200) },
        mask: new Uint8Array(64).fill(1),
      },
    ];
    return { renderModelSheet: vi.fn(() => ({ sheet, info, captures })) };
  };

  it('draws the node from the asked views and lays the sheet over the editor until the next call', () => {
    const { graph } = sceneWithModel();
    const viewport = drawn();
    const answer = renderModel(graph, viewport as unknown as ViewportRendererService, {
      nodeId: 'house',
      views: 'iso,30:20',
      size: 256,
    });
    expect(answer).toMatchObject({
      ok: true,
      views: ['iso', '30:20'],
      meshes: 2,
      baked: [],
      look: { coverage: 1, samples: 36, note: 'too few pixels' },
    });
    expect(answer.image).toBeUndefined();
    const [targets, options] = viewport.renderModelSheet.mock.calls[0] as unknown as [
      NodeBase[],
      { size: number; lights: string },
    ];
    expect(targets.map(t => t.nodeId)).toEqual(['house']);
    expect(options).toMatchObject({ size: 256, lights: 'auto', capture: true });
    expect(document.getElementById('pix3-model-sheet')).not.toBeNull();
    hideModelSheet();
    expect(document.getElementById('pix3-model-sheet')).toBeNull();
  });

  it('returns the PNG instead with image:true, and refuses an unknown node or view', () => {
    const { graph } = sceneWithModel();
    const viewport = drawn() as unknown as ViewportRendererService;
    expect(renderModel(graph, viewport, { image: true })).toMatchObject({
      ok: true,
      image: 'data:image/png;base64,AAAA',
    });
    expect(document.getElementById('pix3-model-sheet')).toBeNull();
    expect(renderModel(graph, viewport, { nodeId: 'nope' })).toMatchObject({ reason: 'not_found' });
    expect(renderModel(graph, viewport, { views: 'diagonal' })).toMatchObject({
      reason: 'invalid_params',
    });
  });
});
