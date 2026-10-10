import type { LocaleTable } from '@pix3/runtime';

/**
 * Key-level merge of a locale table (`locales/<id>.json`: two flat key → string maps), the
 * write model of plan §C.3 cut to the shape of the file (`.plans/write-model.md` W20). B is the
 * last disk version the editor confirmed, E the version on disk now, L the editor's table.
 */

export const LOCALE_SECTIONS = ['strings', 'sprites'] as const;
export type LocaleSection = (typeof LOCALE_SECTIONS)[number];

export interface LocaleKeyRef {
  readonly section: LocaleSection;
  readonly key: string;
}

export interface DroppedLocaleKey extends LocaleKeyRef {
  /** The editor's value that did not make it (`null` = the editor had deleted the key). */
  readonly mine: string | null;
  /** The value on disk that was kept. */
  readonly theirs: string | null;
}

export interface LocaleMergeResult {
  /** E with every pending edit of the editor E did not touch. */
  readonly merged: LocaleTable;
  /** Edits of the editor carried over (still to be written on top of E). */
  readonly kept: readonly LocaleKeyRef[];
  /** Keys both sides changed to different values: E's value wins (§C.3 "same key"). */
  readonly dropped: readonly DroppedLocaleKey[];
}

const valueOf = (table: LocaleTable, section: LocaleSection, key: string): string | null =>
  Object.prototype.hasOwnProperty.call(table[section], key) ? table[section][key] : null;

/** Keys whose value differs between `a` and `b` (added, removed or changed). */
export function diffLocaleTables(a: LocaleTable, b: LocaleTable): LocaleKeyRef[] {
  const changed: LocaleKeyRef[] = [];
  for (const section of LOCALE_SECTIONS) {
    for (const key of new Set([...Object.keys(a[section]), ...Object.keys(b[section])])) {
      if (valueOf(a, section, key) !== valueOf(b, section, key)) changed.push({ section, key });
    }
  }
  return changed;
}

/**
 * Per key: the editor did not change it (L = B) → E; E did not change it (E = B) → L; both agree
 * → that value; both changed it differently → E, and the key is reported as dropped. `$meta`
 * follows E (the editor never edits it).
 */
export function mergeLocaleTables(
  base: LocaleTable,
  external: LocaleTable,
  local: LocaleTable
): LocaleMergeResult {
  const merged: LocaleTable = {
    locale: external.locale,
    strings: { ...external.strings },
    sprites: { ...external.sprites },
    ...(external.meta ? { meta: { ...external.meta } } : {}),
  };
  const kept: LocaleKeyRef[] = [];
  const dropped: DroppedLocaleKey[] = [];
  for (const { section, key } of diffLocaleTables(base, local)) {
    const b = valueOf(base, section, key);
    const e = valueOf(external, section, key);
    const l = valueOf(local, section, key);
    if (e === l) continue;
    if (e !== b) {
      dropped.push({ section, key, mine: l, theirs: e });
      continue;
    }
    if (l === null) delete merged[section][key];
    else merged[section][key] = l;
    kept.push({ section, key });
  }
  return { merged, kept, dropped };
}

/**
 * What the editor's writes changed since the last external version, per key: the value written
 * and the value it replaced (W17's flush ledger for a table). An external version that puts a
 * key back to the replaced value was written from a read older than the editor's write.
 */
export type LocaleLedger = Map<
  string,
  { readonly ref: LocaleKeyRef; readonly written: string | null; readonly replaced: string | null }
>;

const ledgerKey = (ref: LocaleKeyRef): string => `${ref.section}\u0000${ref.key}`;

export function recordLocaleWrite(
  ledger: LocaleLedger,
  previous: LocaleTable,
  next: LocaleTable
): LocaleLedger {
  const out: LocaleLedger = new Map(ledger);
  for (const ref of diffLocaleTables(previous, next)) {
    const id = ledgerKey(ref);
    const replaced = out.has(id) ? out.get(id)!.replaced : valueOf(previous, ref.section, ref.key);
    out.set(id, { ref, written: valueOf(next, ref.section, ref.key), replaced });
  }
  return out;
}

/** Keys an external version reverted to what the editor's writes had replaced. */
export function findClobberedLocaleKeys(
  ledger: LocaleLedger,
  external: LocaleTable
): Array<LocaleKeyRef & { readonly written: string | null }> {
  const clobbered: Array<LocaleKeyRef & { readonly written: string | null }> = [];
  for (const { ref, written, replaced } of ledger.values()) {
    const e = valueOf(external, ref.section, ref.key);
    if (written !== replaced && e === replaced && e !== written) {
      clobbered.push({ ...ref, written });
    }
  }
  return clobbered;
}
