import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { NON_SHIPPABLE_DIRECTORIES } from '../files/scan.ts';
import { RESERVED_ROOT_DIR } from '../files/paths.ts';
import type { LocalizationSettings, ProjectManifestInfo } from './project-manifest.ts';
import { stripRes } from './project-manifest.ts';

/**
 * The build's scan of the project (plan §B.6 item 1): every text source outside `node_modules`,
 * `dist`, `.pix3`, … is read once, and from that one pass come
 *
 * - `mentionedNames` — every identifier-like token (plus `core:Follow`-shaped ids), the superset
 *   the strip asks "does anything mention this module?" (a false positive costs kilobytes, a
 *   false negative would ship a broken game — `.plans/done/playable-export-size.md` §2 Р4);
 * - the asset set: every scene and prefab, everything they and the scripts name by `res://`,
 *   directories those references expand to, Spine atlas pages, the declared locale tables and
 *   their sprites, the project's fonts, a pre-packed atlas manifest;
 * - whether Spine, `postprocessing` or the multiplayer stack are used at all.
 *
 * Node port of 1.x `ProjectBuildService.collectAssetPaths` / `scanMentionedNames`, widened to
 * `src/**` and every other text source as the plan asks (DeepCore imports runtime nodes from
 * `src/`). Scene paths are `res://`-relative (under `resRoot`); the scan reports them without the
 * scheme.
 */

export interface ScanOptions {
  readonly root: string;
  /** Where `res://` points, relative to the root (`'.'` by default). */
  readonly resRoot: string;
  readonly manifest: ProjectManifestInfo;
  /** `pix3({ entryScene })` or `PIX3_ENTRY_SCENE`: a `res://`-relative scene path. */
  readonly entryScene?: string | null;
}

export interface ProjectScan {
  /** Navigable scenes (`res://`-relative, sorted): every `.pix3scene` that is not a prefab. */
  readonly scenePaths: readonly string[];
  /** The scene the player boots into; `''` when the project has no scene. */
  readonly entryScenePath: string;
  /** Every shipped file, `res://`-relative and sorted (scenes and prefabs included). */
  readonly assetPaths: readonly string[];
  readonly mentionedNames: ReadonlySet<string>;
  readonly usesSpine: boolean;
  readonly usesPostProcessing: boolean;
  readonly usesNetwork: boolean;
  /** The effective localization config (manifest block, else discovered `locales/`). */
  readonly localization: LocalizationSettings | null;
  /** Prefab paths for the multiplayer kind table, sorted by code point. */
  readonly netKindPrefabs: readonly string[];
  readonly warnings: readonly string[];
  /** How many text sources were read (for the build log). */
  readonly textSourceCount: number;
}

