import type { RgbaImage } from './png.ts';
import { flatBackground, hasTransparency, SOLID_ALPHA } from './sheet.ts';

/**
 * What `pix3 validate` measures in a PNG a scene or a `.pix3anim` uses — small, JSON-safe facts
 * (cached per file by mtime and size), from which `pixel-checks.ts` decides the warnings.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface StrayFact {
  readonly side: Side;
  /** Solid pixels. */
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Its solid pixels on the edge line of `side` — a shape cut by the edge lies along it. */
  readonly contact: number;
}

export interface PixelFacts {
  readonly width: number;
  readonly height: number;
  /** Every pixel at alpha >= 250. */
  readonly opaque: boolean;
  /**
   * For an opaque image whose border is one flat colour: that colour and the share of all pixels
   * within 24 of it (how much of the image is backdrop), and the smallest margin between the
   * pixels far from it (over 48) and the image edge, as a fraction of that side. Null otherwise.
   */
  readonly backdrop: {
    readonly color: string;
    readonly share: number;
    readonly inset: number;
  } | null;
  /** Per side: the longest run of solid pixels (alpha >= 128) along the edge line, in pixels. */
  readonly edgeRuns: Readonly<Record<Side, number>>;
  /** Solid pixels of the largest 8-connected shape (alpha > 40). */
  readonly largest: number;
  /** Shapes other than the largest that touch an edge, from 8 solid pixels up. */
  readonly strays: readonly StrayFact[];
}

const EDGE_SOLID = 128;
const MIN_STRAY = 8;

const longestRun = (length: number, solidAt: (i: number) => boolean): number => {
  let best = 0;
  let run = 0;
  for (let i = 0; i < length; i++) {
    run = solidAt(i) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
};

export function measurePixels(image: RgbaImage): PixelFacts {
  const { width, height, data } = image;
  const alpha = (x: number, y: number): number => data[(y * width + x) * 4 + 3];
  const opaque = !hasTransparency(image);

  let backdrop: PixelFacts['backdrop'] = null;
  if (opaque) {
    const flat = flatBackground(image);
    if (flat) {
      let near = 0;
      let [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let p = 0; p < width * height; p++) {
        const i = p * 4;
        const d = Math.hypot(
          data[i] - flat.color[0],
          data[i + 1] - flat.color[1],
          data[i + 2] - flat.color[2]
        );
        if (d <= 24) near++;
        if (d <= 48) continue;
        const x = p % width;
        const y = (p - x) / width;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const inset =
        x1 < 0
          ? 0
          : Math.min(x0 / width, (width - 1 - x1) / width, y0 / height, (height - 1 - y1) / height);
      const hex = flat.color.map(c => c.toString(16).padStart(2, '0')).join('');
      backdrop = {
        color: `#${hex}`,
        share: Number((near / (width * height)).toFixed(3)),
        inset: Number(inset.toFixed(3)),
      };
    }
  }

  const edgeRuns = {
    top: longestRun(width, x => alpha(x, 0) >= EDGE_SOLID),
    bottom: longestRun(width, x => alpha(x, height - 1) >= EDGE_SOLID),
    left: longestRun(height, y => alpha(0, y) >= EDGE_SOLID),
    right: longestRun(height, y => alpha(width - 1, y) >= EDGE_SOLID),
  };

  // 8-connected shapes of solid pixels; an opaque image is one shape and has no strays.
  const shapes: { size: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const labels = new Int32Array(opaque ? 0 : width * height);
  if (!opaque) {
    const n = width * height;
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (labels[start] || data[start * 4 + 3] <= SOLID_ALPHA) continue;
      const label = shapes.length + 1;
      let top = 0;
      stack[top++] = start;
      labels[start] = label;
      const shape = { size: 0, x0: width, y0: height, x1: -1, y1: -1 };
      while (top > 0) {
        const p = stack[--top];
        const x = p % width;
        const y = (p - x) / width;
        shape.size++;
        if (x < shape.x0) shape.x0 = x;
        if (x > shape.x1) shape.x1 = x;
        if (y < shape.y0) shape.y0 = y;
        if (y > shape.y1) shape.y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const q = ny * width + nx;
            if (labels[q] || data[q * 4 + 3] <= SOLID_ALPHA) continue;
            labels[q] = label;
            stack[top++] = q;
          }
        }
      }
      shapes.push(shape);
    }
  }
  const largest = shapes.reduce((best, shape) => Math.max(best, shape.size), 0);
  const largestIndex = shapes.findIndex(shape => shape.size === largest);
  const strays: StrayFact[] = [];
  shapes.forEach((shape, i) => {
    if (i === largestIndex || shape.size < MIN_STRAY) return;
    const side: Side | null =
      shape.y0 === 0
        ? 'top'
        : shape.x1 === width - 1
          ? 'right'
          : shape.y1 === height - 1
            ? 'bottom'
            : shape.x0 === 0
              ? 'left'
              : null;
    if (!side) return;
    let contact = 0;
    const along =
      side === 'top' || side === 'bottom' ? shape.x1 - shape.x0 + 1 : shape.y1 - shape.y0 + 1;
    for (let k = 0; k < along; k++) {
      const [x, y] =
        side === 'top'
          ? [shape.x0 + k, 0]
          : side === 'bottom'
            ? [shape.x0 + k, height - 1]
            : side === 'left'
              ? [0, shape.y0 + k]
              : [width - 1, shape.y0 + k];
      if (labels[y * width + x] === i + 1) contact++;
    }
    strays.push({
      side,
      size: shape.size,
      x: shape.x0,
      y: shape.y0,
      width: shape.x1 - shape.x0 + 1,
      height: shape.y1 - shape.y0 + 1,
      contact,
    });
  });
  strays.sort((a, b) => b.size - a.size);
  return { width, height, opaque, backdrop, edgeRuns, largest, strays: strays.slice(0, 8) };
}
