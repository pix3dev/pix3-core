import { describe, expect, it } from 'vitest';
import { createHeadlessGame } from '../testing/headless-game';
import type { Node2D } from '../nodes/Node2D';

// Skyways: a 1920×1080 HUD over a 3D map, opened on a 375×667 phone, drew a design pixel at
// 0.2 CSS px — icons of 12 px. `adaptive` fits the design turned the screen's way.
const main = `version: 1.0.0
root:
  - id: hud
    type: CanvasLayer2D
    name: HUD
    properties:
      width: 1920
      height: 1080
      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch, left: 0, right: 0, top: 0, bottom: 0 }
`;

type RunnerInternals = {
  updateViewportSize(cssWidth: number, cssHeight: number): boolean;
  reflowRoot2DNodes(): void;
};

describe('SceneService.setDesignFit', () => {
  it('fits a landscape design to a portrait screen by its short side when adaptive', async () => {
    const game = await createHeadlessGame({ files: { 'scenes/main.pix3scene': main } });
    await game.start('scenes/main.pix3scene');
    // The headless loop does not render; drive the two steps a frame takes on a resize.
    const runner = game.runner as unknown as RunnerInternals;
    const resize = (width: number, height: number) => {
      runner.updateViewportSize(width, height);
      runner.reflowRoot2DNodes();
    };
    const hud = game.scene.findNode('hud') as Node2D & { width: number; height: number };

    // fixed (default): the whole 1920 fits the 375 px width — 0.195 CSS px per design px.
    resize(375, 667);
    expect(game.scene.getLogicalCameraSize().width).toBe(1920);

    game.scene.setDesignFit({ orientation: 'adaptive' });
    resize(375, 667);
    const portrait = game.scene.getLogicalCameraSize();
    expect(portrait.width).toBe(1080);
    expect(portrait.height).toBeCloseTo((1080 * 667) / 375, 3);
    expect([hud.width, Math.round(hud.height)]).toEqual([1080, 1921]);

    // A floor of 0.45 CSS px per design px: the phone shows 833 design px across, not 1080.
    game.scene.setDesignFit({ minScale: 0.45 });
    resize(375, 667);
    expect(game.scene.getLogicalCameraSize().width).toBeCloseTo(375 / 0.45, 3);
    expect(hud.width).toBeCloseTo(375 / 0.45, 3);

    // Back on a landscape screen the design is used as authored.
    resize(1280, 720);
    expect(game.scene.getLogicalCameraSize()).toEqual({ width: 1920, height: 1080 });
    expect(game.errors).toEqual([]);
    game.dispose();
  });
});
