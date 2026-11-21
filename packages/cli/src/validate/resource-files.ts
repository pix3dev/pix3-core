import { PROJECT_SCRIPT_EXCLUDE_PATTERN, scanScriptLocalizationKeys } from '@pix3/runtime';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import type { LocalizationPlan } from './localization-plan.ts';
import { diagnostic, type Diagnostic, type DiagnosticCode } from './diagnostics.ts';
import { toProjectPath, type ProjectFiles } from './project.ts';
import { inspectProjectSvg, isSvgPath } from './svg.ts';
import { formatPath, isRecord, parseYamlWithLines, type DocPath } from './yaml-doc.ts';

/**
 * The project files a scene reaches through another file: the frames a `.pix3anim` names, the
 * locale tables (`locales/<id>.json`) and the images their `sprites` name, and the keys looked up
 * in them — a node's `labelKey` / `textureKey` / `stateTextureKeys`, a script's literal
 * `tr('…')`. Level 1, no project code runs (scripts are read as text).
 *
 * Severity follows what the player would see. A `.pix3anim` frame that does not load is a sprite
 * that draws nothing: an error, as for a scene's own reference. A locale table is an error when it
 * is the default or the fallback locale's — the runtime keeps an empty table and every `labelKey`
 * shows the key itself — and a warning for any other declared locale, whose texts fall back to
 * the fallback locale's (a wrong language, but readable). Recorded in `.plans/done/kit.md` (K9).
 */

// --- .pix3anim -----------------------------------------------------------------------------------

export const ANIMATION_EXTENSION = '.pix3anim';

/** 1-based line of `path` in a JSON text (JSON is YAML), when it parses as YAML too. */
const lineFinder = (text: string): ((path: DocPath) => number | undefined) => {
  const parsed = parseYamlWithLines(text);
  return 'errors' in parsed ? () => undefined : path => parsed.lineOf(path);
};

/**
 * One `.pix3anim`: it must be a JSON object the loader can read, and every image it names — each
 * sequence frame's `texturePath`, the spritesheet's top-level `texturePath` — must exist and, for
 * an `.svg`, pass the sprite rules (`E_SVG_*`, `svg.ts`).
 */
export const checkAnimationFile = (project: ProjectFiles, file: string): Diagnostic[] => {
  const out: Diagnostic[] = [];
  let text: string;
  try {
    text = project.readText(file);
  } catch {
    return out;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    out.push(
      diagnostic({
        code: 'E_ANIM_JSON',
        file,
        message: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}): the AnimatedSprite2D that plays it draws nothing.`,
        fix: 'a .pix3anim is JSON — see pix3anim.md in the pix3-scene-format skill',
      })
    );
    return out;
  }
  const lineOf = lineFinder(text);
  const report = (code: DiagnosticCode, at: DocPath, message: string, fix?: string): void => {
    out.push(diagnostic({ code, file, path: formatPath(at), line: lineOf(at), message, fix }));
  };
  if (!isRecord(data)) {
    report(
      'E_ANIM_JSON',
      [],
      `${file} must be a JSON object ({ "version", "texturePath", "clips" }), got ${Array.isArray(data) ? 'a list' : data === null ? 'null' : typeof data}.`
    );
    return out;
  }
  if (data.clips !== undefined && !Array.isArray(data.clips)) {
    report('E_ANIM_JSON', ['clips'], '"clips" must be a list of clips: the loader finds none.');
  }
  const images: Array<{ value: string; at: DocPath; what: string }> = [];
  if (typeof data.texturePath === 'string' && data.texturePath.trim()) {
    images.push({ value: data.texturePath, at: ['texturePath'], what: 'the spritesheet' });
  }
  const clips = Array.isArray(data.clips) ? data.clips : [];
  clips.forEach((clip, clipIndex) => {
    if (!isRecord(clip) || !Array.isArray(clip.frames)) return;
    const name = typeof clip.name === 'string' && clip.name ? clip.name : `#${clipIndex + 1}`;
    clip.frames.forEach((frame, frameIndex) => {
      if (!isRecord(frame) || typeof frame.texturePath !== 'string' || !frame.texturePath.trim())
        return;
      images.push({
        value: frame.texturePath,
        at: ['clips', clipIndex, 'frames', frameIndex, 'texturePath'],
        what: `clip "${name}" frame ${frameIndex + 1}`,
      });
    });
  });
  const svgChecked = new Set<string>();
  for (const { value, at, what } of images) {
    const target = toProjectPath(value);
    if (!target) continue;
    if (!project.has(target)) {
      const caseMatch = project.files.find(f => f.toLowerCase() === target.toLowerCase());
      report(
        'E_MISSING_FRAME',
        at,
        `${what}: ${value} does not exist in the project — the sprite draws nothing on that frame.`,
        caseMatch ? `the file is res://${caseMatch} (case differs)` : undefined
      );
      continue;
    }
    if (!isSvgPath(target) || svgChecked.has(target)) continue;
    svgChecked.add(target);
    for (const finding of inspectProjectSvg(project, target)) {
      report(finding.code, at, `${what}: ${value}: ${finding.message}`, finding.fix);
    }
  }
  return out;
};

