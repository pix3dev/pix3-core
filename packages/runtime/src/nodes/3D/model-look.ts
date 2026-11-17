/**
 * How a rendered model reads — dark, desaturated, flat — and how it compares with a reference
 * image, in plain image maths over RGBA buffers (no DOM, no three.js), for `pix3 render` and the
 * editor bridge's `pix3_render_model`. Every number is a hint for the agent's own judgement, never
 * a pass/fail: a high silhouette score does not prove the form, and low-poly faces are flat on
 * purpose.
 *
 * Conventions: pixels are canvas `ImageData` (row-major RGBA, sRGB-encoded 8-bit). Luminance is
 * linear-light Rec.709 (0..1, mid grey `#808080` ≈ 0.22); saturation is HSV saturation of the sRGB
 * values. Everything is measured inside a foreground mask with its 1-px boundary ring removed, and
 * reports how many pixels it stood on.
 */

export interface LookPixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, sRGB 8-bit. */
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** A rendered view and which of its pixels are the model's (1) — see `foregroundMask`. */
export interface LookTile {
  readonly pixels: LookPixels;
  readonly mask: Uint8Array;
}

/** Below this many interior pixels the numbers say nothing: "too few pixels" instead. */
const LOOK_MIN_SAMPLES = 400;
/** Linear luminance below which a pixel counts as near-black (sRGB ≈ 25/255). */
const NEAR_BLACK_LUMINANCE = 0.01;
/** Near-black share at or above which a model "reads dark" (the one firm threshold). */
const NEAR_BLACK_DARK_SHARE = 0.1;
/** Median linear luminance below which a model "reads dim" (soft; calibrated on Skyways). */
const DIM_MEDIAN_LUMINANCE = 0.06;
/** Only pixels at least this bright (linear) carry a saturation worth reading. */
const SATURATION_MIN_LUMINANCE = 0.05;
/** Median saturation below which a model "reads desaturated" (soft). */
const DESATURATED_MEDIAN = 0.2;
/** Saturation is read only when at least this share of the samples is bright enough to carry one. */
const SATURATION_MIN_SHARE = 0.1;
/** A reference this grey (median saturation) gets no saturation ratio. */
const GREY_REFERENCE_SATURATION = 0.08;

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const luminanceAt = (d: LookPixels['data'], i: number): number =>
  0.2126 * SRGB_TO_LINEAR[d[i]] +
  0.7152 * SRGB_TO_LINEAR[d[i + 1]] +
  0.0722 * SRGB_TO_LINEAR[d[i + 2]];

/** Rec.709 luma of the encoded values, 0..255 — what "looks the same" means for the flat share. */
const lumaAt = (d: LookPixels['data'], i: number): number =>
  0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

const saturationAt = (d: LookPixels['data'], i: number): number => {
  const max = Math.max(d[i], d[i + 1], d[i + 2]);
  return max === 0 ? 0 : (max - Math.min(d[i], d[i + 1], d[i + 2])) / max;
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const quantile = (sorted: Float32Array, q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

// --- masks ---------------------------------------------------------------------------------------

/**
 * The model's pixels, exactly: the same view rendered twice against two different clear colours.
 * A pixel the model fully covers is identical in both; background and the partly covered
 * (antialiased) edge differ.
 */
export function foregroundMask(a: LookPixels, b: LookPixels, tolerance = 2): Uint8Array {
  const mask = new Uint8Array(a.width * a.height);
  for (let p = 0, i = 0; p < mask.length; p += 1, i += 4) {
    mask[p] =
      Math.abs(a.data[i] - b.data[i]) <= tolerance &&
      Math.abs(a.data[i + 1] - b.data[i + 1]) <= tolerance &&
      Math.abs(a.data[i + 2] - b.data[i + 2]) <= tolerance
        ? 1
        : 0;
  }
  return mask;
}

/** The mask without its boundary ring: a pixel stays when it and its four neighbours are in. */
export function interiorOf(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1, p = y * width + 1; x < width - 1; x += 1, p += 1) {
      out[p] = mask[p] & mask[p - 1] & mask[p + 1] & mask[p - width] & mask[p + width];
    }
  }
  return out;
}

