import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Group2D } from '../nodes/2D/Group2D';
import type { Node2DSafeInsets } from '../nodes/Node2D';

/**
 * `layout.safeArea` (core-tests/game10): a full-screen root's child lays out in the screen minus
 * the notch and the home indicator; everything else, and every node without insets, is unchanged.
 */

const DESIGN = { width: 1080, height: 1920 };
const TALL = { width: 1080, height: 2337 }; // 390×844 at match-min
const INSETS: Node2DSafeInsets = { top: 130, right: 0, bottom: 94, left: 0 };

const build = (safe: boolean) => {
  const root = new Group2D({
    id: 'game-root',
    name: 'Game Root',
    width: 1080,
    height: 1920,
    layout: {
      enabled: true,
      horizontalAlign: 'stretch',
      verticalAlign: 'stretch',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
  });
  const background = new Group2D({
    id: 'background',
    name: 'Background',
    width: 1080,
    height: 1920,
    layout: {
      enabled: true,
      horizontalAlign: 'stretch',
      verticalAlign: 'stretch',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
  });
  const hud = new Group2D({
    id: 'hud',
    name: 'HUD',
    width: 1000,
    height: 200,
    position: new Vector2(0, 820),
    layout: {
      enabled: true,
      horizontalAlign: 'center',
      verticalAlign: 'top',
      top: 40,
      safeArea: safe,
    },
  });
  const designArea = new Group2D({
    id: 'design-area',
    name: 'Design Area',
    width: 1080,
    height: 1920,
    layout: { enabled: false, safeArea: safe },
  });
  root.adoptChild(background);
  root.adoptChild(hud);
  root.adoptChild(designArea);
  return { root, background, hud, designArea };
};

describe('layout.safeArea', () => {
  it('a top-anchored HUD measures from the safe top; an unanchored group centres in the safe area', () => {
    const { root, background, hud, designArea } = build(true);
    root.applyAnchoredLayoutRecursive(TALL, DESIGN, INSETS);
    // The safe rect: 2337 - 130 - 94 = 2113 tall, its centre 18 below the screen's.
    expect(hud.position.y).toBeCloseTo(2337 / 2 - 130 - 40 - 100, 6);
    expect(designArea.position.y).toBeCloseTo((94 - 130) / 2, 6);
    // No flag: the whole screen, under the notch.
    expect(background.height).toBeCloseTo(2337, 6);
    expect(background.position.y).toBeCloseTo(0, 6);
  });

  it('no insets (the editor, a desktop), or no flag: the layout it always had', () => {
    const plain = build(false);
    plain.root.applyAnchoredLayoutRecursive(TALL, DESIGN, INSETS);
    const flagged = build(true);
    flagged.root.applyAnchoredLayoutRecursive(TALL, DESIGN);
    expect(flagged.hud.position.y).toBeCloseTo(plain.hud.position.y, 6);
    expect(flagged.designArea.position.y).toBeCloseTo(plain.designArea.position.y, 6);
    expect(plain.hud.position.y).toBeCloseTo(2337 / 2 - 40 - 100, 6);
  });

  it('round-trips through the scene file as layout.safeArea', async () => {
    const { root } = build(true);
    const yaml = new SceneSaver().serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [root],
      nodeMap: new Map([[root.nodeId, root]]),
    });
    expect(yaml.match(/safeArea: true/g)).toHaveLength(2);
    const graph = await new SceneLoader(
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    ).parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as Group2D;
    const byId = (id: string) => loaded.children.find(c => (c as Group2D).nodeId === id) as Group2D;
    expect(byId('hud').layoutSafeArea).toBe(true);
    expect(byId('design-area').layoutSafeArea).toBe(true);
    expect(byId('background').layoutSafeArea).toBe(false);
    expect(new SceneSaver().serializeScene(graph)).toBe(yaml);
  });
});
