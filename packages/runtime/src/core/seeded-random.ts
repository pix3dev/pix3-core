/**
 * The game's random numbers, from a seed (`scene.random`). A run can be replayed: `pix3 play
 * --seed 7`, `pix3 smoke --seed 7` and the editor's run overrides seed it before the scene's first
 * `onStart`, so a bot meets the same board every time (core-tests/game10). Without a seed it starts
 * from a random one, like `Math.random`. sfc32 (fast, 128-bit state, good statistics); the
 * algorithm is part of the contract — the same seed gives the same sequence in every release.
 *
 * `Math.random` is deliberately not patched: it belongs to the libraries and to the editor around
 * the game too. Game logic draws from here; purely cosmetic noise may keep using `Math.random`.
 */
export class SeededRandom {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  private currentSeed = 0;

  constructor(seed?: number) {
    this.seed(seed ?? Math.floor(Math.random() * 0x1_0000_0000));
  }

  /** Restart the sequence from `seed` (any finite number; the integer part is used). */
  seed(seed: number): void {
    const value = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
    this.currentSeed = value;
    // splitmix32 spreads one 32-bit seed over the four words of state.
    let s = value;
    const next = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i += 1) this.next();
  }

  /** The seed the current sequence started from. */
  get currentSeedValue(): number {
    return this.currentSeed;
  }

  /** A float in [0, 1) — a drop-in for `Math.random()`. */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 0x1_0000_0000;
  }

  /** An integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** A float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** One element of `items`, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(this.next() * items.length)];
  }

  /** Shuffle `items` in place (Fisher–Yates) and return it. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /**
   * An independent stream derived from this one's seed and `name` — e.g. `fork('fx')` for cosmetic
   * draws, so adding a particle does not change the board the logic stream deals.
   */
  fork(name: string): SeededRandom {
    let hash = this.currentSeed ^ 0x811c9dc5;
    for (let i = 0; i < name.length; i += 1)
      hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
    return new SeededRandom(hash >>> 0);
  }
}