const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(o => parseInt(h.slice(o, o + 2), 16)) as [number, number, number];
};

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** Background keying: colour distance (sRGB, 0..441) under which a pixel is the background. */
const KEY_TOLERANCE = 40;
/** The four corners must agree this closely to be taken as the background. */
const CORNER_AGREEMENT = 24;

export type ReferenceMask =
  | {
      readonly mask: Uint8Array;
      readonly method: 'alpha' | 'corners' | 'background';
      /** The keyed colour (corners / background). */
      readonly background?: string;
      /** Share of the image the mask covers. */
      readonly coverage: number;
    }
  | { readonly error: string };

/**
 * The reference's foreground: from its alpha when it has a transparent background; else the
 * background colour `background` (hex) when given; else the colour of its four corners when they
 * agree. A keyed background is flood-filled from the border, so the model's own pixels of that
 * colour stay. A mask that cannot be trusted is an `error`, never a guess.
 */
export function referenceMask(pixels: LookPixels, background?: string): ReferenceMask {
  const { width, height, data } = pixels;
  const total = width * height;
  if (width < 16 || height < 16) return { error: `it is too small (${width}×${height} px)` };
  let transparent = false;
  for (let i = 3; i < data.length && !transparent; i += 4) transparent = data[i] < 128;
  let mask: Uint8Array;
  let method: 'alpha' | 'corners' | 'background';
  let key: [number, number, number] | null = null;
  if (transparent) {
    method = 'alpha';
    mask = new Uint8Array(total);
    for (let p = 0; p < total; p += 1) mask[p] = data[p * 4 + 3] >= 128 ? 1 : 0;
  } else {
    if (background !== undefined) {
      key = parseHex(background);
      if (!key) return { error: `--reference-background takes a hex colour, not "${background}"` };
      method = 'background';
    } else {
      const patch = borderBand(width, height);
      // Each corner's patch is inset by its own size, past any frame line around the image.
      const corners = [
        [patch, patch],
        [width - 2 * patch, patch],
        [patch, height - 2 * patch],
        [width - 2 * patch, height - 2 * patch],
      ].map(([x0, y0]) => {
        const sum = [0, 0, 0];
        for (let y = y0; y < y0 + patch; y += 1) {
          for (let x = x0; x < x0 + patch; x += 1) {
            for (let c = 0; c < 3; c += 1) sum[c] += data[(y * width + x) * 4 + c];
          }
        }
        return sum.map(s => s / (patch * patch)) as [number, number, number];
      });
      const mean = [0, 1, 2].map(c => corners.reduce((s, k) => s + k[c], 0) / 4) as [
        number,
        number,
        number,
      ];
      if (
        corners.some(
          k => Math.hypot(k[0] - mean[0], k[1] - mean[1], k[2] - mean[2]) > CORNER_AGREEMENT
        )
      ) {
        return {
          error: `its corners disagree (${corners.map(k => toHex(...k)).join(' ')}), so there is no background to key — pass --reference-background <hex> or use an image with a transparent background`,
        };
      }
      key = mean;
      method = 'corners';
    }
    mask = dropSpecks(keyBackground(pixels, key), width, height);
  }
  let covered = 0;
  for (let p = 0; p < total; p += 1) covered += mask[p];
  const coverage = covered / total;
  const keyed = key ? ` (background ${toHex(...key)})` : '';
  if (coverage < 0.005)
    return { error: `the ${method} mask${keyed} left almost nothing of the image` };
  if (key && coverage > 0.98)
    return { error: `the ${method} mask${keyed} removed almost nothing — is that the background?` };
  return {
    mask,
    method,
    ...(key ? { background: toHex(...key) } : {}),
    coverage: round3(coverage),
  };
}

/**
 * A keyed mask without its specks (JPEG ringing, dust): 4-connected foreground pieces smaller than
 * 0.05% of the image, which would otherwise stretch the bounding box everything is fitted to.
 */
