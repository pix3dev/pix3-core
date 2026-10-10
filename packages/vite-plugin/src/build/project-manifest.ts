import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * The part of `pix3project.yaml` the player and the build read (plan §B.5 «scene-manifest из
 * pix3project.yaml»). A Node-side subset of the editor's `normalizeProjectManifest`
 * (`packages/editor-core/src/core/ProjectManifest.ts`): same defaults, same clamps, so a build and
 * the editor's play mode agree on viewport, quality, fonts and locales.
 */

export const PROJECT_MANIFEST_FILE = 'pix3project.yaml';

export interface QualitySettings {
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly maxPixelRatio: number;
}

export interface ProjectFontFace {
  readonly family: string;
  readonly path: string;
  readonly weight?: number | string;
  readonly style?: 'normal' | 'italic';
  readonly unicodeRange?: string;
}

export interface LocalizationSettings {
  readonly defaultLocale: string;
  readonly fallbackLocale?: string;
  readonly locales: readonly string[];
}

/** One `autoloads:` entry (the runtime's `AutoloadConfig`). */
export interface AutoloadEntry {
  readonly singleton: string;
  readonly scriptPath: string;
  readonly enabled: boolean;
}

export interface ProjectManifestInfo {
  readonly projectName: string;
  /** `defaultExportScenePath` without `res://`, or null. */
  readonly defaultScenePath: string | null;
  readonly viewportBaseSize: { readonly width: number; readonly height: number };
  readonly quality: QualitySettings;
  readonly fonts: readonly ProjectFontFace[];
  /** The manifest's `localization` block, normalised; null = inert. */
  readonly localization: LocalizationSettings | null;
  /** The `autoloads:` list, read as the runtime's `normalizeAutoloads` reads it. */
  readonly autoloads: readonly AutoloadEntry[];
}

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
const MIN_VIEWPORT = 64;
const MIN_PIXEL_RATIO = 1;
const MAX_PIXEL_RATIO = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const qualityFor = (platform: string): QualitySettings => {
  switch (platform) {
    case 'mobile':
      return { antialias: false, shadows: false, maxPixelRatio: 2 };
    case 'desktop':
      return { antialias: true, shadows: true, maxPixelRatio: 3 };
    default:
      return { antialias: true, shadows: true, maxPixelRatio: 2 };
  }
};

const normalizeQuality = (input: unknown, platform: string): QualitySettings => {
  const defaults = qualityFor(platform);
  if (!isRecord(input)) return defaults;
  const rawRatio = Number(input.maxPixelRatio);
  return {
    antialias: typeof input.antialias === 'boolean' ? input.antialias : defaults.antialias,
    shadows: typeof input.shadows === 'boolean' ? input.shadows : defaults.shadows,
    maxPixelRatio: Number.isFinite(rawRatio)
      ? Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, rawRatio))
      : defaults.maxPixelRatio,
  };
};

const normalizeViewport = (input: unknown): { width: number; height: number } => {
  const record = isRecord(input) ? input : {};
  const width = Number(record.width);
  const height = Number(record.height);
  return {
    width: Math.max(
      MIN_VIEWPORT,
      Number.isFinite(width) ? Math.round(width) : DEFAULT_VIEWPORT.width
    ),
    height: Math.max(
      MIN_VIEWPORT,
      Number.isFinite(height) ? Math.round(height) : DEFAULT_VIEWPORT.height
    ),
  };
};

const normalizeFonts = (input: unknown): ProjectFontFace[] => {
  if (!Array.isArray(input)) return [];
  const out: ProjectFontFace[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const family = typeof entry.family === 'string' ? entry.family.trim() : '';
    const path = typeof entry.path === 'string' ? stripRes(entry.path.trim()) : '';
    if (!family || !path) continue;
    const weight =
      typeof entry.weight === 'number' || typeof entry.weight === 'string' ? entry.weight : 400;
    const style = entry.style === 'italic' ? 'italic' : 'normal';
    const key = `${family}|${weight}|${style}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const unicodeRange =
      typeof entry.unicodeRange === 'string' && entry.unicodeRange.trim()
        ? entry.unicodeRange.trim()
        : undefined;
    out.push({ family, path, weight, style, ...(unicodeRange ? { unicodeRange } : {}) });
  }
  return out;
};

const normalizeLocalization = (input: unknown): LocalizationSettings | null => {
  if (!isRecord(input)) return null;
  const locales = Array.isArray(input.locales)
    ? [...new Set(input.locales.filter((l): l is string => typeof l === 'string' && l.length > 0))]
    : [];
  const declaredDefault =
    typeof input.defaultLocale === 'string' && input.defaultLocale.length > 0
      ? input.defaultLocale
      : (locales[0] ?? '');
  if (!declaredDefault) return null;
  const finalLocales = locales.includes(declaredDefault) ? locales : [declaredDefault, ...locales];
  const fallbackLocale =
    typeof input.fallbackLocale === 'string' && input.fallbackLocale.length > 0
      ? input.fallbackLocale
      : undefined;
  return {
    defaultLocale: declaredDefault,
    ...(fallbackLocale ? { fallbackLocale } : {}),
    locales: finalLocales,
  };
};

/**
 * Same rule as the runtime's `normalizeAutoloads` (this side of the plugin does not import the
 * runtime): entries need a `singleton` and a `scriptPath`, `enabled` defaults to true, a repeated
 * singleton keeps its first entry.
 */
const normalizeAutoloads = (input: unknown): AutoloadEntry[] => {
  if (!Array.isArray(input)) return [];
  const out: AutoloadEntry[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const scriptPath = typeof entry.scriptPath === 'string' ? entry.scriptPath.trim() : '';
    const singleton = typeof entry.singleton === 'string' ? entry.singleton.trim() : '';
    if (!scriptPath || !singleton || seen.has(singleton)) continue;
    seen.add(singleton);
    out.push({ singleton, scriptPath, enabled: entry.enabled !== false });
  }
  return out;
};

/** `res://x`, `./x`, `/x` → `x`. */
export const stripRes = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');

/** Parse the manifest text (an empty or malformed manifest yields the defaults). */
export const parseProjectManifest = (text: string, fallbackName: string): ProjectManifestInfo => {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(text);
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const platform = typeof record.targetPlatform === 'string' ? record.targetPlatform : 'universal';
  const defaultScene =
    typeof record.defaultExportScenePath === 'string' && record.defaultExportScenePath.trim()
      ? stripRes(record.defaultExportScenePath.trim())
      : null;
  return {
    projectName:
      typeof metadata.projectName === 'string' && metadata.projectName.trim()
        ? metadata.projectName.trim()
        : fallbackName,
    defaultScenePath: defaultScene,
    viewportBaseSize: normalizeViewport(record.viewportBaseSize),
    quality: normalizeQuality(record.quality, platform.toLowerCase()),
    fonts: normalizeFonts(record.fonts),
    localization: normalizeLocalization(record.localization),
    autoloads: normalizeAutoloads(record.autoloads),
  };
};

/** The manifest of the project at `root` (defaults when there is none). */
export const readProjectManifest = (root: string): ProjectManifestInfo => {
  let text = '';
  try {
    text = readFileSync(join(root, PROJECT_MANIFEST_FILE), 'utf8');
  } catch {
    text = '';
  }
  return parseProjectManifest(text, basename(root));
};