// --- locale tables -------------------------------------------------------------------------------

export const localeTablePath = (locale: string): string => `locales/${locale}.json`;

/** `strings` and `sprites` of each table that loads (only string values — what the runtime keeps). */
export interface LocaleEntries {
  readonly strings: Readonly<Record<string, string>>;
  readonly sprites: Readonly<Record<string, string>>;
  /** `$meta.sameAsDefault`: keys whose text is meant to equal the default locale's (a brand name). */
  readonly sameAsDefault: ReadonlySet<string>;
}
export type LoadedLocales = ReadonlyMap<string, LocaleEntries>;

/** Where `pix3project.yaml` names a locale, for a diagnostic about its missing table. */
const manifestPathOf = (plan: LocalizationPlan, locale: string): DocPath =>
  plan.defaultLocale === locale
    ? ['localization', 'defaultLocale']
    : plan.fallbackLocale === locale
      ? ['localization', 'fallbackLocale']
      : ['localization', 'locales', plan.locales.indexOf(locale)];

/**
 * Every table the plan loads: it exists, is a JSON object, its `strings` / `sprites` are flat maps
 * of strings (the runtime silently drops anything else), and every image its `sprites` name exists
 * (and, for an `.svg`, passes the sprite rules). Returns the entries of the tables that load, for
 * {@link checkLabelKeys}, {@link checkSpriteKeys} and {@link checkScriptKeys}.
 */