function dropSpecks(mask: Uint8Array, width: number, height: number): Uint8Array {
  const min = Math.max(4, Math.round(width * height * 0.0005));
  const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const piece = [start];
    seen[start] = 1;
    for (let n = 0; n < piece.length; n += 1) {
      const p = piece[n];
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < mask.length && mask[q] && !seen[q]) {
          seen[q] = 1;
          piece.push(q);
        }
      }
    }
    if (piece.length < min) for (const p of piece) mask[p] = 0;
  }
  return mask;
}

/** The width of the image's border band read for the background (3% of the shorter side). */
const borderBand = (width: number, height: number): number =>
  Math.max(2, Math.round(Math.min(width, height) * 0.03));

/** Foreground = not reachable from the border through pixels within KEY_TOLERANCE of `key`. */
function keyBackground(pixels: LookPixels, key: [number, number, number]): Uint8Array {
  const { width, height, data } = pixels;
  const total = width * height;
  const background = new Uint8Array(total);
  const near = (p: number): boolean =>
    Math.hypot(data[p * 4] - key[0], data[p * 4 + 1] - key[1], data[p * 4 + 2] - key[2]) <=
    KEY_TOLERANCE;
  const stack: number[] = [];
  const push = (p: number): void => {
    if (!background[p] && near(p)) {
      background[p] = 1;
      stack.push(p);
    }
  };
  // Seeds: the matching pixels of a border band, so a frame line around the image does not wall
  // the background off.
  const band = borderBand(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < band || y < band || x >= width - band || y >= height - band) push(y * width + x);
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < total - width) push(p + width);
  }
  return background.map(b => 1 - b);
}

// --- the look ------------------------------------------------------------------------------------

export interface LookStats {
  /** Share of the tiles the model covers. */
  readonly coverage: number;
  /** Interior pixels measured (the mask without its boundary ring). */
  readonly samples: number;
  /** `too few pixels`, or what the numbers say (`reads dark`, `reads dim`, `desaturated`), or ''. */
  readonly note: string;
  /** Linear-light luminance percentiles. */
  readonly luminance?: { readonly p10: number; readonly p50: number; readonly p90: number };
  /** Share of samples under NEAR_BLACK_LUMINANCE. */
  readonly nearBlack?: number;
  /** Median HSV saturation of the samples bright enough to carry one, and their share. */
  readonly saturation?: { readonly median: number; readonly share: number };
  /** Share of samples whose right and lower neighbours have the same luma (±1/255). Diagnostic. */
  readonly flat?: number;
}

/** The look of one or more rendered views, pooled over their interior pixels. */
export function measureLook(tiles: readonly LookTile[]): LookStats {
  let area = 0;
  let covered = 0;
  const lum: number[] = [];
  const sat: number[] = [];
  let nearBlack = 0;
  let flat = 0;
  for (const { pixels, mask } of tiles) {
    const { width, height, data } = pixels;
    area += width * height;
    for (let p = 0; p < mask.length; p += 1) covered += mask[p];
    const interior = interiorOf(mask, width, height);
    for (let p = 0; p < interior.length; p += 1) {
      if (!interior[p]) continue;
      const i = p * 4;
      const y = luminanceAt(data, i);
      lum.push(y);
      if (y < NEAR_BLACK_LUMINANCE) nearBlack += 1;
      if (y >= SATURATION_MIN_LUMINANCE) sat.push(saturationAt(data, i));
      const here = lumaAt(data, i);
      if (
        Math.abs(lumaAt(data, i + 4) - here) <= 1 &&
        Math.abs(lumaAt(data, i + width * 4) - here) <= 1
      )
        flat += 1;
    }
  }
  const coverage = area > 0 ? round3(covered / area) : 0;
  const samples = lum.length;
  if (samples < LOOK_MIN_SAMPLES) return { coverage, samples, note: 'too few pixels' };
  const sortedLum = Float32Array.from(lum).sort();
  const sortedSat = Float32Array.from(sat).sort();
  // Thresholds read the exact values; only the reported numbers are rounded.
  const p50 = quantile(sortedLum, 0.5);
  const saturation = { median: quantile(sortedSat, 0.5), share: sat.length / samples };
  const notes: string[] = [];
  if (nearBlack / samples >= NEAR_BLACK_DARK_SHARE) notes.push('reads dark');
  else if (p50 < DIM_MEDIAN_LUMINANCE) notes.push('reads dim');
  if (saturationReadable(saturation) && saturation.median < DESATURATED_MEDIAN)
    notes.push('desaturated');
  return {
    coverage,
    samples,
    note: notes.join(', '),
    luminance: {
      p10: round3(quantile(sortedLum, 0.1)),
      p50: round3(p50),
      p90: round3(quantile(sortedLum, 0.9)),
    },
    nearBlack: round3(nearBlack / samples),
    saturation: { median: round3(saturation.median), share: round3(saturation.share) },
    flat: round3(flat / samples),
  };
}

