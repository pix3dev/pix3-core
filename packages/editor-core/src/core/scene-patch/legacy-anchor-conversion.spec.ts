// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Group2D, Node2D, type SceneGraph } from '@pix3/runtime';
import { installCanvasOnlyDocument } from '@pix3/runtime/node';
import { createSceneHarness } from '@pix3/runtime/node/scene-corpus';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffScenes, isLeafOp, leafKey } from '@/core/scene-patch/scene-diff';
import {
  legacyAnchorConversionOps,
  withLegacyAnchorConversion,
} from '@/core/scene-patch/legacy-anchor-conversion';
import { applySceneOps } from '@/core/scene-patch/scene-patch-writer';

/**
 * W21: a scene written before the margin format keeps an anchored node's margins only as its rect
 * against the parent's authored size. The editor's norm carries the margins, and its first write of
 * such a file converts every anchored node — otherwise a parent's new `width` would re-mean every
 * child rect in the file, and a `0` position placeholder would land without the margin that reads it.
 */

let uninstall: () => void = () => {};
let dir = '';
beforeAll(() => {
  uninstall = installCanvasOnlyDocument();
  for (const level of ['debug', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  dir = mkdtempSync(join(tmpdir(), 'pix3-anchor-conv-'));
  mkdirSync(join(dir, 'prefabs'));
  writeFileSync(join(dir, 'prefabs/card.pix3scene'), CARD_PREFAB);
});
afterAll(() => {
  uninstall();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const VIEW = { width: 1080, height: 1920 };

/** A legacy HUD: a left/top label and a stretched bar under a 1080×1920 root. */
const LEGACY = [
  'version: 1.0.0',
  'root:',
  '  - id: hud',
  '    type: Group2D',
  '    name: HUD',
  '    properties:',
  '      width: 1080',
  '      height: 1920',
  '      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch }',
  '    children:',
  '      - id: score',
  '        type: Group2D',
  '        name: Score # the agent wrote this',
  '        properties:',
  '          width: 200',
  '          height: 60',
  '          layout:',
  '            enabled: true',
  '            horizontalAlign: left',
  '            verticalAlign: top',
  '          transform: { position: [-400, 900], scale: [1, 1], rotation: 0 }',
  '      - id: bar',
  '        type: Group2D',
  '        name: Bar',
  '        properties:',
  '          width: 1000',
  '          height: 40',
  '          layout: { enabled: true, horizontalAlign: stretch, verticalAlign: bottom }',
  '          transform: { position: [0, -920] }',
  '      - id: card',
  '        name: Card',
  '        instance: res://prefabs/card.pix3scene',
  '        properties:',
  '          transform: { position: [440, 0] }',
  '          layoutEnabled: true',
  '          horizontalAlign: right',
  '',
].join('\n');

const CARD_PREFAB = [
  'version: 1.0.0',
  'root:',
  '  - id: card-root',
  '    type: Group2D',
  '    name: Card',
  '    properties:',
  '      width: 100',
  '      height: 100',
  '',
].join('\n');

const layOut = (graph: SceneGraph): SceneGraph => {
  for (const root of graph.rootNodes) {
    if (root instanceof Node2D) root.applyAnchoredLayoutRecursive(VIEW, VIEW);
  }
  return graph;
};

const rects = (graph: SceneGraph, ids: string[]) =>
  ids.map(id => {
    const n = graph.nodeMap.get(id) as Group2D;
    return [n.position.x, n.position.y, n.width, n.height].map(v => Math.round(v * 1000) / 1000);
  });

describe('legacy anchor conversion', () => {
  it('converts every anchored node of a legacy file, instance roots included; a root is left alone', async () => {
    const h = createSceneHarness(dir);
    const B = await h.norm(LEGACY, 'scenes/hud.pix3scene');
    const ops = legacyAnchorConversionOps(LEGACY, B).map(op => [
      leafKey(op.nodeId, op.path),
      op.kind === 'set' ? op.value : 'delete',
    ]);
    expect(ops).toEqual([
      ['score::properties.layout.left', 40],
      ['score::properties.layout.top', 30],
      ['score::properties.transform.position', [0, 0]],
      ['bar::properties.layout.left', 40],
      ['bar::properties.layout.right', 40],
      ['bar::properties.layout.bottom', 20],
      ['bar::properties.transform.position', [0, 0]],
      ['bar::properties.width', 'delete'],
      ['card::properties.layoutRight', 50],
      ['card::properties.transform.position', 'delete'],
    ]);
  });

  it('the converted file lays out as the legacy one, and converts to nothing more', async () => {
    const h = createSceneHarness(dir);
    const B = await h.norm(LEGACY, 'scenes/hud.pix3scene');
    const converted = applySceneOps(LEGACY, legacyAnchorConversionOps(LEGACY, B));
    expect(converted).toContain('# the agent wrote this');
    const ids = ['hud', 'score', 'bar', 'card'];
    expect(rects(layOut(await h.parse(converted, 'scenes/hud.pix3scene')), ids)).toEqual(
      rects(layOut(await h.parse(LEGACY, 'scenes/hud.pix3scene')), ids)
    );
    expect(await h.norm(converted, 'scenes/hud.pix3scene')).toEqual(B);
    expect(legacyAnchorConversionOps(converted, B)).toEqual([]);
  });

  it('rides on the first flush: the designer resizes the root, the children keep their margins on reload', async () => {
    const h = createSceneHarness(dir);
    const graph = await h.parse(LEGACY, 'scenes/hud.pix3scene');
    const B = h.normOf(graph);
    layOut(graph);
    (graph.nodeMap.get('hud') as Group2D).width = 1200;
    const ops = diffScenes(B, h.normOf(graph));
    expect(ops.filter(isLeafOp).map(op => leafKey(op.nodeId, op.path))).toEqual([
      'hud::properties.width',
    ]);
    expect(ops).toHaveLength(1);
    const written = applySceneOps(LEGACY, withLegacyAnchorConversion(LEGACY, B, ops));
    const reloaded = layOut(await h.parse(written, 'scenes/hud.pix3scene'));
    // 40 from the left edge and 30 from the top, as before; the bar spans the new width.
    expect(rects(reloaded, ['score', 'bar'])).toEqual([
      [-460, 900, 200, 60],
      [0, -920, 1120, 40],
    ]);
    expect((reloaded.nodeMap.get('card') as Group2D).position.x).toBe(600 - 50 - 50);
  });

  it('a key the flush sets wins over its conversion value; a removed node is not converted', async () => {
    const h = createSceneHarness(dir);
    const B = await h.norm(LEGACY, 'scenes/hud.pix3scene');
    const written = withLegacyAnchorConversion(LEGACY, B, [
      { kind: 'set', nodeId: 'score', path: ['properties', 'layout', 'left'], value: 55 },
      { kind: 'removeNode', nodeId: 'bar' },
    ]);
    const keys = written.map(op =>
      op.kind === 'set' || op.kind === 'delete' ? leafKey(op.nodeId, op.path) : op.kind
    );
    expect(keys.filter(k => k.startsWith('bar::'))).toEqual([]);
    expect(keys.filter(k => k === 'score::properties.layout.left')).toHaveLength(1);
    const text = applySceneOps(LEGACY, written);
    expect(text).toContain('left: 55');
    expect(text).not.toContain('id: bar');
  });
});
