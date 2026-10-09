import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

import { cliPackageRoot } from './package-root.ts';

/**
 * Project templates, read straight from disk.
 *
 * One source of truth (plan §5 A, risk #7 — "copy at build time"): the templates live in
 * `packages/create-pix3/templates/`, and this package reads the same folders.
 *  - Published package: `prepack` copies each template folder's `template.yaml` + `files/` into
 *    `<package>/templates/` (gitignored), which is what ships in the tarball.
 *  - Repo checkout (`node packages/cli/src/index.ts`): the templates are read from
 *    `<repo>/packages/create-pix3/templates/` directly, so editing one needs no rebuild,
 *    and a leftover `templates/` copy in the checkout can never shadow the source.
 *
 * Templates compose (`.plans/templates.md`): a template's `template.yaml` may name a layer it
 * `extends` — a sibling folder with only `files/` (`base`: package.json, vite.config.ts,
 * index.html, src/main.ts, tsconfig.json …). The project gets the layer's files first, then the
 * template's own on top. A folder without `template.yaml` is a layer, never listed.
 */

type ProjectType = '2d' | '3d';
export type TargetPlatform = 'mobile' | 'desktop' | 'universal';

const PROJECT_TYPES: readonly string[] = ['2d', '3d'];
const TARGET_PLATFORMS: readonly string[] = ['mobile', 'desktop', 'universal'];
const DEFAULT_PROJECT_TYPE: ProjectType = '3d';
const DEFAULT_TARGET_PLATFORM: TargetPlatform = 'universal';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

export interface TemplateInfo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly projectType: ProjectType;
  readonly targetPlatform: TargetPlatform;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly order: number;
  readonly hidden: boolean;
  /** Project-relative, no `res://`. */
  readonly entryScenePath?: string;
  readonly directories: readonly string[];
  /** Absolute path of the template's `files/` tree. */
  readonly filesDir: string;
  /**
   * Absolute `files/` trees copied before this template's own, in order (`extends: <layer>` in
   * `template.yaml`; empty when it extends nothing).
   */
  readonly layerDirs: readonly string[];
}

const packageRootDir = (): string => cliPackageRoot();

/**
 * `<repo>/packages/create-pix3/templates` when this package runs from inside the pix3-core
 * monorepo, else null. "Inside" is proven, not guessed from a relative path: the repo root must hold
 * `packages/cli` = this package. An installed copy under `node_modules/@pix3/cli` never
 * matches, whatever happens to sit two levels up.
 */
const repoTemplatesDir = (): string | null => {
  const packageRoot = packageRootDir();
  const repoRoot = join(packageRoot, '..', '..');
  const templates = join(repoRoot, 'packages', 'create-pix3', 'templates');
  const isRepoCheckout =
    resolve(repoRoot, 'packages', 'cli') === resolve(packageRoot) &&
    existsSync(join(repoRoot, 'packages', 'runtime'));
  return isRepoCheckout && existsSync(templates) ? templates : null;
};

/** Candidate template roots: the repo's own folder in a checkout, the packaged copy otherwise. */
const templateRootCandidates = (): string[] => {
  const repo = repoTemplatesDir();
  return repo ? [repo] : [join(packageRootDir(), 'templates')];
};

/** `PIX3_TEMPLATES_DIR` overrides the lookup (tests, or trying a template folder in progress). */
export const resolveTemplatesRoot = (): string => {
  const override = process.env.PIX3_TEMPLATES_DIR;
  if (override) return override;
  for (const candidate of templateRootCandidates()) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error(
    `No project templates found in ${templateRootCandidates().join(', ')}. ` +
      'The package is incomplete — reinstall it (published builds carry a templates/ copy).'
  );
};

const asPositiveInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const readTemplate = (root: string, id: string): TemplateInfo | null => {
  const dir = join(root, id);
  const metaPath = join(dir, 'template.yaml');
  const filesDir = join(dir, 'files');
  if (!existsSync(metaPath) || !existsSync(filesDir)) return null;

  let meta: Record<string, unknown> = {};
  try {
    meta = asRecord(parse(readFileSync(metaPath, 'utf8')));
  } catch (error) {
    process.stderr.write(`pix3: failed to parse ${metaPath}: ${String(error)}\n`);
  }

  const projectTypeRaw = typeof meta.projectType === 'string' ? meta.projectType : '';
  const targetPlatformRaw = typeof meta.targetPlatform === 'string' ? meta.targetPlatform : '';
  const viewport = asRecord(meta.viewport);
  const entrySceneRaw = typeof meta.entryScene === 'string' ? meta.entryScene.trim() : '';
  const entryScenePath = entrySceneRaw ? entrySceneRaw.replace(/^res:\/\//i, '') : undefined;
  const extendsRaw = typeof meta.extends === 'string' ? meta.extends.trim() : '';
  const layerDir = extendsRaw ? join(root, extendsRaw, 'files') : null;
  if (layerDir && !existsSync(layerDir)) {
    process.stderr.write(`pix3: ${metaPath} extends "${extendsRaw}", which has no files/\n`);
    return null;
  }

  return {
    id,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : id,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    projectType: PROJECT_TYPES.includes(projectTypeRaw)
      ? (projectTypeRaw as ProjectType)
      : DEFAULT_PROJECT_TYPE,
    targetPlatform: TARGET_PLATFORMS.includes(targetPlatformRaw)
      ? (targetPlatformRaw as TargetPlatform)
      : DEFAULT_TARGET_PLATFORM,
    viewport: {
      width: asPositiveInt(viewport.width, DEFAULT_VIEWPORT.width),
      height: asPositiveInt(viewport.height, DEFAULT_VIEWPORT.height),
    },
    order: asPositiveInt(meta.order, 1000),
    hidden: meta.hidden === true,
    ...(entryScenePath ? { entryScenePath } : {}),
    directories: Array.isArray(meta.directories)
      ? meta.directories.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : [],
    filesDir,
    layerDirs: layerDir ? [layerDir] : [],
  };
};

/** Every template, hidden ones included, in the editor's order (`order`, then title). */
export const listTemplates = (root: string = resolveTemplatesRoot()): TemplateInfo[] =>
  readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => readTemplate(root, entry.name))
    .filter((template): template is TemplateInfo => template !== null)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

/**
 * Resolve what the user typed: a template id (`2d`, `3d`; hidden templates included — `hidden`
 * keeps a template out of lists, not out of reach), case-insensitive.
 */
export const resolveTemplate = (
  query: string,
  templates: readonly TemplateInfo[]
): { template: TemplateInfo } | { error: string } => {
  const wanted = query.trim().toLowerCase();
  const exact = templates.find(t => t.id.toLowerCase() === wanted);
  if (exact) return { template: exact };
  const known = templates
    .filter(t => !t.hidden)
    .map(t => t.id)
    .join(', ');
  return { error: `Unknown template "${query}" (${known}).` };
};

/** First sentence of a template description — the "one line" of the list. */
export const oneLine = (description: string): string => {
  const flat = description.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  return match ? match[1] : flat;
};