const saturationReadable = (
  s: LookStats['saturation']
): s is NonNullable<LookStats['saturation']> => s !== undefined && s.share >= SATURATION_MIN_SHARE;

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** One line: what the look stats say, with the numbers and the colour spaces they are in. */
export function describeLook(look: LookStats): string {
  const where = `${look.samples} px inside the mask, ${pct(look.coverage)} of the tiles`;
  if (!look.luminance) return `${look.note} (${where})`;
  const s = look.saturation!;
  return (
    `${look.note ? `${look.note} — ` : ''}luminance p10/p50/p90 ${look.luminance.p10}/${look.luminance.p50}/${look.luminance.p90} (linear), ` +
    `near-black ${pct(look.nearBlack!)}, saturation ${s.median} (HSV of sRGB, median of the ${pct(s.share)} bright enough), ` +
    `flat ${pct(look.flat!)} (diagnostic); ${where}`
  );
}

// --- against a reference -------------------------------------------------------------------------

/** Cells per side of the lattice both masks are fitted to before comparing. */
const FIT_GRID = 64;
const BANDS = ['top', 'upper', 'lower', 'bottom'] as const;

interface Fitted {
  readonly solid: Uint8Array;
  /** Mean linear luminance of the cell's interior pixels, NaN when it has none. */
  readonly luminance: Float32Array;
  /** Bounding box width / height. */
  readonly aspect: number;
}

/** The mask's bounding box resampled to FIT_GRID² cells (scale and position no longer matter). */
function fitToBox(pixels: LookPixels, mask: Uint8Array): Fitted | null {
  const { width, height, data } = pixels;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const interior = interiorOf(mask, width, height);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const solid = new Uint8Array(FIT_GRID * FIT_GRID);
  const luminance = new Float32Array(FIT_GRID * FIT_GRID).fill(NaN);
  for (let gy = 0; gy < FIT_GRID; gy += 1) {
    const ys = y0 + Math.floor((gy * bh) / FIT_GRID);
    const ye = Math.max(ys + 1, y0 + Math.floor(((gy + 1) * bh) / FIT_GRID));
    for (let gx = 0; gx < FIT_GRID; gx += 1) {
      const xs = x0 + Math.floor((gx * bw) / FIT_GRID);
      const xe = Math.max(xs + 1, x0 + Math.floor(((gx + 1) * bw) / FIT_GRID));
      let cells = 0;
      let inMask = 0;
      let sum = 0;
      let lit = 0;
      for (let y = ys; y < ye; y += 1) {
        for (let x = xs; x < xe; x += 1) {
          const p = y * width + x;
          cells += 1;
          inMask += mask[p];
          if (interior[p]) {
            sum += luminanceAt(data, p * 4);
            lit += 1;
          }
        }
      }
      const c = gy * FIT_GRID + gx;
      solid[c] = inMask * 2 > cells ? 1 : 0;
      if (lit > 0) luminance[c] = sum / lit;
    }
  }
  return { solid, luminance, aspect: round3(bw / bh) };
}

