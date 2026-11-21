import type { PixelFacts, Side } from './pixel-facts.ts';

/**
 * The pixel warnings of `pix3 validate`, decided from {@link PixelFacts}. Each was tuned until it
 * stayed silent on real art (Skyways' sprites, the jam games' sprites, frames `pix3 slice` cuts
 * from Codex sheets) while firing on the slicing mistakes it names — see the plan
 * `.plans/done/jam-takeaways.md` E2 for the numbers.
 */

export type PixelCode = 'W_SPRITE_NO_ALPHA' | 'W_FRAME_CLIPPED' | 'W_FRAME_BLEED';

export interface PixelFinding {
  readonly code: PixelCode;
  readonly message: string;
  readonly fix: string;
}

/**
 * An opaque image that is a picture on a flat backdrop, with a margin all round: the generator was asked for transparency
 * and painted a background instead, and the sprite draws as a coloured box.
 */
export function spriteFindings(facts: PixelFacts): PixelFinding[] {
  const backdrop = facts.backdrop;
  // Art that reaches the edge (a screen mockup, a full-bleed background) is not on a backdrop.
  if (!backdrop || backdrop.share < 0.15 || backdrop.share > 0.97 || backdrop.inset < 0.005) {
    return [];
  }
  return [
    {
      code: 'W_SPRITE_NO_ALPHA',
      message: `the image has no transparency: ${Math.round(backdrop.share * 100)}% of it is a flat ${backdrop.color} backdrop around the picture, which draws as a box.`,
      fix: `key the backdrop out: pix3 slice <file> --blobs (or --key ${backdrop.color}); ignore it if the backdrop is meant to show`,
    },
  ];
}

const sideLength = (facts: PixelFacts, side: Side): number =>
  side === 'top' || side === 'bottom' ? facts.width : facts.height;

/** A shape cut by the frame edge: small beside the picture, lying along the edge. */
export function bleedFindings(facts: PixelFacts): PixelFinding[] {
  const stray = facts.strays.find(s => {
    const along = s.side === 'top' || s.side === 'bottom' ? s.width : s.height;
    return s.size < facts.largest / 4 && s.contact >= Math.max(3, along * 0.6);
  });
  if (!stray) return [];
  return [
    {
      code: 'W_FRAME_BLEED',
      message: `a piece of another picture (${stray.width}×${stray.height} at ${stray.x},${stray.y}) is cut by the ${stray.side} edge — the slice took part of a neighbour.`,
      fix: 're-cut the sheet: pix3 slice <sheet> --blobs (one frame per shape) or a grid that matches it',
    },
  ];
}

/**
 * Frames of one clip whose art runs into an edge most of the clip keeps clear — a pose that
 * reached out of its grid cell. Art that touches the edge in every frame (a bust, a ground line)
 * is the design, not a cut.
 */
export function clippedFindings(clip: readonly PixelFacts[]): PixelFinding[][] {
  const out = clip.map((): PixelFinding[] => []);
  if (clip.length < 3) return out;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const clear = clip.filter(facts => facts.edgeRuns[side] === 0).length;
    if (clear * 3 < clip.length * 2) continue;
    clip.forEach((facts, i) => {
      const run = facts.edgeRuns[side];
      if (run < Math.max(3, sideLength(facts, side) * 0.08)) return;
      out[i].push({
        code: 'W_FRAME_CLIPPED',
        message: `the art runs into the ${side} edge (${run} px) where ${clear} of ${clip.length} frames of the clip keep it clear — the pose was cut off.`,
        fix: 're-cut the sheet with room for the pose: pix3 slice <sheet> --blobs, or a grid whose cells hold every pose',
      });
    });
  }
  return out;
}
