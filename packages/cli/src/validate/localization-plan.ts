import { parse as parseYaml } from 'yaml';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import type { ProjectFiles } from './project.ts';
import { isRecord } from './yaml-doc.ts';

// No runtime import: `pix3 play --locale all` reads the plan from Node source (`resource-files.ts`
// imports the runtime, so only the bundled validate may load it).

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
  if (project.has(PROJECT_MANIFEST_FILE)) {
    try {
      const manifest = parseYaml(project.readText(PROJECT_MANIFEST_FILE)) as unknown;
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