export const checkLocaleTables = (
  project: ProjectFiles,
  plan: LocalizationPlan
): { diagnostics: Diagnostic[]; tables: LoadedLocales } => {
  const diagnostics: Diagnostic[] = [];
  const strings = new Map<string, LocaleEntries>();
  const ids = [...new Set([plan.defaultLocale, plan.fallbackLocale, ...plan.locales])];
  for (const locale of ids) {
    const critical = locale === plan.defaultLocale || locale === plan.fallbackLocale;
    const role =
      locale === plan.defaultLocale
        ? 'the default locale'
        : critical
          ? 'the fallback locale'
          : 'a declared locale';
    const consequence = critical
      ? 'every labelKey shows the key itself'
      : `its texts fall back to ${plan.fallbackLocale}`;
    const table = localeTablePath(locale);
    const code = (base: 'LOCALE_MISSING' | 'LOCALE_JSON' | 'LOCALE_VALUE'): DiagnosticCode =>
      `${critical ? 'E' : 'W'}_${base}` as DiagnosticCode;
    if (!project.has(table)) {
      let line: number | undefined;
      const at = manifestPathOf(plan, locale);
      if (plan.declared) {
        const parsed = parseYamlWithLines(project.readText(PROJECT_MANIFEST_FILE));
        line = 'errors' in parsed ? undefined : parsed.lineOf(at);
      }
      diagnostics.push(
        diagnostic({
          code: code('LOCALE_MISSING'),
          file: plan.declared ? PROJECT_MANIFEST_FILE : table,
          ...(plan.declared ? { path: formatPath(at), line } : {}),
          message: `${role} "${locale}" has no table ${table}: the game loads it empty — ${consequence}.`,
          fix: `write ${table} (copy the default locale's table), or drop "${locale}" from localization:`,
        })
      );
      continue;
    }
    const text = project.readText(table);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      diagnostics.push(
        diagnostic({
          code: code('LOCALE_JSON'),
          file: table,
          message: `${table} is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${role} "${locale}" loads empty — ${consequence}.`,
          fix: '{ "$meta": { "locale": "…" }, "strings": { "key": "text" }, "sprites": {} }',
        })
      );
      continue;
    }
    const lineOf = lineFinder(text);
    if (!isRecord(data)) {
      diagnostics.push(
        diagnostic({
          code: code('LOCALE_JSON'),
          file: table,
          message: `${table} must be a JSON object with "strings" (and "sprites"): ${role} "${locale}" loads empty — ${consequence}.`,
        })
      );
      continue;
    }
    const kept: Record<string, string> = {};
    const keptSprites: Record<string, string> = {};
    for (const section of ['strings', 'sprites'] as const) {
      const map = data[section];
      if (map === undefined) continue;
      if (!isRecord(map)) {
        diagnostics.push(
          diagnostic({
            code: code('LOCALE_JSON'),
            file: table,
            path: section,
            line: lineOf([section]),
            message: `"${section}" of ${table} must be an object of key → ${section === 'strings' ? 'text' : 'res:// image'}; the runtime reads none of it — ${consequence}.`,
          })
        );
        continue;
      }
      for (const [key, value] of Object.entries(map)) {
        if (typeof value === 'string') {
          if (section === 'strings') kept[key] = value;
          else {
            keptSprites[key] = value;
            diagnostics.push(...checkLocaleSpriteImage(project, table, key, value, lineOf));
          }
          continue;
        }
        diagnostics.push(
          diagnostic({
            code: code('LOCALE_VALUE'),
            file: table,
            path: formatPath([section, key]),
            line: lineOf([section, key]),
            message: `${section}."${key}" in ${table} is ${Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value === 'object' ? 'an object' : `a ${typeof value}`}, not a string: the runtime drops it${critical ? ' and the key shows as itself' : `, the text falls back to ${plan.fallbackLocale}`}.`,
            fix: isRecord(value)
              ? `keys are flat: "${key}.${Object.keys(value)[0] ?? 'name'}": "…"`
              : `write it as a string: "${key}": "${String(value)}"`,
          })
        );
      }
    }
    strings.set(locale, {
      strings: kept,
      sprites: keptSprites,
      sameAsDefault: readSameAsDefault(data, table, lineOf, diagnostics),
    });
  }
  return { diagnostics, tables: strings };
};

/**
 * One image a table's `sprites` names: it must exist, or every node keyed to it draws nothing in
 * that locale — the table wins over the node's own texture and there is no further fallback, so
 * this is an error in any locale (unlike the text codes, whose other-locale problems fall back).
 */
const checkLocaleSpriteImage = (
  project: ProjectFiles,
  table: string,
  key: string,
  value: string,
  lineOf: (path: DocPath) => number | undefined
): Diagnostic[] => {
  const target = toProjectPath(value);
  if (!target) return [];
  const at: DocPath = ['sprites', key];
  const where = { file: table, path: formatPath(at), line: lineOf(at) };
  if (!project.has(target)) {
    const caseMatch = project.files.find(f => f.toLowerCase() === target.toLowerCase());
    return [
      diagnostic({
        code: 'E_MISSING_LOCALE_SPRITE',
        ...where,
        message: `sprites."${key}" in ${table} is ${value}, which does not exist in the project: a node keyed to "${key}" draws nothing in this locale.`,
        fix: caseMatch ? `the file is res://${caseMatch} (case differs)` : undefined,
      }),
    ];
  }
  if (!isSvgPath(target)) return [];
  return inspectProjectSvg(project, target).map(finding =>
    diagnostic({
      code: finding.code,
      ...where,
      message: `sprites."${key}": ${value}: ${finding.message}`,
      fix: finding.fix,
    })
  );
};

