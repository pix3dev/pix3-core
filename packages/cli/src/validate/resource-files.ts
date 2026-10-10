import { parse as parseYaml } from 'yaml';

import { diagnostic, type Diagnostic, type DiagnosticCode } from './diagnostics.ts';
import { toProjectPath, type ProjectFiles } from './project.ts';
import { inspectProjectSvg, isSvgPath } from './svg.ts';
import { formatPath, isRecord, parseYamlWithLines, type DocPath } from './yaml-doc.ts';

/**
 * The project files a scene reaches through another file: the frames a `.pix3anim` names, and the
 * locale tables (`locales/<id>.json`) a `labelKey` is looked up in. Level 1, no project code.
 *
 * Severity follows what the player would see. A `.pix3anim` frame that does not load is a sprite
 * that draws nothing: an error, as for a scene's own reference. A locale table is an error when it
 * is the default or the fallback locale's — the runtime keeps an empty table and every `labelKey`
 * shows the key itself — and a warning for any other declared locale, whose texts fall back to
 * the fallback locale's (a wrong language, but readable). Recorded in `.plans/kit.md` (K9).
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

export interface LocalizationPlan {
  readonly defaultLocale: string;
  readonly fallbackLocale: string;
  readonly locales: readonly string[];
  /** True when `pix3project.yaml` declares the block; false when the tables were discovered. */
  readonly declared: boolean;
}

/**
 * The locales a game loads, the way the plugin decides it (`vite-plugin` `project-manifest.ts`
 * `normalizeLocalization`, `scan.ts` `discoverLocalization`): the `localization:` block of
 * `pix3project.yaml` (`defaultLocale`, else the first of `locales`), else every `locales/*.json`
 * (`en` the default when there is one). Null: the project is not localised.
 */
export const resolveLocalization = (project: ProjectFiles): LocalizationPlan | null => {
  let block: unknown;
  if (project.has('pix3project.yaml')) {
    try {
      const manifest = parseYaml(project.readText('pix3project.yaml')) as unknown;
      block = isRecord(manifest) ? manifest.localization : undefined;
    } catch {
      block = undefined;
    }
  }
  if (isRecord(block)) {
    const locales = Array.isArray(block.locales)
      ? [...new Set(block.locales.filter((l): l is string => typeof l === 'string' && l !== ''))]
      : [];
    const defaultLocale =
      typeof block.defaultLocale === 'string' && block.defaultLocale
        ? block.defaultLocale
        : (locales[0] ?? '');
    if (defaultLocale) {
      const fallbackLocale =
        typeof block.fallbackLocale === 'string' && block.fallbackLocale
          ? block.fallbackLocale
          : defaultLocale;
      return {
        defaultLocale,
        fallbackLocale,
        locales: locales.includes(defaultLocale) ? locales : [defaultLocale, ...locales],
        declared: true,
      };
    }
  }
  const ids = project.files
    .map(file => /^locales\/([^/]+)\.json$/.exec(file)?.[1] ?? null)
    .filter((id): id is string => id !== null)
    .sort();
  if (ids.length === 0) return null;
  const defaultLocale = ids.includes('en') ? 'en' : ids[0];
  return { defaultLocale, fallbackLocale: defaultLocale, locales: ids, declared: false };
};

export const localeTablePath = (locale: string): string => `locales/${locale}.json`;

/** `strings` of each table that loads (only string values — what the runtime keeps). */
export type LocaleStrings = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** Where `pix3project.yaml` names a locale, for a diagnostic about its missing table. */
const manifestPathOf = (plan: LocalizationPlan, locale: string): DocPath =>
  plan.defaultLocale === locale
    ? ['localization', 'defaultLocale']
    : plan.fallbackLocale === locale
      ? ['localization', 'fallbackLocale']
      : ['localization', 'locales', plan.locales.indexOf(locale)];

/**
 * Every table the plan loads: it exists, is a JSON object, and its `strings` / `sprites` are flat
 * maps of strings (the runtime silently drops anything else). Returns the strings of the tables
 * that load, for {@link checkLabelKeys}.
 */
export const checkLocaleTables = (
  project: ProjectFiles,
  plan: LocalizationPlan
): { diagnostics: Diagnostic[]; strings: LocaleStrings } => {
  const diagnostics: Diagnostic[] = [];
  const strings = new Map<string, Record<string, string>>();
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
        const parsed = parseYamlWithLines(project.readText('pix3project.yaml'));
        line = 'errors' in parsed ? undefined : parsed.lineOf(at);
      }
      diagnostics.push(
        diagnostic({
          code: code('LOCALE_MISSING'),
          file: plan.declared ? 'pix3project.yaml' : table,
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
    strings.set(locale, kept);
  }
  return { diagnostics, strings };
};

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
  strings: LocaleStrings,
  uses: readonly LabelKeyUse[]
): Diagnostic[] => {
  const primary = strings.get(plan.defaultLocale);
  if (!primary) return [];
  const fallback = strings.get(plan.fallbackLocale);
  const table = localeTablePath(plan.defaultLocale);
  return uses
    .filter(use => !primary[use.key] && !fallback?.[use.key])
    .map(use =>
      diagnostic({
        code: 'E_LOCALE_KEY',
        file: use.file,
        nodeId: use.nodeId,
        path: use.path,
        line: use.line,
        message: `labelKey "${use.key}" has no text in ${table}${plan.fallbackLocale !== plan.defaultLocale ? ` nor in ${localeTablePath(plan.fallbackLocale)}` : ''}: the node shows "${use.key}" on screen.`,
        fix: `add "${use.key}": "<text>" to "strings" of ${table} (and the other locales)`,
      })
    );
};
