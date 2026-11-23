import type { RgbaImage } from './png.ts';

/**
 * Box radii of three passes whose sum approximates a gaussian of `sigma` (the passes' variances add
 * up to σ²; Kovesi's ideal widths, rounded to odd and split between the two nearest).
 */
export const gaussianBoxRadii = (sigma: number, passes = 3): number[] => {
  if (!(sigma > 0)) return [];
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const lowerCount = Math.round(
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) /
      (-4 * lower - 4)
  );
  return Array.from(
    { length: passes },
    (_, index) => ((index < lowerCount ? lower : upper) - 1) / 2
  );
};

/** One box pass along rows (`horizontal`) or columns, edges clamped; `from` → `to`. */
const boxPass = (
  from: Uint8Array,
  to: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean
): void => {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 4 : width * 4;
  const window = radius * 2 + 1;
  const sums = [0, 0, 0, 0];
  for (let line = 0; line < lines; line += 1) {
    const base = horizontal ? line * width * 4 : line * 4;
    const at = (index: number): number => base + Math.min(length - 1, Math.max(0, index)) * stride;
    for (let channel = 0; channel < 4; channel += 1) {
      let sum = 0;
      for (let index = -radius; index <= radius; index += 1) sum += from[at(index) + channel];
      sums[channel] = sum;
    }
    for (let index = 0; index < length; index += 1) {
      const out = base + index * stride;
      const enter = at(index + radius + 1);
      const leave = at(index - radius);
      for (let channel = 0; channel < 4; channel += 1) {
        to[out + channel] = Math.round(sums[channel] / window);
        sums[channel] += from[enter + channel] - from[leave + channel];
      }
    }
  }
};

/** The image under a gaussian blur of `sigma` px (three separable box passes); a copy. */
export const blurImage = (image: RgbaImage, sigma: number): RgbaImage => {
  const { width, height } = image;
  const current = Uint8Array.from(image.data);
  const scratch = new Uint8Array(current.length);
  for (const radius of gaussianBoxRadii(sigma)) {
    if (radius <= 0) continue;
    boxPass(current, scratch, width, height, radius, true);
    boxPass(scratch, current, width, height, radius, false);
  }
  return { width, height, data: current };
};