export interface ReferenceComparison {
  /** Intersection over union of the two fitted silhouettes (0..1). */
  readonly silhouetteIoU: number;
  /** Bounding box width / height of each. */
  readonly aspect: { readonly reference: number; readonly render: number };
  /** Mean linear luminance by height band (top → bottom) over cells solid in both. */
  readonly bands: readonly {
    readonly band: (typeof BANDS)[number];
    readonly reference: number | null;
    readonly render: number | null;
    readonly cells: number;
  }[];
  /** Render / reference median saturation; null for a grey reference (`saturationNote`). */
  readonly saturationRatio: number | null;
  readonly saturationNote?: string;
}

/** The render (one view) against the reference: both masks fitted to their own boxes first. */
export function compareWithReference(
  reference: LookTile,
  render: LookTile,
  referenceLook: LookStats,
  renderLook: LookStats
): ReferenceComparison | { error: string } {
  const a = fitToBox(reference.pixels, reference.mask);
  const b = fitToBox(render.pixels, render.mask);
  if (!a || !b) return { error: `${a ? 'the render' : 'the reference'} has no foreground` };
  let both = 0;
  let either = 0;
  for (let c = 0; c < a.solid.length; c += 1) {
    both += a.solid[c] & b.solid[c];
    either += a.solid[c] | b.solid[c];
  }
  const rowsPerBand = FIT_GRID / BANDS.length;
  const bands = BANDS.map((band, n) => {
    let ra = 0;
    let rb = 0;
    let cells = 0;
    for (let c = n * rowsPerBand * FIT_GRID; c < (n + 1) * rowsPerBand * FIT_GRID; c += 1) {
      if (
        !(a.solid[c] && b.solid[c]) ||
        Number.isNaN(a.luminance[c]) ||
        Number.isNaN(b.luminance[c])
      )
        continue;
      ra += a.luminance[c];
      rb += b.luminance[c];
      cells += 1;
    }
    return {
      band,
      reference: cells ? round3(ra / cells) : null,
      render: cells ? round3(rb / cells) : null,
      cells,
    };
  });
  const refSat = referenceLook.saturation;
  const renSat = renderLook.saturation;
  const saturationNote = !refSat
    ? 'too few pixels in the reference'
    : !saturationReadable(refSat)
      ? 'too little of the reference is bright enough'
      : refSat.median < GREY_REFERENCE_SATURATION
        ? 'the reference is grey'
        : !renSat
          ? 'too few pixels in the render'
          : !saturationReadable(renSat)
            ? 'too little of the render is bright enough'
            : undefined;
  return {
    silhouetteIoU: either ? round3(both / either) : 0,
    aspect: { reference: a.aspect, render: b.aspect },
    bands,
    saturationRatio: saturationNote ? null : round3(renSat!.median / refSat!.median),
    ...(saturationNote ? { saturationNote } : {}),
  };
}

// --- palette -------------------------------------------------------------------------------------

