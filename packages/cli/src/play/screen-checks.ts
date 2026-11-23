/**
 * The checks `pix3 play --screens` makes on each picture: a press target under 44 CSS px on its
 * short side, a caption under 16 CSS px, a caption under 4.5:1 contrast (3:1 from 24 CSS px). The
 * sizes come measured from the page (`packages/vite-plugin/player/debug/screen-checks.ts`); the
 * contrast is read here from two pictures of one paused frame, with and without the captions.
 * Warnings, not errors: a board of cells is allowed under 44 px when the report says why.
 */

import type { RgbaImage } from '../image/png.ts';

export const TAP_MIN_PX = 44;
export const TEXT_MIN_PX = 16;
/** From this font size (CSS px) a caption is large text: 3:1 is enough. */
export const LARGE_TEXT_PX = 24;
export const CONTRAST_MIN = 4.5;
export const CONTRAST_MIN_LARGE = 3;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Named {
  readonly node: string;
  readonly type: string;
  readonly name: string;
  readonly box: Rect;
}

/** What `measureScreen` answers on the page (CSS px of the page). */
export interface PageMeasure {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly targets: readonly (Named & { readonly width: number; readonly height: number })[];
  readonly texts: readonly (Named & { readonly fontPx: number; readonly outline: boolean })[];
}

export interface Contrast {
  /** Text against the background, each the median over the glyph mask. */
  readonly median: number;
  /** The 25th percentile of the text's contrast with each background pixel (a busy background). */
  readonly worstQuartile: number;
}

export type ScreenViolation = Named &
  (
    | { readonly check: 'tap-size'; readonly measured: { width: number; height: number } }
    | { readonly check: 'text-size'; readonly measured: number }
    | { readonly check: 'contrast'; readonly measured: Contrast }
  ) & { readonly threshold: number };

export interface ScreenChecks {
  /** The picture's page, CSS px; every `box` is in it. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** How many press targets and captions were measured. */
  readonly targets: number;
  readonly texts: number;
  readonly violations: readonly ScreenViolation[];
  /** Captions whose contrast could not be read, and why. */
  readonly notMeasured: readonly { node: string; check: 'contrast'; reason: string }[];
}

/** The pictures of one paused frame: as shown, the same again, and with the captions hidden. */
export interface CheckFrames {
  readonly shown: RgbaImage;
  readonly again: RgbaImage;
  readonly bare: RgbaImage;
}

const LINEAR = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** WCAG 2 relative luminance of an 8-bit sRGB colour. */
export const relativeLuminance = (r: number, g: number, b: number): number =>
  0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];

export const contrastRatio = (one: number, two: number): number =>
  (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);

/**
 * The value at fraction `at` of an ascending list, between its two nearest elements (the median of
 * an even list is the mean of the middle two).
 */
