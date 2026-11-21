import type { RgbaImage } from './png.ts';

/**
 * Pixel work behind `pix3 slice`: a flat background keyed out, a sheet cut into frames by a grid
 * or by alpha components, frames trimmed and laid out. The blob rules follow the slicer Skyways
 * used on Codex sheets (`design/tools/slice-icons.py`): a pixel is solid at alpha > 40 (generator
 * speckle and dark glow halos sit below that), parts closer than `join` pixels (Manhattan) are one
 * frame (a sparkle beside a gem), and pixels fainter than alpha 12 are dropped from a frame.
 */

/** Alpha above which a pixel is part of a frame's body. */
export const SOLID_ALPHA = 40;
/** Alpha at or below which a pixel inside a frame is haze and is cleared. */
export const HAZE_ALPHA = 12;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** True when some pixel is not opaque — the sheet came with real transparency. */
export const hasTransparency = (image: RgbaImage): boolean => {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 250) return true;
  return false;
};

/** The pixels of the sheet's outer `edge`-pixel frame, as RGB offsets into `data`. */
const borderOffsets = (image: RgbaImage, edge: number): number[] => {
  const offsets: number[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (x >= edge && y >= edge && x < image.width - edge && y < image.height - edge) continue;
      offsets.push((y * image.width + x) * 4);
    }
  }
  return offsets;
};

const colorDistance = (data: Uint8Array, i: number, key: readonly number[]): number =>
  Math.hypot(data[i] - key[0], data[i + 1] - key[1], data[i + 2] - key[2]);

/**
 * The flat background of an opaque sheet: the per-channel median of its 3-pixel border, and how
 * far (RGB distance) 90% of the border lies from it. Null when the border is not flat (a full
 * picture rather than sprites on a backdrop) — there is nothing to key.
 */
export function flatBackground(
  image: RgbaImage
): { readonly color: [number, number, number]; readonly spread: number } | null {
  const { data } = image;
  const offsets = borderOffsets(image, 3);
  const median = (c: number): number =>
    offsets.map(i => data[i + c]).sort((a, b) => a - b)[offsets.length >> 1];
  const color: [number, number, number] = [median(0), median(1), median(2)];
  const distances = offsets.map(i => colorDistance(data, i, color)).sort((a, b) => a - b);
  const spread = distances[Math.floor(distances.length * 0.99)];
  return distances[Math.floor(distances.length * 0.9)] <= 12 ? { color, spread } : null;
}

/**
 * Keys a background colour out, in place: alpha ramps from 0 at colour distance `near` to full
 * at `far`, and a partly keyed pixel has the background's share taken out of its colour, so no
 * rim of the background is left. With `fromBorder` only the background reachable from the sheet's
 * edge (through pixels closer than `far`) is keyed — a dark backdrop's colour inside the art (a
 * shadow) stays; without it every pixel of the colour goes (a chroma key, holes included).
 */
export function keyOut(
  image: RgbaImage,
  key: readonly number[],
  options: { readonly near: number; readonly far: number; readonly fromBorder: boolean }
): void {
  const { width, height, data } = image;
  const { near, far } = options;
  const n = width * height;
  let reached: Uint8Array | null = null;
  if (options.fromBorder) {
    reached = new Uint8Array(n);
    const stack = new Int32Array(n);
    let top = 0;
    const visit = (p: number): void => {
      if (reached![p] || colorDistance(data, p * 4, key) >= far) return;
      reached![p] = 1;
      stack[top++] = p;
    };
    for (const i of borderOffsets(image, 1)) visit(i / 4);
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (p >= width) visit(p - width);
      if (p < n - width) visit(p + width);
    }
  }
  for (let p = 0; p < n; p++) {
    if (reached && !reached[p]) continue;
    const i = p * 4;
    const distance = colorDistance(data, i, key);
    if (distance >= far) continue;
    const a = distance <= near ? 0 : (distance - near) / (far - near);
    if (a > 0) {
      for (let c = 0; c < 3; c++) {
        const value = (data[i + c] - key[c] * (1 - a)) / a;
        data[i + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
    data[i + 3] = Math.min(data[i + 3], Math.round(a * 255));
  }
}

/** One alpha component (after joining near parts) of a sheet. */
export interface Blob {
  /** 1-based label in {@link BlobMap.labels}. */
  readonly label: number;
  /** Solid pixels (alpha > {@link SOLID_ALPHA}) in it — its weight against speckle. */
  readonly solid: number;
  /** Bounding box of the joined region (the solid parts grown by `join`), clipped to the sheet. */
  readonly region: Box;
}

export interface BlobMap {
  readonly blobs: Blob[];
  /** Per pixel: the label of the joined region it lies in, 0 outside every region. */
  readonly labels: Int32Array;
}

/**
 * Labels the solid pixels grown by `join` (Manhattan distance, 4-connected — scipy's
 * `binary_dilation(iterations=join)` + `label`).
 */
export function findBlobs(image: RgbaImage, join: number): BlobMap {
  const { width, height, data } = image;
  const n = width * height;
  const far = 0xffff;
  const distance = new Uint16Array(n);
  for (let p = 0; p < n; p++) distance[p] = data[p * 4 + 3] > SOLID_ALPHA ? 0 : far;
  // Two-pass city-block distance transform: exact for the L1 metric.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let d = distance[p];
      if (x > 0) d = Math.min(d, distance[p - 1] + 1);
      if (y > 0) d = Math.min(d, distance[p - width] + 1);
      distance[p] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      let d = distance[p];
      if (x < width - 1) d = Math.min(d, distance[p + 1] + 1);
      if (y < height - 1) d = Math.min(d, distance[p + width] + 1);
      distance[p] = d;
    }
  }

  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const blobs: Blob[] = [];
  for (let start = 0; start < n; start++) {
    if (labels[start] || distance[start] > join) continue;
    const label = blobs.length + 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    let solid = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      if (distance[p] === 0) solid++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (q: number): void => {
        if (labels[q] || distance[q] > join) return;
        labels[q] = label;
        stack[top++] = q;
      };
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (y > 0) visit(p - width);
      if (y < height - 1) visit(p + width);
    }
    blobs.push({
      label,
      solid,
      region: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    });
  }
  return { blobs, labels };
}

