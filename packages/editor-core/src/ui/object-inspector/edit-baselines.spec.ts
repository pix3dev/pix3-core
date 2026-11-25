import { describe, expect, it } from 'vitest';

import { EditBaselines } from './edit-baselines';

describe('EditBaselines', () => {
  it('keeps the value from before the first edit across many edits', () => {
    const b = new EditBaselines();
    let value = 0.5;
    const read = () => value;
    for (const next of [0.6, 0.7, 0.2]) {
      b.noteStart('k', value, read);
      b.noteWritten('k', next);
      value = next;
    }
    expect(b.baseline('k')).toEqual({ value: 0.5 });
    expect(b.isChanged('k')).toBe(true);
    expect(b.changedKeys()).toEqual(['k']);

    // A revert lands on the baseline: unchanged, but the baseline stays for the next edit.
    value = 0.5;
    b.prune();
    expect(b.isChanged('k')).toBe(false);
    expect(b.baseline('k')).toEqual({ value: 0.5 });
  });

  it('survives undo to a value the session wrote; drops on a value it never wrote', () => {
    const b = new EditBaselines();
    let value = 1;
    b.noteStart('k', 1, () => value);
    b.noteWritten('k', 2);
    b.noteWritten('k', 3);
    value = 2; // undo of the last edit
    b.prune();
    expect(b.has('k')).toBe(true);
    value = 42; // an agent's edit merged from disk
    b.prune();
    expect(b.has('k')).toBe(false);
  });

  it('copies object values instead of aliasing them', () => {
    const b = new EditBaselines();
    const live = { x: 1, y: 2 };
    b.noteStart('v', live, () => live);
    live.x = 5;
    expect(b.baseline('v')).toEqual({ value: { x: 1, y: 2 } });
    expect(b.isChanged('v')).toBe(true);
  });

  it('filters changed keys by prefix (one component)', () => {
    const b = new EditBaselines();
    b.noteStart('c1:a', 1, () => 2);
    b.noteStart('c1:b', 1, () => 1);
    b.noteStart('c2:a', 1, () => 3);
    expect(b.changedKeys('c1:')).toEqual(['c1:a']);
  });
});
