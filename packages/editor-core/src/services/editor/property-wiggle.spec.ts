import { describe, expect, it } from 'vitest';

import {
  quantiseWiggleTime,
  WIGGLE_PERIOD,
  wiggleDuration,
  wiggleValue,
  type NumberWiggleSpec,
} from './property-wiggle';

const sample = (spec: NumberWiggleSpec, level: 1 | 2, n = 200) => {
  const duration = Math.min(wiggleDuration('number', level), WIGGLE_PERIOD * 2);
  return Array.from(
    { length: n + 1 },
    (_, i) => wiggleValue(spec, level, (duration * i) / n) as number
  );
};

describe('wiggle waveform', () => {
  it('level 1: starts and ends on the value, swings ±25% of the range, then is the value again', () => {
    const spec: NumberWiggleSpec = { kind: 'number', base: 0.5, min: 0, max: 1 };
    const values = sample(spec, 1);
    expect(values[0]).toBe(0.5);
    expect(values.at(-1)).toBeCloseTo(0.5, 6);
    expect(Math.max(...values)).toBeCloseTo(0.75, 2);
    expect(Math.min(...values)).toBeCloseTo(0.25, 2);
    expect(wiggleValue(spec, 1, wiggleDuration('number', 1))).toBe(0.5);
  });

  it('shifts the window inside the range at an edge instead of clipping', () => {
    const spec: NumberWiggleSpec = { kind: 'number', base: 0.95, min: 0, max: 1 };
    const values = sample(spec, 1);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.min(...values)).toBeLessThan(0.55);
    // No flat stretch at the top: a clipped sine would sit on 1 for many samples.
    expect(values.filter(v => v > 0.999).length).toBeLessThan(15);
    // The first half-swing goes to the side with room (down).
    expect(wiggleValue(spec, 1, 0.4) as number).toBeLessThan(0.95);
  });

  it('level 2 swings the full range and loops', () => {
    const spec: NumberWiggleSpec = { kind: 'number', base: 0.2, min: 0, max: 1 };
    expect(wiggleDuration('number', 2)).toBe(Number.POSITIVE_INFINITY);
    const values = sample(spec, 2);
    expect(Math.max(...values)).toBeCloseTo(1, 2);
    expect(Math.min(...values)).toBeCloseTo(0, 2);
  });

  it('without a range swings by max(10 steps, 25% of the value)', () => {
    const values = sample({ kind: 'number', base: 100, step: 1 }, 1);
    expect(Math.max(...values)).toBeCloseTo(125, 0);
    const small = sample({ kind: 'number', base: 0, step: 0.1 }, 1);
    expect(Math.max(...small)).toBeCloseTo(1, 1);
  });

  it('booleans flip three times at level 1', () => {
    const spec = { kind: 'boolean' as const, base: false };
    const flips = Array.from({ length: 40 }, (_, i) =>
      wiggleValue(spec, 1, (wiggleDuration('boolean', 1) * i) / 40)
    ).filter((v, i, all) => i > 0 && v !== all[i - 1]).length;
    expect(flips).toBe(3);
    expect(wiggleValue(spec, 1, 99)).toBe(false);
  });

  it('colours pulse in lightness and come back to the authored hex', () => {
    const spec = { kind: 'color' as const, base: '#3f5884' };
    expect(wiggleValue(spec, 1, 0)).toBe('#3f5884');
    expect(wiggleValue(spec, 1, 0.3)).not.toBe('#3f5884');
    expect(wiggleValue(spec, 1, wiggleDuration('color', 1))).toBe('#3f5884');
  });

  it('quantises time into steps per swing', () => {
    expect(quantiseWiggleTime(0.31, 4)).toBeCloseTo(0.3, 6);
    expect(quantiseWiggleTime(0.29, 4)).toBe(0);
  });
});