/**
 * Keeps the blobs that are frames: the `count` heaviest when given, else every blob with at least
 * `minShare` of the heaviest one's solid pixels (speckle and stray glints fall far below).
 */
export function frameBlobs(
  blobs: readonly Blob[],
  options: { readonly count?: number; readonly minShare?: number }
): Blob[] {
  const heaviest = [...blobs].sort((a, b) => b.solid - a.solid || a.label - b.label);
  if (options.count !== undefined) return heaviest.slice(0, options.count);
  const floor = (heaviest[0]?.solid ?? 0) * (options.minShare ?? 0.01);
  return heaviest.filter(blob => blob.solid > 0 && blob.solid >= floor);
}

/**
 * Reading order: rows by the box's vertical centre — a box starts a new row when its centre lies
 * below the bottom of every box already in the row — then left to right by centre.
 */
export function readingOrder<T extends { readonly region: Box }>(items: readonly T[]): T[] {
  const centreY = (item: T): number => item.region.y + item.region.height / 2;
  const centreX = (item: T): number => item.region.x + item.region.width / 2;
  const rows: T[][] = [];
  for (const item of [...items].sort((a, b) => centreY(a) - centreY(b))) {
    const row = rows[rows.length - 1];
    const bottom = row ? Math.max(...row.map(r => r.region.y + r.region.height)) : -Infinity;
    if (row && centreY(item) <= bottom) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap(row => row.sort((a, b) => centreX(a) - centreX(b)));
}

/** A copy of `box` of the image; pixels outside the image are transparent. */
export function crop(image: RgbaImage, box: Box): RgbaImage {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const sy = box.y + y;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < box.width; x++) {
      const sx = box.x + x;
      if (sx < 0 || sx >= image.width) continue;
      const s = (sy * image.width + sx) * 4;
      data.set(image.data.subarray(s, s + 4), (y * box.width + x) * 4);
    }
  }
  return { width: box.width, height: box.height, data };
}

/** Bounding box of the pixels with alpha above `alphaMin`, or null when there are none. */
export function contentBox(image: RgbaImage, alphaMin: number): Box | null {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] <= alphaMin) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Clears (all four channels) every pixel at or below {@link HAZE_ALPHA}, in place. */
export function clearHaze(image: RgbaImage): void {
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] <= HAZE_ALPHA) image.data.fill(0, i, i + 4);
  }
}

/**
 * One blob as its own image: its region cut out, the neighbours' pixels inside the box and the
 * haze cleared, trimmed to what is left. `box` is where that trimmed image sits on the sheet.
 */
export function extractBlob(
  image: RgbaImage,
  map: BlobMap,
  blob: Blob
): { readonly image: RgbaImage; readonly box: Box } | null {
  const region = crop(image, blob.region);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const label = map.labels[(blob.region.y + y) * image.width + blob.region.x + x];
      if (label !== blob.label)
        region.data.fill(0, (y * region.width + x) * 4, (y * region.width + x) * 4 + 4);
    }
  }
  clearHaze(region);
  const trim = contentBox(region, 0);
  if (!trim) return null;
  return {
    image: crop(region, trim),
    box: {
      x: blob.region.x + trim.x,
      y: blob.region.y + trim.y,
      width: trim.width,
      height: trim.height,
    },
  };
}

/** The cells of a `cols` × `rows` grid over the sheet, row by row (edges rounded). */
export function gridCells(width: number, height: number, cols: number, rows: number): Box[] {
  const cells: Box[] = [];
  for (let r = 0; r < rows; r++) {
    const y = Math.round((r * height) / rows);
    const y1 = Math.round(((r + 1) * height) / rows);
    for (let c = 0; c < cols; c++) {
      const x = Math.round((c * width) / cols);
      const x1 = Math.round(((c + 1) * width) / cols);
      cells.push({ x, y, width: x1 - x, height: y1 - y });
    }
  }
  return cells;
}

/**
 * The image placed on a transparent `width` × `height` canvas: centred horizontally, its bottom
 * `pad` pixels above the canvas bottom (frames of one animation share the ground line).
 */
export function placeOnCanvas(
  image: RgbaImage,
  width: number,
  height: number,
  pad: number
): RgbaImage {
  const box = {
    x: -Math.floor((width - image.width) / 2),
    y: -(height - pad - image.height),
    width,
    height,
  };
  return crop(image, box);
}