/**
 * `$meta.sameAsDefault` of a table: a list of keys. Anything else is a `W_LOCALE_JSON` in every
 * locale — the runtime never reads it, so the game is unaffected; only the parity check loses it.
 */
const readSameAsDefault = (
  data: Record<string, unknown>,
  table: string,
  lineOf: (path: DocPath) => number | undefined,
  diagnostics: Diagnostic[]
): ReadonlySet<string> => {
  const meta = data.$meta;
  const list = isRecord(meta) ? meta.sameAsDefault : undefined;
  if (list === undefined) return new Set();
  if (Array.isArray(list) && list.every(key => typeof key === 'string')) return new Set(list);
  const at: DocPath = ['$meta', 'sameAsDefault'];
  diagnostics.push(
    diagnostic({
      code: 'W_LOCALE_JSON',
      file: table,
      path: formatPath(at),
      line: lineOf(at),
      message: `"$meta.sameAsDefault" of ${table} must be a list of keys; pix3 validate ignores it.`,
      fix: '"$meta": { "sameAsDefault": ["brand.name"] }',
    })
  );
  return new Set();
};

// --- locale parity -------------------------------------------------------------------------------

const PLURAL_KEY = /^(.+)\.(zero|one|two|few|many|other)$/;

/**
 * The CLDR plural categories `trPlural` picks (`Intl.PluralRules`, as the runtime) for a count from
 * 0 to 1000 in `locale`: `es` / `fr` / `it` have a `many` only for millions, which their `.other`
 * covers as well.
 */
const pluralCategoriesOf = (locale: string): readonly string[] => {
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    return ['other'];
  }
  const used = new Set<string>(['other']);
  for (let count = 0; count <= 1000; count++) used.add(rules.select(count));
  return rules.resolvedOptions().pluralCategories.filter(category => used.has(category));
};

/**
 * The plurals of one table: a prefix with a non-empty `<prefix>.<category>` for a category other
 * than `other` that the locale's plural rules use (`level.two` is not an English plural form) →
 * the categories it has.
 */
const pluralsOf = (
  strings: Readonly<Record<string, string>>,
  locale: string
): Map<string, Set<string>> => {
  const used = new Set(pluralCategoriesOf(locale));
  const groups = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(strings)) {
    const match = PLURAL_KEY.exec(key);
    if (!match || !value || !used.has(match[2])) continue;
    groups.set(match[1], (groups.get(match[1]) ?? new Set()).add(match[2]));
  }
  for (const [prefix, categories] of groups) {
    if (categories.size === 1 && categories.has('other')) groups.delete(prefix);
  }
  return groups;
};

/** Unicode scripts (`\p{Script=…}` values) a locale writes in, from its likely script. */
const scriptsOf = (locale: string): readonly string[] => {
  let script: string | undefined;
  try {
    script = new Intl.Locale(locale).maximize().script;
  } catch {
    return [];
  }
  switch (script) {
    case undefined:
      return [];
    case 'Jpan':
      return ['Hani', 'Hira', 'Kana'];
    case 'Kore':
      return ['Hang', 'Hani'];
    case 'Hans':
    case 'Hant':
      return ['Hani'];
    default:
      return [script];
  }
};

const scriptPattern = (script: string): RegExp | null => {
  try {
    return new RegExp(`\\p{Script=${script}}`, 'u');
  } catch {
    return null;
  }
};

const languageOf = (locale: string): string => {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return locale;
  }
};

/** A text without its `{param}` tokens. */
const withoutParams = (text: string): string => text.replace(/\{[^{}]*\}/g, '');
const letterCount = (text: string): number => text.match(/\p{L}/gu)?.length ?? 0;
const wordCount = (text: string): number =>
  text.split(/\s+/).filter(word => /\p{L}/u.test(word)).length;

