import { describe, expect, it } from 'vitest';
import type { LocaleTable } from '@pix3/runtime';

import {
  diffLocaleTables,
  findClobberedLocaleKeys,
  mergeLocaleTables,
  recordLocaleWrite,
} from './locale-table-merge';

const table = (strings: Record<string, string>, sprites: Record<string, string> = {}) =>
  ({ locale: 'en', strings, sprites }) as LocaleTable;

describe('mergeLocaleTables', () => {
  it("takes the agent's keys and keeps the editor's edits of other keys", () => {
    const B = table({ a: 'A', b: 'B' });
    const E = table({ a: 'A', b: 'B', c: 'agent' }, { logo: 'res://en.png' });
    const L = table({ a: 'mine', b: 'B' });
    const result = mergeLocaleTables(B, E, L);
    expect(result.merged.strings).toEqual({ a: 'mine', b: 'B', c: 'agent' });
    expect(result.merged.sprites).toEqual({ logo: 'res://en.png' });
    expect(result.kept).toEqual([{ section: 'strings', key: 'a' }]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps the disk value of a key both changed, and reports it', () => {
    const result = mergeLocaleTables(
      table({ a: 'A' }),
      table({ a: 'agent' }),
      table({ a: 'mine' })
    );
    expect(result.merged.strings).toEqual({ a: 'agent' });
    expect(result.dropped).toEqual([
      { section: 'strings', key: 'a', mine: 'mine', theirs: 'agent' },
    ]);
  });

  it('deletions are edits like any other: one side deleting, the other untouched', () => {
    const B = table({ a: 'A', b: 'B' });
    // The agent deleted b, the editor deleted a.
    const result = mergeLocaleTables(B, table({ a: 'A' }), table({ b: 'B' }));
    expect(result.merged.strings).toEqual({});
    // The agent deleted a key the editor changed: the disk (no key) wins.
    const both = mergeLocaleTables(B, table({ b: 'B' }), table({ a: 'mine', b: 'B' }));
    expect(both.merged.strings).toEqual({ b: 'B' });
    expect(both.dropped).toEqual([{ section: 'strings', key: 'a', mine: 'mine', theirs: null }]);
  });

  it('the same value on both sides is no conflict; $meta follows the disk', () => {
    const E = { ...table({ a: 'same' }), meta: { name: 'English (UK)' } };
    const result = mergeLocaleTables(table({ a: 'A' }), E, table({ a: 'same' }));
    expect(result.dropped).toEqual([]);
    expect(result.merged.meta).toEqual({ name: 'English (UK)' });
  });
});

describe('locale ledger (W17 for a table)', () => {
  it('an external version that puts back what the editor replaced is a clobber', () => {
    const v0 = table({ a: 'A', b: 'B' });
    const v1 = table({ a: 'one', b: 'B' });
    const v2 = table({ a: 'two', b: 'B' });
    let ledger = recordLocaleWrite(new Map(), v0, v1);
    ledger = recordLocaleWrite(ledger, v1, v2);
    // The agent wrote from its read of v0 (a = 'A') and added c.
    expect(findClobberedLocaleKeys(ledger, table({ a: 'A', b: 'B', c: 'C' }))).toEqual([
      { section: 'strings', key: 'a', written: 'two' },
    ]);
    // A version that keeps the editor's value is not.
    expect(findClobberedLocaleKeys(ledger, table({ a: 'two', c: 'C' }))).toEqual([]);
    expect(diffLocaleTables(v0, v2)).toEqual([{ section: 'strings', key: 'a' }]);
  });
});
