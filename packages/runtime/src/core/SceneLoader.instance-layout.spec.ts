import { describe, expect, it } from 'vitest';
import { createHeadlessGame } from '../testing/headless-game';
import type { Node2D } from '../nodes/Node2D';

// The overlay shape the kit prescribes: a stretched root under a CanvasLayer2D, instanced from
// scenes/ui/, with a stretched dimmer and a flow column inside. A prefab clone is rebuilt from
// schema values, which spell `layout:` / `flow:` as flat inspector keys the loader never read, so
// every node of an instance lost its anchors (the dimmer stayed 100×100).
const overlay = `version: 1.0.0
root:
  - id: result-root
    type: Group2D
    name: Result Root
    properties:
      initiallyVisible: false
      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch, left: 0, right: 0, top: 0, bottom: 0 }
    children:
      - id: dim
        type: ColorRect2D
        name: Dim
        properties:
          color: "#000000"
          layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch, left: 0, right: 0, top: 0, bottom: 0 }
      - id: column
        type: Group2D
        name: Column
        properties:
          width: 400
          height: 600
          flow: { enabled: true, gap: 10 }
`;

const main = `version: 1.0.0
root:
  - id: hud
    type: CanvasLayer2D
    name: HUD
    properties:
      width: 1920
      height: 1080
      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch, left: 0, right: 0, top: 0, bottom: 0 }
    children:
      - id: result
        instance: res://scenes/ui/result.pix3scene
`;

describe('SceneLoader: an instanced prefab keeps its layout and flow', () => {
  it('a stretched child of an instance under a CanvasLayer2D fills the layer', async () => {
    const game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': main, 'scenes/ui/result.pix3scene': overlay },
    });
    await game.start('scenes/main.pix3scene');
    await game.step(2);

    const root = game.scene.findNode('result') as Node2D & { width: number; height: number };
    const dim = game.scene.findNode('dim') as Node2D & { width: number; height: number };
    const column = game.scene.findNode('column') as Node2D;
    expect(root.getLayoutConfig()).toMatchObject({ enabled: true, horizontalAlign: 'stretch' });
    expect([root.width, root.height]).toEqual([1920, 1080]);
    expect([dim.width, dim.height]).toEqual([1920, 1080]);
    expect(column.flow).toMatchObject({ enabled: true, gap: 10 });
    expect(game.errors).toEqual([]);
    game.dispose();
  });
});