/**
 * Every other locale against the default one, on whole-project runs (warnings — the game falls
 * back, it does not break):
 *
 * - `W_LOCALE_KEY_MISSING` — a key the default table has text for and the other has not (or has
 *   empty): that locale shows the fallback locale's text. A plural is compared by the categories
 *   the other locale uses (`ru` needs `few` and `many`, `ja` only `other`).
 * - `W_LOCALE_PLURAL_OTHER` — in any table, a plural with neither `<key>.other` nor `<key>`: a
 *   count with no form of its own falls through `trPlural` to another locale's text or the key.
 * - `W_LOCALE_UNTRANSLATED` — the text is the default's, word for word, in at least two words
 *   (one word is too often the same in both languages: Taxi, Radio, Hammer), or it is written in
 *   the default locale's script and not in its own (Cyrillic in `en`). Keys listed in the table's
 *   `$meta.sameAsDefault` are skipped.
 *
 * Literal text a script draws without `tr()` is not seen.
 */
export const checkLocaleParity = (
  project: ProjectFiles,
  plan: LocalizationPlan,
  tables: LoadedLocales
): Diagnostic[] => {
  const base = tables.get(plan.defaultLocale);
  if (!base) return [];
  const out: Diagnostic[] = [];
  const basePlurals = pluralsOf(base.strings, plan.defaultLocale);
  const baseScripts = scriptsOf(plan.defaultLocale);
  for (const [locale, entries] of tables) {
    const table = localeTablePath(locale);
    const lineOf = lineFinder(project.readText(table));
    const report = (code: DiagnosticCode, key: string, message: string, fix?: string): void => {
      const at: DocPath = ['strings', key];
      out.push(
        diagnostic({ code, file: table, path: formatPath(at), line: lineOf(at), message, fix })
      );
    };
    const strings = entries.strings;
    for (const [prefix, categories] of pluralsOf(strings, locale)) {
      if (strings[`${prefix}.other`] || strings[prefix]) continue;
      const first = [...categories][0];
      report(
        'W_LOCALE_PLURAL_OTHER',
        `${prefix}.${first}`,
        `"${prefix}" is a plural (${[...categories].map(c => `.${c}`).join(', ')}) with no "${prefix}.other" in ${table}: trPlural('${prefix}', n) for a count none of them covers shows ${locale === plan.fallbackLocale ? `"${prefix}"` : `the ${plan.fallbackLocale} text or "${prefix}"`}.`,
        `add "${prefix}.other": "…" (the form for any other count)`
      );
    }
    if (locale === plan.defaultLocale) continue;
    const consequence =
      locale === plan.fallbackLocale
        ? 'the game shows the key itself in this locale'
        : `the game shows the ${plan.fallbackLocale} text in this locale`;
    const categories = pluralCategoriesOf(locale);
    for (const [prefix] of basePlurals) {
      const has = categories.filter(c => strings[`${prefix}.${c}`]);
      if (has.length === 0 && !strings[prefix]) {
        report(
          'W_LOCALE_KEY_MISSING',
          `${prefix}.other`,
          `plural "${prefix}" has text in ${localeTablePath(plan.defaultLocale)} but no form in ${table}: ${consequence}.`,
          `add ${categories.map(c => `"${prefix}.${c}"`).join(', ')} to "strings" of ${table}`
        );
        continue;
      }
      for (const category of categories) {
        if (category === 'other' || strings[`${prefix}.${category}`]) continue;
        report(
          'W_LOCALE_KEY_MISSING',
          `${prefix}.${category}`,
          `plural "${prefix}" has no "${category}" form in ${table} (${locale} uses ${categories.join(', ')}): such a count takes "${prefix}.other".`,
          `add "${prefix}.${category}": "…" to "strings" of ${table}`
        );
      }
    }
    const ownScripts = scriptsOf(locale);
    const patterns = (scripts: readonly string[]): RegExp[] =>
      scripts.map(scriptPattern).filter((re): re is RegExp => re !== null);
    const foreign = patterns(baseScripts.filter(script => !ownScripts.includes(script)));
    const own = patterns(ownScripts);
    const sameLanguage = languageOf(locale) === languageOf(plan.defaultLocale);
    for (const [key, source] of Object.entries(base.strings)) {
      if (!source) continue;
      const plural = PLURAL_KEY.exec(key);
      if (plural && basePlurals.has(plural[1])) continue;
      const text = strings[key];
      if (!text) {
        report(
          'W_LOCALE_KEY_MISSING',
          key,
          `"${key}" has text in ${localeTablePath(plan.defaultLocale)} but ${text === '' ? 'is empty' : 'not'} in ${table}: ${consequence}.`,
          `add "${key}": "<${locale} text>" to "strings" of ${table}`
        );
        continue;
      }
      if (entries.sameAsDefault.has(key)) continue;
      const words = withoutParams(text);
      if (letterCount(words) <= 3) continue;
      const copied = !sameLanguage && text === source && wordCount(words) >= 2;
      const wrongScript = foreign.some(re => re.test(words)) && !own.some(re => re.test(words));
      if (!copied && !wrongScript) continue;
      report(
        'W_LOCALE_UNTRANSLATED',
        key,
        copied
          ? `"${key}" in ${table} is the ${plan.defaultLocale} text word for word ("${text}"): not translated?`
          : `"${key}" in ${table} is written in the ${plan.defaultLocale} script, not ${locale}'s ("${text}"): not translated?`,
        `translate it, or list "${key}" in "$meta": { "sameAsDefault": [...] } of ${table} when it is meant to stay`
      );
    }
  }
  return out;
};

