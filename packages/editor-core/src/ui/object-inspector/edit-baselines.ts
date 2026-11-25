/**
 * "Where I started" for the inspector's per-row revert: the value a property had before the
 * user's first edit of it while this node is selected. Several drags, typed values and arrow runs
 * later, one click puts that value back — one undo step, not one per edit.
 *
 * - A baseline is taken at the first edit of a property (preview or commit) and kept until the
 *   selection moves; a revert keeps it, so editing again still reverts to the same value.
 * - Undo/redo inside the session keeps it: they only land on values the session has seen.
 * - A value that changes to something the session never wrote (an agent's edit merged from
 *   disk, a script) drops the baseline: reverting would silently overwrite that edit.
 *
 * Values are compared and stored as JSON, so object values (vectors) are copied, not aliased.
 */

interface Entry {
  value: unknown;
  json: string;
  seen: Set<string>;
  read: () => unknown;
}

const toJson = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

export class EditBaselines {
  private readonly entries = new Map<string, Entry>();

  /** First edit of `key`: remember `value` (the value before it) unless already remembered. */
  noteStart(key: string, value: unknown, read: () => unknown): void {
    if (this.entries.has(key)) {
      return;
    }
    const json = toJson(value);
    this.entries.set(key, {
      value: json === 'undefined' ? undefined : JSON.parse(json),
      json,
      seen: new Set([json]),
      read,
    });
  }

  /** A value this session wrote (or is about to write): undo/redo may land on it. */
  noteWritten(key: string, value: unknown): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.seen.add(toJson(value));
    // A text field writes "0.5"; the property stores 0.5 after coercion.
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      entry.seen.add(toJson(Number(value)));
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The value before the first edit; `undefined` when there is none. */
  baseline(key: string): { value: unknown } | undefined {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value } : undefined;
  }

  /** True when `key` has a baseline and its current value differs from it. */
  isChanged(key: string): boolean {
    const entry = this.entries.get(key);
    return entry ? toJson(entry.read()) !== entry.json : false;
  }

  /** Keys with a baseline whose current value differs, among those starting with `prefix`. */
  changedKeys(prefix = ''): string[] {
    return [...this.entries.keys()].filter(key => key.startsWith(prefix) && this.isChanged(key));
  }

  /** Drop baselines whose value moved somewhere this session never wrote (see the file header). */
  prune(): void {
    for (const [key, entry] of this.entries) {
      let current: unknown;
      try {
        current = entry.read();
      } catch {
        this.entries.delete(key);
        continue;
      }
      if (!entry.seen.has(toJson(current))) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
