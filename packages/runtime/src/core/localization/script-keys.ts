/** A localization call with a string-literal key, found in a script's source text. */
export interface ScriptLocalizationKey {
  readonly fn: 'tr' | 'trSprite' | 'trPlural' | 'setTextKey';
  readonly key: string;
  /** 1-based line of the call. */
  readonly line: number;
}

const SCRIPT_CALL_RE = /\b(tr|trSprite|trPlural|setTextKey)\s*\(\s*(['"`])([^'"`\r\n]+?)\2/g;

/**
 * The keys a script passes to `tr` / `trSprite` / `trPlural` / `setTextKey` as a string literal.
 * A computed key (a variable, an interpolated template) is not a static key and is skipped. Text
 * only — shared by the editor's localization Scan and `pix3 validate`, so both read the same keys.
 */
export function scanScriptLocalizationKeys(text: string): ScriptLocalizationKey[] {
  const hits: ScriptLocalizationKey[] = [];
  for (const match of text.matchAll(SCRIPT_CALL_RE)) {
    if (match[3].includes('${')) continue;
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    hits.push({ fn: match[1] as ScriptLocalizationKey['fn'], key: match[3], line });
  }
  return hits;
}