/** Whether a key has a non-empty entry in the default or the fallback table (`LocalizationService`'s
 *  chain); null when the default table did not load — that is its own error, nothing more is said. */
const lookup = (
  plan: LocalizationPlan,
  tables: LoadedLocales,
  section: 'strings' | 'sprites'
): ((key: string) => boolean) | null => {
  const primary = tables.get(plan.defaultLocale)?.[section];
  if (!primary) return null;
  const fallback = tables.get(plan.fallbackLocale)?.[section];
  return key => Boolean(primary[key] || fallback?.[key]);
};

const tablesNamed = (plan: LocalizationPlan): string =>
  `${localeTablePath(plan.defaultLocale)}${plan.fallbackLocale !== plan.defaultLocale ? ` nor in ${localeTablePath(plan.fallbackLocale)}` : ''}`;

/** A `labelKey` a scene sets on a node (collected by level 1). */
export interface LabelKeyUse {
  readonly file: string;
  readonly key: string;
  readonly nodeId?: string;
  readonly path: string;
  readonly line?: number;
}

/**
 * A `labelKey` the default locale (or, failing it, the fallback locale) has no text for: at boot
 * the node shows the key itself (`LocalizationService.tr`: current → fallback → the key; an empty
 * string counts as untranslated). Nothing is said when the default table did not load — that is
 * already its own error.
 */
export const checkLabelKeys = (
  plan: LocalizationPlan,
  tables: LoadedLocales,
  uses: readonly LabelKeyUse[]
): Diagnostic[] => {
  const has = lookup(plan, tables, 'strings');
  if (!has) return [];
  const table = localeTablePath(plan.defaultLocale);
  return uses
    .filter(use => !has(use.key))
    .map(use =>
      diagnostic({
        code: 'E_LOCALE_KEY',
        file: use.file,
        nodeId: use.nodeId,
        path: use.path,
        line: use.line,
        message: `labelKey "${use.key}" has no text in ${tablesNamed(plan)}: the node shows "${use.key}" on screen.`,
        fix: `add "${use.key}": "<text>" to "strings" of ${table} (and the other locales)`,
      })
    );
};

/** A sprite key a scene sets: `Sprite2D.textureKey`, a `Button2D` state's key (collected by level 1). */
export interface SpriteKeyUse {
  readonly file: string;
  readonly key: string;
  /** How the scene names it: `textureKey`, `stateTextureKeys.hover`, `textureHoverKey`. */
  readonly property: string;
  /** The node has its own texture to show when the key resolves to nothing. */
  readonly hasOwnTexture: boolean;
  readonly nodeId?: string;
  readonly path: string;
  readonly line?: number;
}

/**
 * A sprite key no `sprites` entry of the default (or fallback) table has: `trSprite` gives null and
 * the node keeps its own texture (`Sprite2D.getEffectiveTexturePath`) — the same art in every
 * locale, a warning; a `Sprite2D` with no texture of its own draws nothing, an error.
 */
