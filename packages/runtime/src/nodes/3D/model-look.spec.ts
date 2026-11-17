import { describe, expect, it } from 'vitest';

import {
  compareWithReference,
  describeLook,
  describeReference,
  extractPalette,
  foregroundMask,
  interiorOf,
  judgeAgainstReference,
  measureLook,
  referenceMask,
  type LookPixels,
} from './model-look';

type Rgba = readonly [number, number, number, number?];

/** A w×h image painted by `paint(x, y)` (RGBA, alpha 255 unless given). */
const image = (w: number, h: number, paint: (x: number, y: number) => Rgba): LookPixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
};

const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

const BG: Rgba = [143, 154, 166];

/** A 64×64 view whose middle 40×40 square is the model, painted by `model`. */
const view = (model: (x: number, y: number) => Rgba) => {
  const pixels = image(64, 64, (x, y) => (inBox(x, y, 12, 12, 52, 52) ? model(x, y) : BG));
  const mask = new Uint8Array(64 * 64);
  for (let y = 12; y < 52; y += 1) mask.fill(1, y * 64 + 12, y * 64 + 52);
  return { pixels, mask };
};

describe('foregroundMask / interiorOf', () => {
  it('keeps the pixels two clear colours agree on, then drops the boundary ring', () => {
    const model = (x: number, y: number): boolean => inBox(x, y, 2, 2, 6, 6);
    const a = image(8, 8, (x, y) => (model(x, y) ? [200, 50, 50] : [0, 0, 0]));
    // The antialiased edge pixel (5, 2) blends with the clear colour, so it differs too.
    const b = image(8, 8, (x, y) =>
      x === 5 && y === 2 ? [220, 90, 90] : model(x, y) ? [200, 50, 50] : [255, 255, 255]
    );
    const mask = foregroundMask(a, b);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(15);
    expect(mask[2 * 8 + 5]).toBe(0);
    const interior = interiorOf(mask, 8, 8);
    expect([...interior.keys()].filter(p => interior[p]).map(p => [p % 8, p >> 3])).toEqual([
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4],
    ]);
  });
});