const TEXT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pix3scene',
  'prefab',
  'pix3anim',
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'yaml',
  'yml',
  'html',
  'css',
  'atlas',
]);
/** Tests and declarations: their mentions would only keep modules the game never runs. */
const NOT_A_SOURCE = /\.(?:spec|test)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|^package-lock\.json$/;
const SCENE_LIKE = /\.(pix3scene|prefab)$/i;
const SCANNABLE_RESOURCE = /\.(pix3scene|prefab|pix3anim)$/i;
const RESOURCE_PATH_PATTERN = /res:\/\/([^\s"'`\])]+)/g;
const MENTIONED_NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*/g;
/** Names that mean "this project talks to the multiplayer stack". */
export const NETWORK_MENTION_NAMES = [
  'network',
  'Network',
  'NetworkService',
  'NetworkedNode',
  'ReplicatedTransform',
  'NetworkedNodeBehavior',
  'ReplicatedTransformBehavior',
  'core:NetworkedNode',
  'core:ReplicatedTransform',
] as const;
const SPINE_PAGE_IMAGE_PATTERN = /\.(png|jpg|jpeg|webp|ktx2|basis|bmp)$/i;
/** Where the editor writes a pre-packed atlas (`ATLAS_MANIFEST_PATH` in the runtime). */
const ATLAS_MANIFEST = 'assets/.atlas/atlas-manifest.json';
const ATLAS_SHEET_DIR = 'assets/.atlas/';

/**
 * A `.pix3scene` that is instantiated rather than navigated to: `prefabs/`, `.prefab`, and
 * `scenes/ui/` overlays (the conventions of the 1.x exporter and `pix3 smoke`).
 */
export const isPrefabPath = (path: string): boolean =>
  /(^|\/)prefabs\//i.test(path) || /\.prefab$/i.test(path) || /(^|\/)scenes\/ui\//i.test(path);

const hasFileExtension = (path: string): boolean => /\.[a-zA-Z0-9]+$/.test(path);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** Page image names declared inside an `.atlas` file (port of `parseSpineAtlasPageNames`). */
export const parseSpineAtlasPageNames = (atlasText: string): string[] => {
  const pages: string[] = [];
  let expectPage = true;
  for (const rawLine of atlasText.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      expectPage = true;
      continue;
    }
    if (expectPage) {
      const candidate = rawLine.trim();
      if (SPINE_PAGE_IMAGE_PATTERN.test(candidate)) pages.push(candidate);
      expectPage = false;
    }
  }
  return pages;
};

const resolveSpinePagePath = (atlasPath: string, pageName: string): string => {
  const name = pageName.trim().replace(/^\.\//, '');
  if (/^[a-z]+[a-z0-9+.-]*:\/\//i.test(name) || name.startsWith('/')) return stripRes(name);
  const separator = atlasPath.lastIndexOf('/');
  return separator < 0 ? name : `${atlasPath.slice(0, separator + 1)}${name}`;
};

/** Every file under `root` as a wire path, excluding tooling, build output and `.pix3/`. */
export const listProjectFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (wireDir: string): Promise<void> => {
    const absolute = wireDir ? join(root, ...wireDir.split('/')) : root;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const wirePath = wireDir ? `${wireDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (NON_SHIPPABLE_DIRECTORIES.has(entry.name)) continue;
        if (!wireDir && entry.name === RESERVED_ROOT_DIR) continue;
        await walk(wirePath);
      } else if (entry.isFile()) {
        out.push(wirePath);
      }
      // Symlinks are neither listed nor followed (the file API's rule, `files/scan.ts`).
    }
  };
  await walk('');
  return out;
};

const isTextSource = (wirePath: string): boolean => {
  const name = wirePath.slice(wirePath.lastIndexOf('/') + 1);
  return TEXT_SOURCE_EXTENSIONS.has(extensionOf(name)) && !NOT_A_SOURCE.test(name);
};

/** The static directory prefix of an interpolated `res://` path, or null (port of 1.x). */
const staticDirectoryPrefix = (resourcePath: string): string | null => {
  const staticPrefix = resourcePath.split('${')[0] ?? '';
  const lastSlash = staticPrefix.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const directory = staticPrefix.slice(0, lastSlash);
  return directory.length > 0 ? directory : null;
};

export const scanProject = async (options: ScanOptions): Promise<ProjectScan> => {
  const { root, manifest } = options;
  const resRoot = stripRes(options.resRoot).replace(/\/+$/, '') || '.';
  const warnings: string[] = [];
  const mentionedNames = new Set<string>();

  const resAbsolute = (resPath: string): string =>
    resRoot === '.'
      ? join(root, ...resPath.split('/'))
      : join(root, resRoot, ...resPath.split('/'));
  const wireToRes = (wirePath: string): string | null => {
    if (resRoot === '.') return wirePath;
    return wirePath.startsWith(`${resRoot}/`) ? wirePath.slice(resRoot.length + 1) : null;
  };

  const wirePaths = await listProjectFiles(root);
  const resFiles = new Set<string>();
  for (const wirePath of wirePaths) {
    const resPath = wireToRes(wirePath);
    if (resPath !== null) resFiles.add(resPath);
  }

  // One pass over every text source: mentions and `res://` references.
  const assets = new Set<string>();
  const directoryQueue: string[] = [];
  const queuedDirectories = new Set<string>();
  const scanQueue: string[] = [];
  const scanned = new Set<string>();
  const addResource = (raw: string): void => {
    const resourcePath = stripRes(raw.trim());
    if (!resourcePath) return;
    if (!hasFileExtension(resourcePath)) {
      if (!queuedDirectories.has(resourcePath)) {
        queuedDirectories.add(resourcePath);
        directoryQueue.push(resourcePath);
      }
      return;
    }
    if (assets.has(resourcePath)) return;
    assets.add(resourcePath);
    if (SCANNABLE_RESOURCE.test(resourcePath) && !scanned.has(resourcePath)) {
      scanQueue.push(resourcePath);
    }
  };
  const collectFromText = (contents: string): void => {
    for (const match of contents.matchAll(MENTIONED_NAME_PATTERN)) mentionedNames.add(match[0]);
    for (const match of contents.matchAll(RESOURCE_PATH_PATTERN)) {
      const resourcePath = (match[1] ?? '').trim();
      if (resourcePath.includes('${') || resourcePath.includes('`')) {
        const prefix = staticDirectoryPrefix(resourcePath);
        if (prefix) addResource(prefix);
      } else {
        addResource(resourcePath);
      }
    }
  };

  let textSourceCount = 0;
  for (const wirePath of wirePaths) {
    if (!isTextSource(wirePath)) continue;
    let contents: string;
    try {
      contents = await readFile(join(root, ...wirePath.split('/')), 'utf8');
    } catch {
      warnings.push(`Could not read ${wirePath}; its references were not scanned.`);
      continue;
    }
    textSourceCount++;
    collectFromText(contents);
    const resPath = wireToRes(wirePath);
    if (resPath !== null && SCANNABLE_RESOURCE.test(resPath)) scanned.add(resPath);
  }

  // Every scene and prefab ships: a game may load any of them at run time.
  const allSceneLike = [...resFiles].filter(path => SCENE_LIKE.test(path)).sort();
  for (const scenePath of allSceneLike) addResource(scenePath);

  // Transitive: a resource reached only through a reference (a `.pix3anim` outside the text
  // walk is impossible here — the walk read everything — but a referenced directory can yield
  // scannable files, and those name more).
  const drain = async (): Promise<void> => {
    while (scanQueue.length > 0 || directoryQueue.length > 0) {
      const scannable = scanQueue.shift();
      if (scannable !== undefined) {
        if (scanned.has(scannable)) continue;
        scanned.add(scannable);
        try {
          collectFromText(await readFile(resAbsolute(scannable), 'utf8'));
        } catch {
          // Missing: reported below, when the asset set is verified against the disk.
        }
        continue;
      }
      const directory = directoryQueue.shift();
      if (directory === undefined) continue;
      const prefix = `${directory}/`;
      for (const resPath of resFiles) {
        if (resPath.startsWith(prefix)) addResource(resPath);
      }
    }
  };
  await drain();

  // Fonts are named only by the manifest, never by a `res://` in a scene.
  for (const face of manifest.fonts) addResource(face.path);

  // Locale tables: only declared (or discovered) locales ship, plus their sprites.
  const localization = manifest.localization ?? discoverLocalization(resFiles);
  if (localization) {
    const tables = new Set(
      [localization.defaultLocale, localization.fallbackLocale ?? '', ...localization.locales]
        .filter(locale => locale.length > 0)
        .map(locale => `locales/${locale}.json`)
    );
    for (const table of tables) {
      if (!resFiles.has(table)) continue;
      addResource(table);
      try {
        const parsed = JSON.parse(await readFile(resAbsolute(table), 'utf8')) as {
          sprites?: Record<string, unknown>;
        };
        for (const value of Object.values(parsed.sprites ?? {})) {
          if (typeof value === 'string' && value.trim()) addResource(value);
        }
      } catch {
        warnings.push(`Failed to scan locale table for sprite references: ${table}`);
      }
    }
  }

  // Spine atlas pages live inside the `.atlas` text, invisible to the `res://` scan.
  for (const atlasPath of [...assets].filter(path => /\.atlas$/i.test(path))) {
    try {
      const text = await readFile(resAbsolute(atlasPath), 'utf8');
      for (const page of parseSpineAtlasPageNames(text)) {
        addResource(resolveSpinePagePath(atlasPath, page));
      }
    } catch {
      warnings.push(`Failed to scan Spine atlas for page images: ${atlasPath}`);
    }
  }

  // A pre-packed atlas (`assets/.atlas/`): the manifest and every sheet it lists.
  if (resFiles.has(ATLAS_MANIFEST)) {
    addResource(ATLAS_MANIFEST);
    try {
      const parsed = JSON.parse(await readFile(resAbsolute(ATLAS_MANIFEST), 'utf8')) as {
        sheets?: { id?: string; file?: string }[];
      };
      for (const sheet of parsed.sheets ?? []) {
        addResource(`${ATLAS_SHEET_DIR}${sheet.file ?? `${sheet.id}.png`}`);
      }
    } catch {
      warnings.push(`Failed to read the packed atlas manifest: ${ATLAS_MANIFEST}`);
    }
  }
  await drain();

  // Only files that exist ship; a reference to nothing is reported, not embedded as a miss.
  const assetPaths: string[] = [];
  for (const resPath of [...assets].sort()) {
    if (resFiles.has(resPath)) {
      assetPaths.push(resPath);
      continue;
    }
    try {
      if ((await stat(resAbsolute(resPath))).isFile()) {
        assetPaths.push(resPath);
        continue;
      }
    } catch {
      // fall through
    }
    warnings.push(`Referenced resource not found: res://${resPath}`);
  }

  const mentions = (name: string): boolean => mentionedNames.has(name);
  const scenePaths = allSceneLike.filter(
    path => path.toLowerCase().endsWith('.pix3scene') && !isPrefabPath(path)
  );
  const entryScenePath = resolveEntryScene(scenePaths, manifest, options.entryScene, warnings);

  return {
    scenePaths,
    entryScenePath,
    assetPaths,
    mentionedNames,
    usesSpine: mentions('SpineSkeleton2D'),
    usesPostProcessing: mentions('PostProcess'),
    usesNetwork: NETWORK_MENTION_NAMES.some(mentions),
    localization,
    netKindPrefabs: assetPaths
      .filter(path => SCENE_LIKE.test(path) && isPrefabPath(path))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    warnings,
    textSourceCount,
  };
};

/** Zero-config localization: `locales/*.json` → `en` if present, else the first (editor rule). */
const discoverLocalization = (resFiles: ReadonlySet<string>): LocalizationSettings | null => {
  const ids = [...resFiles]
    .map(path => /^locales\/([^/]+)\.json$/.exec(path)?.[1] ?? null)
    .filter((id): id is string => id !== null)
    .sort();
  if (ids.length === 0) return null;
  return { defaultLocale: ids.includes('en') ? 'en' : ids[0], locales: ids };
};

const resolveEntryScene = (
  scenePaths: readonly string[],
  manifest: ProjectManifestInfo,
  requested: string | null | undefined,
  warnings: string[]
): string => {
  const wanted = requested ? stripRes(requested) : '';
  if (wanted && scenePaths.includes(wanted)) return wanted;
  if (wanted) warnings.push(`Requested entry scene is not a project scene: ${wanted}`);
  const configured = manifest.defaultScenePath ?? '';
  if (configured && scenePaths.includes(configured)) return configured;
  if (configured) warnings.push(`defaultExportScenePath is not a project scene: ${configured}`);
  if (scenePaths.includes('scenes/main.pix3scene')) return 'scenes/main.pix3scene';
  return scenePaths[0] ?? '';
};