const srgbToLab = (r: number, g: number, b: number): [number, number, number] => {
  const lr = SRGB_TO_LINEAR[r];
  const lg = SRGB_TO_LINEAR[g];
  const lb = SRGB_TO_LINEAR[b];
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
  const fy = f(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
  const fz = f((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

/**
 * The main colours inside the mask: k-means in CIELAB over up to 20 000 sampled pixels, seeded
 * deterministically, each colour the mean sRGB of its pixels; largest share first, under 2% dropped.
 */
export function extractPalette(
  pixels: LookPixels,
  mask: Uint8Array,
  k = 6
): { hex: string; share: number }[] {
  const interior = interiorOf(mask, pixels.width, pixels.height);
  const indices: number[] = [];
  for (let p = 0; p < interior.length; p += 1) if (interior[p]) indices.push(p * 4);
  if (indices.length === 0) return [];
  const stride = Math.max(1, Math.ceil(indices.length / 20000));
  const samples = indices.filter((_, n) => n % stride === 0);
  const { data } = pixels;
  const lab = samples.map(i => srgbToLab(data[i], data[i + 1], data[i + 2]));
  const d2 = (p: number[], q: number[]): number =>
    (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  // k-means++ with a fixed LCG, so the same image always gives the same palette.
  let seed = 12345;
  const random = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const centres: number[][] = [lab[0]];
  const nearest = lab.map(p => d2(p, centres[0]));
  while (centres.length < Math.min(k, lab.length)) {
    const total = nearest.reduce((s, v) => s + v, 0);
    if (total === 0) break;
    let pick = random() * total;
    let n = 0;
    while (n < lab.length - 1 && (pick -= nearest[n]) > 0) n += 1;
    centres.push(lab[n]);
    lab.forEach((p, m) => (nearest[m] = Math.min(nearest[m], d2(p, lab[n]))));
  }
  const assign = new Int32Array(lab.length);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    lab.forEach((p, m) => {
      let best = 0;
      for (let c = 1; c < centres.length; c += 1)
        if (d2(p, centres[c]) < d2(p, centres[best])) best = c;
      assign[m] = best;
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    lab.forEach((p, m) => {
      const s = sums[assign[m]];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3] += 1;
    });
    sums.forEach((s, c) => s[3] && (centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
  }
  const rgb = centres.map(() => [0, 0, 0, 0]);
  samples.forEach((i, m) => {
    const s = rgb[assign[m]];
    s[0] += data[i];
    s[1] += data[i + 1];
    s[2] += data[i + 2];
    s[3] += 1;
  });
  return rgb
    .filter(s => s[3] / samples.length >= 0.02)
    .sort((p, q) => q[3] - p[3])
    .map(s => ({
      hex: toHex(s[0] / s[3], s[1] / s[3], s[2] / s[3]),
      share: round3(s[3] / samples.length),
    }));
}

// --- the whole reference report ------------------------------------------------------------------

export type ReferenceReport =
  | { readonly mask: { readonly error: string } }
  | {
      readonly mask: {
        readonly method: string;
        readonly background?: string;
        readonly coverage: number;
      };
      readonly look: LookStats;
      /** The view compared (the render's first). */
      readonly view: string;
      readonly comparison: ReferenceComparison | { readonly error: string };
      readonly palette: { hex: string; share: number }[];
    };

/** Mask the reference, measure it, compare it with the first rendered view, sample its palette. */
export function judgeAgainstReference(
  reference: LookPixels,
  render: LookTile & { readonly name: string },
  background?: string
): ReferenceReport {
  const masked = referenceMask(reference, background);
  if ('error' in masked) return { mask: { error: masked.error } };
  const { mask, ...how } = masked;
  const tile = { pixels: reference, mask };
  const look = measureLook([tile]);
  return {
    mask: how,
    look,
    view: render.name,
    comparison: compareWithReference(tile, render, look, measureLook([render])),
    palette: extractPalette(reference, mask),
  };
}

/** One line for the reference: mask, comparison, palette — all hints. */
export function describeReference(report: ReferenceReport): string {
  if ('error' in report.mask) return `mask failed: ${report.mask.error}; nothing compared`;
  const r = report as Extract<ReferenceReport, { look: LookStats }>;
  const m = r.mask;
  const parts = [`mask ${m.method}${m.background ? ` ${m.background}` : ''} (${pct(m.coverage)})`];
  if (!r.look.luminance) parts.push(`the reference has too few pixels (${r.look.samples})`);
  else
    parts.push(
      `its luminance p50 ${r.look.luminance.p50}, saturation ${r.look.saturation!.median}`
    );
  const c = r.comparison;
  if ('error' in c) parts.push(`not compared: ${c.error}`);
  else {
    parts.push(
      `vs ${r.view}: silhouette IoU ${c.silhouetteIoU}, aspect ${c.aspect.reference} vs ${c.aspect.render}`,
      `luminance by height ref/render ${c.bands
        .map(b => `${b.band} ${b.reference ?? '–'}/${b.render ?? '–'}`)
        .join(', ')}`,
      c.saturationRatio === null
        ? `saturation ratio: ${c.saturationNote ?? 'n/a'}`
        : `saturation ×${c.saturationRatio}`
    );
  }
  if (r.palette.length)
    parts.push(`palette ${r.palette.map(p => `${p.hex} ${pct(p.share)}`).join(' ')}`);
  return `${parts.join('; ')} (hints, not a verdict)`;
}