describe('measureLook', () => {
  it('says "too few pixels" instead of numbers for a tiny model', () => {
    const tiny = image(64, 64, (x, y) => (inBox(x, y, 30, 30, 40, 40) ? [200, 200, 200] : BG));
    const mask = new Uint8Array(64 * 64);
    for (let y = 30; y < 40; y += 1) mask.fill(1, y * 64 + 30, y * 64 + 40);
    expect(measureLook([{ pixels: tiny, mask }])).toEqual({
      coverage: 0.024,
      samples: 64,
      note: 'too few pixels',
    });
    expect(describeLook(measureLook([{ pixels: tiny, mask }]))).toMatch(/^too few pixels \(64 px/);
  });

  it('reads a dark model as dark: near-black share over the firm threshold', () => {
    const look = measureLook([view(x => (x < 30 ? [10, 10, 12] : [60, 50, 45]))]);
    expect(look.nearBlack).toBeGreaterThan(0.4);
    expect(look.note).toContain('reads dark');
    expect(look.luminance!.p10).toBeLessThan(0.01);
  });

  it('reads a bright saturated model with no note, its saturation from the bright pixels', () => {
    const look = measureLook([view(x => (x < 30 ? [240, 160, 40] : [200, 60, 120]))]);
    expect(look.note).toBe('');
    expect(look.nearBlack).toBe(0);
    expect(look.luminance!.p50).toBeGreaterThan(0.1);
    expect(look.saturation!.share).toBe(1);
    expect(look.saturation!.median).toBeGreaterThan(0.6);
  });

  it('reads a grey model as desaturated, and a flat-shaded one as flat (a diagnostic only)', () => {
    const grey = measureLook([view(() => [150, 150, 150])]);
    expect(grey.saturation!.median).toBe(0);
    expect(grey.note).toBe('desaturated');
    expect(grey.flat).toBe(1);
    // A smooth gradient has no flat pixel; luminance is linear-light: sRGB 150 ≈ 0.305.
    const smooth = measureLook([view((x, y) => [80 + 2 * x, 70 + 2 * y, 60 + x + y])]);
    expect(smooth.flat).toBe(0);
    expect(grey.luminance!.p50).toBeCloseTo(0.305, 2);
  });

  it('judges the thresholds on exact values, not on the rounded ones it prints', () => {
    // 144 of 1444 interior pixels near-black: 9.97%, printed as 0.1 — not "reads dark".
    let dark = 0;
    const look = measureLook([
      view((x, y) =>
        x > 12 && y > 12 && x < 51 && y < 51 && dark++ < 144 ? [5, 5, 5] : [200, 200, 200]
      ),
    ]);
    expect(look.samples).toBe(1444);
    expect(look.nearBlack).toBe(0.1);
    expect(look.note).not.toContain('reads dark');
  });

  it('pools several views and reports their coverage', () => {
    const one = view(() => [150, 150, 150]);
    const look = measureLook([one, one]);
    expect(look.samples).toBe(2 * 38 * 38);
    expect(look.coverage).toBe(round(1600 / 4096));
  });
});

const round = (n: number): number => Math.round(n * 1000) / 1000;

describe('referenceMask', () => {
  const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
    (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  it('takes the alpha of a transparent reference', () => {
    const inside = disc(32, 32, 20);
    const masked = referenceMask(
      image(64, 64, (x, y) => (inside(x, y) ? [200, 80, 40] : [0, 0, 0, 0]))
    );
    expect(masked).toMatchObject({ method: 'alpha' });
    expect((masked as { coverage: number }).coverage).toBeCloseTo((Math.PI * 400) / 4096, 1);
  });

  it('keys the background from agreeing corners, keeping model pixels of that colour inside', () => {
    const ring = (x: number, y: number) => disc(32, 32, 20)(x, y) && !disc(32, 32, 6)(x, y);
    // A frame line around the image does not stop the keying.
    const frame = (x: number, y: number) => x === 0 || y === 0 || x === 63 || y === 63;
    const masked = referenceMask(
      image(64, 64, (x, y) =>
        frame(x, y) ? [20, 20, 20] : ring(x, y) ? [40, 120, 60] : [250, 250, 250]
      )
    );
    expect(masked).toMatchObject({ method: 'corners', background: '#fafafa' });
    const mask = (masked as { mask: Uint8Array }).mask;
    expect(mask[32 * 64 + 32]).toBe(1); // the hole is the background colour, not the background
    expect(mask[5 * 64 + 5]).toBe(0);
  });

  it('drops specks from a keyed mask, takes any transparency as alpha, refuses a tiny image', () => {
    const speckled = image(64, 64, (x, y) =>
      disc(32, 32, 12)(x, y) || (x === 4 && y === 40) ? [40, 120, 60] : [250, 250, 250]
    );
    const keyed = referenceMask(speckled) as { mask: Uint8Array };
    expect(keyed.mask[40 * 64 + 4]).toBe(0);
    expect(keyed.mask[32 * 64 + 32]).toBe(1);
    // A tightly cropped cut-out: almost all of it opaque, still an alpha mask.
    const cutout = image(64, 64, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : [200, 80, 40]));
    expect(referenceMask(cutout)).toMatchObject({ method: 'alpha', coverage: 1 });
    expect(referenceMask(image(8, 8, () => [0, 0, 0]))).toEqual({
      error: 'it is too small (8×8 px)',
    });
  });

  it('reports a mask it cannot trust instead of guessing', () => {
    const split = image(64, 64, x => (x < 32 ? [250, 250, 250] : [10, 10, 10]));
    expect(referenceMask(split)).toEqual({ error: expect.stringContaining('corners disagree') });
    expect(referenceMask(split, '#fafafa')).toMatchObject({ method: 'background' });
    expect(referenceMask(split, 'white')).toEqual({ error: expect.stringContaining('hex') });
    const blank = image(64, 64, () => [250, 250, 250]);
    expect(referenceMask(blank)).toEqual({ error: expect.stringContaining('almost nothing') });
  });
});

describe('compareWithReference / judgeAgainstReference', () => {
  /** A `w`×`h` box of colour `c`, `scale`× larger, somewhere on a white 128² image. */
  const boxImage = (w: number, h: number, scale: number, ox: number, c: Rgba) =>
    image(128, 128, (x, y) =>
      inBox(x, y, ox, 10, ox + w * scale, 10 + h * scale)
        ? y < 10 + (h * scale) / 2
          ? c
          : [60, 60, 60]
        : [255, 255, 255]
    );
  const asTile = (pixels: LookPixels) => {
    const masked = referenceMask(pixels);
    if ('error' in masked) throw new Error(masked.error);
    return { pixels, mask: masked.mask };
  };

  it('fits both masks to their boxes: the same shape at another size and place scores 1', () => {
    const reference = asTile(boxImage(20, 30, 3, 5, [200, 100, 50]));
    const render = asTile(boxImage(20, 30, 2, 60, [100, 50, 25]));
    const c = compareWithReference(
      reference,
      render,
      measureLook([reference]),
      measureLook([render])
    );
    expect(c).toMatchObject({ silhouetteIoU: 1, aspect: { reference: 0.667, render: 0.667 } });
    // The render's top half is darker than the reference's; the bottom half is the same.
    if ('error' in c) throw new Error(c.error);
    expect(c.bands[0].render!).toBeLessThan(c.bands[0].reference!);
    expect(c.bands[3].render!).toBeCloseTo(c.bands[3].reference!, 2);
  });

  it('gives no saturation ratio against a grey reference', () => {
    const reference = asTile(boxImage(20, 30, 3, 5, [128, 128, 128]));
    const render = asTile(boxImage(20, 30, 3, 5, [200, 100, 50]));
    const c = compareWithReference(
      reference,
      render,
      measureLook([reference]),
      measureLook([render])
    );
    expect(c).toMatchObject({ saturationRatio: null, saturationNote: 'the reference is grey' });
  });

  it('measures, compares and samples the palette, background excluded', () => {
    const reference = boxImage(30, 30, 3, 10, [200, 40, 40]);
    const render = { name: 'iso', ...asTile(boxImage(30, 30, 3, 10, [100, 20, 20])) };
    const report = judgeAgainstReference(reference, render);
    expect(report).toMatchObject({ mask: { method: 'corners' }, view: 'iso' });
    const palette = (report as { palette: { hex: string; share: number }[] }).palette;
    expect(palette.map(p => p.hex).sort()).toEqual(['#3c3c3c', '#c82828']);
    expect(describeReference(report)).toMatch(/silhouette IoU 1, .*palette #/);
    const failed = judgeAgainstReference(
      image(64, 64, x => (x < 32 ? [250, 250, 250] : [0, 0, 0])),
      render
    );
    expect(describeReference(failed)).toMatch(/^mask failed: .*nothing compared$/);
  });

  it('samples the palette deterministically', () => {
    const pixels = image(64, 64, (x, y) => [x * 4, y * 4, 128]);
    const mask = new Uint8Array(64 * 64).fill(1);
    expect(extractPalette(pixels, mask)).toEqual(extractPalette(pixels, mask));
    expect(extractPalette(pixels, mask)).toHaveLength(6);
  });
});