export const checkSpriteKeys = (
  plan: LocalizationPlan,
  tables: LoadedLocales,
  uses: readonly SpriteKeyUse[]
): Diagnostic[] => {
  const has = lookup(plan, tables, 'sprites');
  if (!has) return [];
  const table = localeTablePath(plan.defaultLocale);
  return uses
    .filter(use => !has(use.key))
    .map(use =>
      diagnostic({
        code: use.hasOwnTexture ? 'W_LOCALE_SPRITE_KEY' : 'E_LOCALE_SPRITE_KEY',
        file: use.file,
        nodeId: use.nodeId,
        path: use.path,
        line: use.line,
        message: `${use.property} "${use.key}" has no image in "sprites" of ${tablesNamed(plan)}: ${use.hasOwnTexture ? 'the node shows its own texture in every locale' : 'the node has no texture of its own and draws nothing'}.`,
        fix: `add "${use.key}": "res://sprites/…" to "sprites" of ${table} (and the other locales)`,
      })
    );
};

/**
 * Code files `checkScriptKeys` reads: every `.ts` / `.js` of the project but what the
 * project-script rule says is not game code — a spec, a test, a declaration
 * (`PROJECT_SCRIPT_EXCLUDE_PATTERN`, the rule the editor, the plugin and the player register by).
 */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const isScriptKeySource = (file: string): boolean =>
  SCRIPT_FILE.test(file) && !PROJECT_SCRIPT_EXCLUDE_PATTERN.test(file);

/**
 * Keys a project script passes to the localization API as a string literal
 * (`scanScriptLocalizationKeys`, the editor's Scan uses the same): `tr` / `setTextKey` with no
 * text in the default (or fallback) table show the key on screen (`E_LOCALE_SCRIPT_KEY`), and so
 * does `trPlural` for every count when neither `<key>.other` nor `<key>` has one (its last two
 * steps); a `trSprite` key with no image gives the script null (`W_LOCALE_SPRITE_KEY`). A key the
 * script computes is not a static key and is not checked.
 */
export const checkScriptKeys = (
  project: ProjectFiles,
  plan: LocalizationPlan,
  tables: LoadedLocales
): Diagnostic[] => {
  const hasText = lookup(plan, tables, 'strings');
  const hasSprite = lookup(plan, tables, 'sprites');
  if (!hasText || !hasSprite) return [];
  const table = localeTablePath(plan.defaultLocale);
  const out: Diagnostic[] = [];
  for (const file of project.files) {
    if (!isScriptKeySource(file)) continue;
    let text: string;
    try {
      text = project.readText(file);
    } catch {
      continue;
    }
    for (const { fn, key, line } of scanScriptLocalizationKeys(text)) {
      const call = `${fn}('${key}')`;
      if (fn === 'trSprite') {
        if (hasSprite(key)) continue;
        out.push(
          diagnostic({
            code: 'W_LOCALE_SPRITE_KEY',
            file,
            line,
            message: `${call}: "${key}" has no image in "sprites" of ${tablesNamed(plan)}, so the script gets null.`,
            fix: `add "${key}": "res://sprites/…" to "sprites" of ${table} (and the other locales)`,
          })
        );
        continue;
      }
      if (fn === 'trPlural' ? hasText(`${key}.other`) || hasText(key) : hasText(key)) continue;
      const wanted = fn === 'trPlural' ? `${key}.other` : key;
      out.push(
        diagnostic({
          code: 'E_LOCALE_SCRIPT_KEY',
          file,
          line,
          message:
            fn === 'trPlural'
              ? `${call}: neither "${key}.other" nor "${key}" has text in ${tablesNamed(plan)}: a count with no "${key}.<one|few|many>" of its own shows "${key}" on screen.`
              : `${call}: "${key}" has no text in ${tablesNamed(plan)}: the game shows "${key}" on screen.`,
          fix: `add "${wanted}": "<text>" to "strings" of ${table} (and the other locales)`,
        })
      );
    }
  }
  return out;
};
