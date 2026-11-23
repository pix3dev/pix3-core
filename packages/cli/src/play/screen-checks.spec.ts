// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { RgbaImage } from '../image/png.ts';
import {
  contrastRatio,
  relativeLuminance,
  screenChecks,
  textContrast,
  type PageMeasure,
} from './screen-checks.ts';
import { describeViolation, formatScreensHuman, screensSheetHtml } from './screens.ts';

type Rgb = readonly [number, number, number];

/** A `width`×`height` picture of `back`, with `paint(x, y)` giving another colour where it wants. */
const picture = (
  width: number,
  height: number,
  back: Rgb,
  paint: (x: number, y: number) => Rgb | null = () => null
): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y) ?? back;
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { width, height, data };
};

const box = { x: 0, y: 0, width: 40, height: 20 };
/** "Glyphs": two bars, with a one-pixel antialiased edge half way to the background. */
const glyph = (x: number, y: number): 'core' | 'edge' | null => {
  if (y < 5 || y >= 15) return null;
  if ((x >= 5 && x < 12) || (x >= 20 && x < 27)) return 'core';
  if (x === 12 || x === 27) return 'edge';
  return null;
};

describe('contrast maths', () => {
  it('is WCAG 2: white on black 21:1, #777 on white just under 4.5:1', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 9);
    expect(contrastRatio(relativeLuminance(0, 0, 0), relativeLuminance(255, 255, 255))).toBeCloseTo(
      21,
      9
    );
    expect(
      contrastRatio(relativeLuminance(0x77, 0x77, 0x77), relativeLuminance(255, 255, 255))
    ).toBeCloseTo(4.48, 2);
  });

  it('reads the text over its glyph mask and the background under it, edges aside', () => {
    const shown = picture(40, 20, [0x70, 0x70, 0x70], (x, y) =>
      glyph(x, y) === 'core'
        ? [0x80, 0x80, 0x80]
        : glyph(x, y) === 'edge'
          ? [0x78, 0x78, 0x78]
          : null
    );
    const bare = picture(40, 20, [0x70, 0x70, 0x70]);
    const contrast = textContrast(shown, bare, box, false);
    // #808080 on #707070, computed by hand: (0.2159 + 0.05) / (0.1620 + 0.05).
    expect(contrast).toEqual({
      median: expect.closeTo(1.254, 3),
      worstQuartile: expect.closeTo(1.254, 3),
    });
    expect(textContrast(bare, bare, box, false)).toEqual({
      reason: expect.stringContaining('no glyph'),
    });
  });

  it('reports a busy background by its worst quartile beside the median', () => {
    // White text on black, but under most of its right bar (a third of the glyphs) light grey.
    const back = (x: number): Rgb => (x < 23 ? [0, 0, 0] : [0xcc, 0xcc, 0xcc]);
    const shown = picture(40, 20, [0, 0, 0], (x, y) => (glyph(x, y) ? [255, 255, 255] : back(x)));
    const bare = picture(40, 20, [0, 0, 0], x => back(x));
    const contrast = textContrast(shown, bare, box, false);
    if ('reason' in contrast) throw new Error(contrast.reason);
    expect(contrast.worstQuartile).toBeCloseTo(
      contrastRatio(1, relativeLuminance(0xcc, 0xcc, 0xcc)),
      6
    );
    expect(contrast.median).toBeCloseTo(21, 6);
  });

  it('takes the worst quartile of per-pixel contrast, a background both darker and lighter', () => {
    // Text of luminance ≈ 0.18 (#767676) over one row of 100 px: black under 55, ≈ 0.30 (#959595)
    // under 20, white under 25. Per pixel 4.6, 1.52, 4.56:1 — the 25th percentile is 4.56:1, not
    // the 1.52:1 of the background's own upper quartile.
    const back = (x: number): Rgb =>
      x < 55 ? [0, 0, 0] : x < 75 ? [0x95, 0x95, 0x95] : [255, 255, 255];
    const row = { x: 0, y: 0, width: 100, height: 1 };
    const shown = picture(100, 1, [0, 0, 0], () => [0x76, 0x76, 0x76]);
    const bare = picture(100, 1, [0, 0, 0], x => back(x));
    const text = relativeLuminance(0x76, 0x76, 0x76);
    expect(text).toBeCloseTo(0.18, 2);
    const contrast = textContrast(shown, bare, row, false);
    if ('reason' in contrast) throw new Error(contrast.reason);
    expect(contrast.worstQuartile).toBeCloseTo(contrastRatio(text, 1), 6);
    expect(contrast.worstQuartile).toBeCloseTo(4.57, 1);
    expect(contrast.median).toBeCloseTo(contrastRatio(text, 0), 6);
  });

  it('takes the median of an even sample between its two middle values', () => {
    // Black text over a background half #202020, half #909090: the median background is the mean
    // of the two luminances, 3.93:1 — under 4.5, so the caption is flagged (6.58:1 by the upper).
    const back = (x: number): Rgb => (x < 20 ? [0x20, 0x20, 0x20] : [0x90, 0x90, 0x90]);
    const shown = picture(40, 1, [0, 0, 0]);
    const bare = picture(40, 1, [0, 0, 0], x => back(x));
    const middle = (relativeLuminance(0x20, 0x20, 0x20) + relativeLuminance(0x90, 0x90, 0x90)) / 2;
    const row = { x: 0, y: 0, width: 40, height: 1 };
    const contrast = textContrast(shown, bare, row, false);
    if ('reason' in contrast) throw new Error(contrast.reason);
    expect(contrast.median).toBeCloseTo(contrastRatio(0, middle), 6);
    expect(contrast.median).toBeCloseTo(3.93, 2);
    const checks = screenChecks(
      {
        viewport: { width: 40, height: 1 },
        targets: [],
        texts: [
          { node: 'caption', type: 'Label2D', name: '', fontPx: 18, outline: false, box: row },
        ],
      },
      { shown, again: shown, bare },
      1
    );
    expect(checks.violations).toMatchObject([
      { check: 'contrast', node: 'caption', measured: { median: 3.93 }, threshold: 4.5 },
    ]);
  });

  it('takes an outline against the background when it reads better than the fill', () => {
    // Grey fill on a grey panel, with a black outline row above and below each bar.
    const shown = picture(40, 20, [0x80, 0x80, 0x80], (x, y) => {
      if (!glyph(x, 10)) return null;
      if (y === 5 || y === 14) return [0, 0, 0];
      return glyph(x, y) ? [0x90, 0x90, 0x90] : null;
    });
    const bare = picture(40, 20, [0x80, 0x80, 0x80]);
    const fillOnly = textContrast(shown, bare, box, false);
    const outlined = textContrast(shown, bare, box, true);
    if ('reason' in fillOnly || 'reason' in outlined) throw new Error('not measured');
    expect(outlined.median).toBeCloseTo(contrastRatio(0, relativeLuminance(0x80, 0x80, 0x80)), 6);
    expect(outlined.median).toBeGreaterThan(fillOnly.median);
  });
});

