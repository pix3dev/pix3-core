import type { Button2D } from '@pix3/runtime';
import { createHeadlessGame } from '@pix3/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  affineFromSamples,
  applyAffine,
  convexHull,
  fillRegion,
  hideCaptions,
  invertAffine,
  measureScreen,
  regionSides,
  type ShapeRunner,
} from './screen-checks';

describe('screen-checks maths', () => {
  it('reads an affine map from three points and inverts it', () => {
    const map = (x: number, y: number) => ({ x: 2 * x - y + 5, y: 0.5 * y - 3 });
    const affine = affineFromSamples(map)!;
    const inverse = invertAffine(affine)!;
    const there = applyAffine(affine, { x: 7, y: -4 });
    expect(there).toEqual(map(7, -4));
    const back = applyAffine(inverse, there);
    expect(back.x).toBeCloseTo(7, 9);
    expect(back.y).toBeCloseTo(-4, 9);
    expect(invertAffine({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toBeNull();
  });

  it('measures an axis-aligned area to the pixel, clipped by the screen', () => {
    const inside = (x: number, y: number) => x >= 10 && x < 130 && y >= 50 && y < 74;
    const cells = fillRegion({ x: 60, y: 60 }, 1, { width: 390, height: 844 }, inside, 1e5)!;
    expect(cells).toHaveLength(120 * 24);
    expect(regionSides(cells, 1)).toEqual({ width: 120, height: 24 });

    // Half of it off the left edge: what a finger can reach is what is on the screen.
    const clipped = (x: number, y: number) => x >= -60 && x < 60 && y >= 50 && y < 74;
    const onScreen = fillRegion({ x: 10, y: 60 }, 1, { width: 390, height: 844 }, clipped, 1e5)!;
    expect(regionSides(onScreen, 1)).toEqual({ width: 60, height: 24 });
  });

  it('measures a rotated rectangle by its own sides and a disc by its diameter', () => {
    const angle = Math.PI / 6;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const rotated = (x: number, y: number) => {
      const u = (x - 200) * cos + (y - 200) * sin;
      const v = -(x - 200) * sin + (y - 200) * cos;
      return Math.abs(u) <= 60 && Math.abs(v) <= 15;
    };
    const cells = fillRegion({ x: 200, y: 200 }, 1, { width: 400, height: 400 }, rotated, 1e5)!;
    // From the cells alone: good to a cell.
    const sampled = regionSides(cells, 1);
    expect(Math.abs(sampled.width - 120)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(sampled.height - 30)).toBeLessThanOrEqual(1.5);
    // Asked again along the two directions: to a fraction of a pixel.
    const exact = regionSides(cells, 1, rotated);
    expect(exact.width).toBeCloseTo(120, 1);
    expect(exact.height).toBeCloseTo(30, 1);

    const disc = (x: number, y: number) => Math.hypot(x - 100, y - 100) <= 20;
    const cellsOfDisc = fillRegion({ x: 100, y: 100 }, 1, { width: 200, height: 200 }, disc, 1e5)!;
    const round = regionSides(cellsOfDisc, 1, disc);
    expect(round.width).toBeCloseTo(40, 1);
    expect(round.height).toBeCloseTo(40, 1);
  });

  it('gives up past the cap and keeps the hull convex', () => {
    expect(fillRegion({ x: 5, y: 5 }, 1, { width: 100, height: 100 }, () => true, 50)).toBeNull();
    expect(fillRegion({ x: -5, y: 5 }, 1, { width: 100, height: 100 }, () => true, 50)).toBeNull();
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 1, y: 0 },
    ];
    expect(convexHull(square)).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]);
    expect(regionSides([{ x: 3, y: 3 }], 2)).toEqual({ width: 2, height: 2 });
  });
});

// A 390×844 design: a 120×24 button, a disabled one, one under a modal blocker, a 24 px caption
// and a 12 px one. Measured on a canvas of `css` CSS px at `dpr` device px per CSS px.
const scene = `version: 1.0.0
root:
  - id: root
    type: Group2D
    properties:
      width: 390
      height: 844
    children:
      - id: small
        type: Button2D
        properties: { width: 120, height: 24, label: "Go", labelFontSize: 24, transform: { position: [0, -60], scale: [1, 1], rotation: 0 } }
      - id: off
        type: Button2D
        properties: { width: 200, height: 64, label: "", transform: { position: [0, 200], scale: [1, 1], rotation: 0 } }
      - id: hidden-under
        type: Button2D
        properties: { width: 200, height: 64, label: "", transform: { position: [0, 300], scale: [1, 1], rotation: 0 } }
      - id: modal
        type: ColorRect2D
        properties: { width: 300, height: 120, color: "#000000", blocksPointerInput: true, transform: { position: [0, 300], scale: [1, 1], rotation: 0 } }
      - id: fine
        type: Label2D
        properties: { label: "fine print", labelFontSize: 12, transform: { position: [0, 100], scale: [1, 1], rotation: 0 } }
`;