const quantile = (sorted: readonly number[], at: number): number => {
  const position = Math.min(1, Math.max(0, at)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

const ascending = (values: number[]): number[] => values.sort((p, q) => p - q);

/**
 * An ascending list cut in two where the two parts differ most (Otsu's split: the largest
 * between-class variance) — a caption's fill and its outline.
 */
const splitTwo = (sorted: readonly number[]): [number[], number[]] => {
  const total = sorted.reduce((sum, value) => sum + value, 0);
  let best = { at: 0, spread: -1 };
  let below = 0;
  for (let at = 1; at < sorted.length; at += 1) {
    below += sorted[at - 1];
    const share = at / sorted.length;
    const gap = below / at - (total - below) / (sorted.length - at);
    const spread = share * (1 - share) * gap * gap;
    if (spread > best.spread) best = { at, spread };
  }
  return [sorted.slice(0, best.at), sorted.slice(best.at)];
};

const sameImage = (one: RgbaImage, two: RgbaImage): boolean =>
  one.width === two.width &&
  one.height === two.height &&
  Buffer.compare(Buffer.from(one.data), Buffer.from(two.data)) === 0;

/**
 * A caption's contrast from its box (image px) in the shown and the bare picture. The glyph mask
 * is every pixel the two differ on; the text colour is the shown picture over the mask's core (the
 * half that changed most — an antialiased edge is half background), the background the bare
 * picture over the whole mask. `median` is the text against the background's median luminance (the
 * value a violation is decided on); `worstQuartile` the 25th percentile of the text's contrast with
 * each background pixel. With an outline the core holds two colours: it is split in two
 * where they differ most and each part's median is tried — the outline against the background
 * counts when it reads better than the fill.
 */
export const textContrast = (
  shown: RgbaImage,
  bare: RgbaImage,
  box: Rect,
  outline: boolean
): Contrast | { reason: string } => {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(shown.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(shown.height, Math.ceil(box.y + box.height));
  const pixels: { change: number; text: number; back: number }[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * shown.width + x) * 4;
      const [r, g, b] = [shown.data[at], shown.data[at + 1], shown.data[at + 2]];
      const [br, bg, bb] = [bare.data[at], bare.data[at + 1], bare.data[at + 2]];
      const change = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
      if (change > 0)
        pixels.push({
          change,
          text: relativeLuminance(r, g, b),
          back: relativeLuminance(br, bg, bb),
        });
    }
  }
  if (pixels.length === 0) return { reason: 'no glyph on the picture (covered, or off screen)' };
  const changes = ascending(pixels.map(pixel => pixel.change));
  const cut = quantile(changes, 0.5);
  const core = ascending(pixels.filter(pixel => pixel.change >= cut).map(pixel => pixel.text));
  const back = ascending(pixels.map(pixel => pixel.back));
  const backMedian = quantile(back, 0.5);
  const candidates =
    outline && core.length > 1
      ? splitTwo(core).map(part => quantile(part, 0.5))
      : [quantile(core, 0.5)];
  const text = candidates.reduce((best, next) =>
    contrastRatio(next, backMedian) > contrastRatio(best, backMedian) ? next : best
  );
  const perPixel = ascending(back.map(luminance => contrastRatio(text, luminance)));
  return { median: contrastRatio(text, backMedian), worstQuartile: quantile(perPixel, 0.25) };
};

const round = (value: number, digits = 1): number => Number(value.toFixed(digits));

const named = ({ node, type, name, box }: Named): Named => ({
  node,
  type,
  name,
  box: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
});

/**
 * The checks of one picture: sizes from the page's measure, contrast from the frames (`scale`
 * image px per CSS px). Frames are null when the page could not give them, and a frame that did
 * not repeat itself makes every caption's contrast "not measured" rather than a guess.
 */
export const screenChecks = (
  measure: PageMeasure,
  frames: CheckFrames | null,
  scale: number
): ScreenChecks => {
  const violations: ScreenViolation[] = [];
  const notMeasured: { node: string; check: 'contrast'; reason: string }[] = [];
  for (const { width, height, ...target } of measure.targets) {
    if (Math.min(width, height) < TAP_MIN_PX)
      violations.push({
        ...named(target),
        check: 'tap-size',
        measured: { width: round(width), height: round(height) },
        threshold: TAP_MIN_PX,
      });
  }
  const stable = frames && sameImage(frames.shown, frames.again);
  for (const { fontPx, outline, ...text } of measure.texts) {
    if (fontPx < TEXT_MIN_PX)
      violations.push({
        ...named(text),
        check: 'text-size',
        measured: round(fontPx),
        threshold: TEXT_MIN_PX,
      });
    if (!frames || !stable) {
      notMeasured.push({
        node: text.node,
        check: 'contrast',
        reason: frames
          ? 'the paused frame drew differently twice'
          : 'the page gave no frames to compare',
      });
      continue;
    }
    const box = text.box;
    const contrast = textContrast(
      frames.shown,
      frames.bare,
      { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale },
      outline
    );
    if ('reason' in contrast) {
      notMeasured.push({ node: text.node, check: 'contrast', reason: contrast.reason });
      continue;
    }
    const threshold = fontPx >= LARGE_TEXT_PX ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
    if (contrast.median < threshold)
      violations.push({
        ...named(text),
        check: 'contrast',
        measured: {
          median: round(contrast.median, 2),
          worstQuartile: round(contrast.worstQuartile, 2),
        },
        threshold,
      });
  }
  return {
    viewport: measure.viewport,
    targets: measure.targets.length,
    texts: measure.texts.length,
    violations,
    notMeasured,
  };
};
