/**
 * The wiggle's waveform: what value a property shows `t` seconds into a wiggle.
 * Pure, so the shape is specified by tests and the service only plays it.
 *
 * - Numbers swing on a sine around the current value: ±25% of the range at level 1
 *   (two cycles, then back), the whole range at level 2 (loops until stopped). The
 *   window shifts inward at a range edge instead of clipping (a clipped sine reads
 *   as a stall); the first half-swing goes to the side with more room. An envelope
 *   eases in and out, so the swing starts and ends exactly on the current value.
 * - Booleans flip at 2 Hz: three times at level 1, until stopped at level 2.
 * - Colours pulse in lightness (HSL): ±20% at level 1, ±40% at level 2.
 */

import { Color, SRGBColorSpace } from 'three';

export type WiggleLevel = 1 | 2;

export type WiggleKind = 'number' | 'boolean' | 'color';

export interface NumberWiggleSpec {
  kind: 'number';
  base: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface BooleanWiggleSpec {
  kind: 'boolean';
  base: boolean;
}

export interface ColorWiggleSpec {
  kind: 'color';
  /** `#rrggbb` (sRGB, as authored). */
  base: string;
}

export type WiggleSpec = NumberWiggleSpec | BooleanWiggleSpec | ColorWiggleSpec;

/** One full swing, seconds. */
export const WIGGLE_PERIOD = 1.2;
/** Level 1 plays this many swings, then ends. */
export const WIGGLE_CYCLES = 2;
const EASE = 0.3;
const FLIP_HZ = 2;
const LEVEL1_FLIPS = 3;

/** Seconds a wiggle at `level` lasts; `Infinity` loops until stopped. */
export function wiggleDuration(kind: WiggleKind, level: WiggleLevel): number {
  if (level === 2) {
    return Number.POSITIVE_INFINITY;
  }
  if (kind === 'boolean') {
    return (LEVEL1_FLIPS + 1) / (2 * FLIP_HZ);
  }
  return WIGGLE_PERIOD * WIGGLE_CYCLES;
}

function envelope(t: number, duration: number): number {
  const rampIn = Math.min(1, t / EASE);
  const rampOut = Number.isFinite(duration) ? Math.min(1, Math.max(0, (duration - t) / EASE)) : 1;
  const e = Math.min(rampIn, rampOut);
  return e * e * (3 - 2 * e);
}

/** Sample the waveform; at `t >= duration` (level 1) it is the base value again. */
export function wiggleValue(
  spec: WiggleSpec,
  level: WiggleLevel,
  t: number
): number | boolean | string {
  const duration = wiggleDuration(spec.kind, level);
  if (t >= duration) {
    return spec.base;
  }
  switch (spec.kind) {
    case 'number':
      return numberAt(spec, level, t, duration);
    case 'boolean': {
      const flips = Math.floor(t * 2 * FLIP_HZ);
      return flips % 2 === 0 ? spec.base : !spec.base;
    }
    case 'color':
      return colorAt(spec, level, t, duration);
  }
}

function numberAt(spec: NumberWiggleSpec, level: WiggleLevel, t: number, duration: number) {
  const { base } = spec;
  const min = Number.isFinite(spec.min) ? (spec.min as number) : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(spec.max) ? (spec.max as number) : Number.POSITIVE_INFINITY;
  const ranged = Number.isFinite(min) && Number.isFinite(max) && max > min;
  const step = spec.step && spec.step > 0 ? spec.step : 0.01;

  let amplitude: number;
  let centre: number;
  if (ranged) {
    const range = max - min;
    amplitude = level === 2 ? range / 2 : range / 4;
    centre = level === 2 ? (min + max) / 2 : base;
    // Shift the window inside the range rather than clip the swing.
    centre = Math.min(max - amplitude, Math.max(min + amplitude, centre));
  } else {
    amplitude = Math.max(10 * step, Math.abs(base) * (level === 2 ? 0.5 : 0.25));
    centre = base;
    if (Number.isFinite(min)) centre = Math.max(min + amplitude, centre);
    if (Number.isFinite(max)) centre = Math.min(max - amplitude, centre);
  }

  const towardsMax = ranged ? max - base >= base - min : true;
  const direction = towardsMax ? 1 : -1;
  const wave = Math.sin((2 * Math.PI * t) / WIGGLE_PERIOD) * direction;
  const e = envelope(t, duration);
  const value = base + e * (centre - base + amplitude * wave);
  return Math.min(max, Math.max(min, value));
}

function colorAt(spec: ColorWiggleSpec, level: WiggleLevel, t: number, duration: number) {
  const color = new Color();
  try {
    color.set(spec.base);
  } catch {
    return spec.base;
  }
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, SRGBColorSpace);
  const amplitude = level === 2 ? 0.4 : 0.2;
  // Towards the side with more room, like numbers.
  const direction = hsl.l <= 0.5 ? 1 : -1;
  const wave = Math.sin((2 * Math.PI * t) / WIGGLE_PERIOD) * direction;
  const l = Math.min(1, Math.max(0, hsl.l + envelope(t, duration) * amplitude * wave));
  color.setHSL(hsl.h, hsl.s, l, SRGBColorSpace);
  return `#${color.getHexString()}`;
}

/**
 * Quantise wiggle time to `stepsPerCycle` steps per swing: a property whose change
 * rebuilds geometry gets a few discrete A/B/A states instead of a rebuild per frame.
 */
export function quantiseWiggleTime(t: number, stepsPerCycle: number): number {
  const slot = WIGGLE_PERIOD / Math.max(1, stepsPerCycle);
  return Math.floor(t / slot) * slot;
}