/** The one target left (the disabled and the covered button are not) and its sides. */
const expectSides = (measure: ReturnType<typeof measureScreen>, width: number, height: number) => {
  expect(measure!.targets.map(target => target.node)).toEqual(['small']);
  expect(measure!.targets[0].width).toBeCloseTo(width, 1);
  expect(measure!.targets[0].height).toBeCloseTo(height, 1);
};
const fonts = (measure: ReturnType<typeof measureScreen>) =>
  measure!.texts.map(text => Number(text.fontPx.toFixed(6)));

const games: { dispose(): void }[] = [];
afterEach(() => {
  for (const game of games.splice(0)) game.dispose();
});

const measureAt = async (
  css: { width: number; height: number },
  dpr: number,
  fit?: { minScale: number }
) => {
  const game = await createHeadlessGame({
    files: { 'scenes/main.pix3scene': scene },
    viewport: { width: 390, height: 844 },
  });
  games.push(game);
  await game.start('scenes/main.pix3scene');
  (game.scene.findNode('off') as Button2D).enabled = false;
  if (fit) game.scene.setDesignFit(fit);
  // The page as the gallery sees it: a canvas of css × dpr device px filling the viewport.
  const input = game.runner.getLiveRootNodes()[0].input as unknown as {
    element: HTMLCanvasElement;
  };
  const canvas = input.element;
  canvas.width = css.width * dpr;
  canvas.height = css.height * dpr;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, ...css }) as unknown as DOMRect;
  Object.assign(window, { innerWidth: css.width, innerHeight: css.height });
  Object.defineProperty(canvas, 'clientWidth', { value: css.width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: css.height, configurable: true });
  // A frame lays the screen out (logical camera, anchors, the 2D camera) as the gallery's does.
  game.runner.renderOnce();
  return { game, measure: measureScreen(game.runner as unknown as ShapeRunner) };
};

describe('measureScreen', () => {
  for (const dpr of [1, 3]) {
    it(`measures press targets and captions in CSS px at DPR ${dpr}, by the design fit`, async () => {
      // Fixed fit on the design's own size: one design px is one CSS px.
      const full = (await measureAt({ width: 390, height: 844 }, dpr)).measure!;
      expect(full.viewport).toEqual({ width: 390, height: 844 });
      expectSides(full, 120, 24);
      // The button sits 60 design px below the centre (y up), so its box is 422 + 60 − 12.
      const box = full.targets[0].box;
      expect([box.x, box.y].map(Math.round)).toEqual([135, 470]);
      expect(full.texts.map(text => text.node)).toEqual(['small', 'fine']);
      expect(fonts(full)).toEqual([24, 12]);

      // Half the screen: the design shrinks to fit, every size halves.
      const half = (await measureAt({ width: 195, height: 422 }, dpr)).measure;
      expectSides(half, 60, 12);
      expect(fonts(half)).toEqual([12, 6]);

      // `minScale: 1` holds a design px at a CSS px: the screen shows less, sizes stay.
      const floored = (await measureAt({ width: 195, height: 422 }, dpr, { minScale: 1 })).measure;
      expectSides(floored, 120, 24);
      expect(fonts(floored)).toEqual([24, 12]);
    });
  }

  it('hides the captions for the bare frame and shows the same ones again', async () => {
    const { game } = await measureAt({ width: 390, height: 844 }, 1);
    const runner = game.runner as unknown as ShapeRunner;
    const meshes = () =>
      ['small', 'fine'].map(
        id => (game.scene.findNode(id) as unknown as { labelMesh: { visible: boolean } }).labelMesh
      );
    hideCaptions(runner, true);
    expect(meshes().map(mesh => mesh.visible)).toEqual([false, false]);
    hideCaptions(runner, false);
    expect(meshes().map(mesh => mesh.visible)).toEqual([true, true]);
    expect(measureScreen(null)).toBeNull();
  });
});
