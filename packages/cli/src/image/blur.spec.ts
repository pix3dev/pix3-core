// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { blurImage, gaussianBoxRadii } from './blur.ts';
import type { RgbaImage } from './png.ts';

const grey = (
  width: number,
  height: number,
  value: (x: number, y: number) => number
): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const v = value(x, y);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  return { width, height, data };
};

const at = (image: RgbaImage, x: number, y: number): number =>
  image.data[(y * image.width + x) * 4];

describe('blurImage', () => {
  it('splits σ into three box passes whose variances add up to σ²', () => {
    for (const sigma of [1, 3.3, 8]) {
      const radii = gaussianBoxRadii(sigma);
      expect(radii).toHaveLength(3);
      // A box of width w = 2r + 1 has variance (w² − 1) / 12.
      const variance = radii.reduce((sum, r) => sum + ((2 * r + 1) ** 2 - 1) / 12, 0);
      expect(Math.abs(Math.sqrt(variance) - sigma)).toBeLessThan(0.5);
    }
    expect(gaussianBoxRadii(0)).toEqual([]);
  });

  it('keeps a flat picture flat and spreads a dot symmetrically, its light kept', () => {
    const flat = grey(20, 10, () => 90);
    expect(blurImage(flat, 3).data).toEqual(flat.data);

    const dot = grey(41, 41, (x, y) => (x >= 18 && x <= 22 && y >= 18 && y <= 22 ? 250 : 0));
    const blurred = blurImage(dot, 3);
    expect(at(blurred, 20, 20)).toBeLessThan(250);
    expect(at(blurred, 20, 20)).toBeGreaterThan(at(blurred, 20, 26));
    expect(at(blurred, 14, 20)).toBe(at(blurred, 26, 20));
    expect(at(blurred, 20, 14)).toBe(at(blurred, 20, 26));
    expect(at(blurred, 0, 0)).toBe(0);
    const light = (image: RgbaImage) =>
      Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4]).reduce(
        (sum, v) => sum + v,
        0
      );
    expect(Math.abs(light(blurred) - light(dot)) / light(dot)).toBeLessThan(0.05);
    // A copy: the source is untouched.
    expect(at(dot, 20, 20)).toBe(250);
  });
});