const measure: PageMeasure = {
  viewport: { width: 40, height: 40 },
  targets: [
    {
      node: 'tiny',
      type: 'Button2D',
      name: 'Tiny',
      width: 120,
      height: 24,
      box: { x: 0, y: 30, width: 40, height: 10 },
    },
    {
      node: 'fine',
      type: 'Button2D',
      name: 'Fine',
      width: 200,
      height: 44,
      box: { x: 0, y: 0, width: 40, height: 10 },
    },
  ],
  texts: [
    {
      node: 'faint',
      type: 'Label2D',
      name: 'Faint',
      fontPx: 18,
      outline: false,
      box: { x: 0, y: 0, width: 20, height: 10 },
    },
    {
      node: 'note',
      type: 'Label2D',
      name: 'Note',
      fontPx: 12,
      outline: false,
      box: { x: 20, y: 20, width: 20, height: 10 },
    },
  ],
};

/** At scale 2: faint grey text in the top-left box, white in the other one. */
const frames = () => {
  const bare = picture(80, 80, [0x70, 0x70, 0x70]);
  const shown = picture(80, 80, [0x70, 0x70, 0x70], (x, y) =>
    x >= 10 && x < 30 && y >= 5 && y < 15
      ? [0x80, 0x80, 0x80]
      : x >= 50 && x < 70 && y >= 45 && y < 55
        ? [255, 255, 255]
        : null
  );
  return { shown, again: shown, bare };
};

describe('screenChecks', () => {
  it('flags a small target, small text and faint text, with node, value and threshold', () => {
    const checks = screenChecks(measure, frames(), 2);
    expect(checks).toMatchObject({
      viewport: { width: 40, height: 40 },
      targets: 2,
      texts: 2,
      notMeasured: [],
    });
    expect(checks.violations.map(v => [v.check, v.node, v.threshold])).toEqual([
      ['tap-size', 'tiny', 44],
      ['contrast', 'faint', 4.5],
      ['text-size', 'note', 16],
    ]);
    expect(checks.violations.map(describeViolation)).toEqual([
      'tap-size tiny 120×24 < 44',
      'contrast faint 1.25:1 (worst quartile 1.25:1) < 4.5',
      'text-size note 12 px < 16',
    ]);
  });

  it('holds large text to 3:1', () => {
    const large = { ...measure, texts: [{ ...measure.texts[0], fontPx: 24 }] };
    const checks = screenChecks(large, frames(), 2);
    expect(checks.violations.find(v => v.check === 'contrast')?.threshold).toBe(3);
  });

  it('measures no contrast when the paused frame did not repeat, or there are no frames', () => {
    const moved = { ...frames(), again: picture(80, 80, [0, 0, 0]) };
    const unstable = screenChecks(measure, moved, 2);
    expect(unstable.violations.map(v => v.check)).toEqual(['tap-size', 'text-size']);
    expect(unstable.notMeasured).toEqual([
      { node: 'faint', check: 'contrast', reason: 'the paused frame drew differently twice' },
      { node: 'note', check: 'contrast', reason: 'the paused frame drew differently twice' },
    ]);
    expect(screenChecks(measure, null, 2).notMeasured[0].reason).toContain('no frames');
  });

  it('draws a box per finding on the sheet and lists them in the human report', () => {
    const checks = screenChecks(measure, frames(), 2);
    const pictures = [
      {
        screen: 'menu',
        size: '40x40@2',
        file: '/o/menu.png',
        status: 'ok' as const,
        errors: [],
        shots: [],
        checks,
      },
    ];
    const html = screensSheetHtml(pictures, path => path.slice(3));
    expect(html).toContain(
      '<div class="flag tap-size" title="tap-size tiny 120×24 &lt; 44" style="left:0.000%;top:75.000%;width:100.000%;height:25.000%"></div>'
    );
    expect(html.match(/class="flag /g)).toHaveLength(3);
    expect(html).toContain('.plain .flag{display:none}');
    const human = formatScreensHuman({
      out: '/o',
      html: '/o/index.html',
      sheet: '/o/sheet.png',
      blurred: '/o/sheet-blur.png',
      pictures,
    });
    expect(human).toContain('checks: 2 target(s), 2 caption(s), 3 warning(s)');
    expect(human).toContain('warning: text-size note 12 px < 16');
    expect(human).toContain('blurred: /o/sheet-blur.png');
  });
});
