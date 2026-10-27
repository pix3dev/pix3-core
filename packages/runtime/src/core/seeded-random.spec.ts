import { describe, expect, it } from 'vitest';

import { SeededRandom } from './seeded-random';

/** `scene.random`: a seeded run replays (core-tests/game10). */
describe('SeededRandom', () => {
  it('the same seed gives the same sequence; another seed another one', () => {
    const draw = (seed: number) => {
      const random = new SeededRandom(seed);
      return Array.from({ length: 8 }, () => random.next());
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    for (const value of draw(123)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('seed() restarts the sequence; the algorithm is pinned', () => {
    const random = new SeededRandom(1);
    const first = random.next();
    random.next();
    random.seed(1);
    expect(random.next()).toBe(first);
    // A release that changes the generator changes every seeded test run: pin a value.
    expect(new SeededRandom(42).next()).toMatchInlineSnapshot(`0.23955312534235418`);
  });

  it('int, range, pick, shuffle stay in bounds and are deterministic', () => {
    const random = new SeededRandom(5);
    for (let i = 0; i < 200; i += 1) {
      const n = random.int(1, 6);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
      const r = random.range(-2, 2);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(2);
    }
    expect(random.pick([])).toBeUndefined();
    const a = new SeededRandom(9).shuffle([1, 2, 3, 4, 5, 6]);
    expect(new SeededRandom(9).shuffle([1, 2, 3, 4, 5, 6])).toEqual(a);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('fork gives an independent stream that does not consume the parent', () => {
    const parent = new SeededRandom(3);
    const control = new SeededRandom(3);
    const fx = parent.fork('fx');
    fx.next();
    fx.next();
    expect(parent.next()).toBe(control.next());
    expect(new SeededRandom(3).fork('fx').next()).toBe(new SeededRandom(3).fork('fx').next());
  });
});
