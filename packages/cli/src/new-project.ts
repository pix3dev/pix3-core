import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

import {
  PROJECT_MANIFEST_FILE,
  buildManifestPayload,
  createProjectId,
  renderManifest,
} from './manifest.ts';
import type { TemplateInfo } from './templates.ts';
import { CLI_VERSION } from './version.ts';

/**
 * `pix3 new <2d|3d> [dir]` (and `npm create pix3`, which runs it): the template's layers, then its
 * own files, with `{{PROJECT_NAME}}`, `{{PACKAGE_NAME}}` and `{{PIX3_VERSION}}` substituted, the
 * manifest (`pix3project.yaml`) and `.pix3/template.json`. Everything after the template goes
 * through {@link PostCreateStep}s: `pix3 new` passes the agent kit (`kit/install.ts`
 * `agentKitStep` — AGENTS.md, CLAUDE.md, skills, `.gitignore`, script types); a bare
 * `createProject` has none and stays kit-free. The agent's MCP config is `pix3 agent-setup`.
 */

/** The flat project layout (plan §B.5), created even where the template ships no file. */
const BASE_DIRECTORIES = ['design', 'scenes', 'sprites', 'scripts', 'audio'];

/** Extensions copied as text, with the placeholders substituted. */
const TEXT_EXTENSIONS = new Set([
  '.pix3scene',
  '.ts',
  '.md',
  '.yaml',
  '.yml',
  '.json',
  '.txt',
  '.html',
]);

/**
 * Files a template ships under another name: npm drops `.gitignore` from every published tarball
 * (and the templates travel in two), so the template carries `gitignore`.
 */
const RENAMED_FILES: Readonly<Record<string, string>> = { gitignore: '.gitignore' };

/** An npm package name from a project name: `My Game!` → `my-game`. */
export const packageNameOf = (projectName: string): string =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[-._~]+|[-._~]+$/g, '')
    .slice(0, 214) || 'pix3-game';

export interface CreatedProject {
  readonly dir: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly template: TemplateInfo;
  /** Project-relative paths of every file written. */
  readonly files: string[];
}

/**
 * Extension point for everything that lands in a project after the template: the agent kit,
 * `.pix3/types/@pix3/runtime`, `tsconfig.json`. Each step gets the finished project and reports
 * the files it wrote.
 */
export type PostCreateStep = (project: CreatedProject) => string[];

/** Nothing by default: `pix3 new` passes `agentKitStep`. */
export const DEFAULT_POST_CREATE_STEPS: readonly PostCreateStep[] = [];

export interface CreateProjectOptions {
  readonly template: TemplateInfo;
  readonly dir: string;
  /** Defaults to the target folder's name, like the editor defaults to the folder handle name. */
  readonly projectName?: string;
  readonly projectId?: string;
  readonly postCreateSteps?: readonly PostCreateStep[];
}

const walkFiles = (root: string, dir: string = root): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
};

export const createProject = (options: CreateProjectOptions): CreatedProject => {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty. Choose an empty or new folder for a new project.`);
  }
  const template = options.template;
  const projectName = (options.projectName ?? basename(dir)).trim() || 'Pix3 Project';
  const projectId = options.projectId ?? createProjectId();
  const written: string[] = [];

  const writeFile = (relativePath: string, contents: string | Buffer): void => {
    const target = join(dir, relativePath);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
    written.push(relativePath);
  };

  for (const sub of [...BASE_DIRECTORIES, ...template.directories]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  writeFile(
    PROJECT_MANIFEST_FILE,
    renderManifest(buildManifestPayload(template, { projectName, projectId }))
  );

  const substitute = (text: string): string =>
    text
      .replaceAll('{{PROJECT_NAME}}', projectName)
      .replaceAll('{{PACKAGE_NAME}}', packageNameOf(projectName))
      .replaceAll('{{PIX3_VERSION}}', CLI_VERSION);
  // Layers first, the template's own files on top (a later file of the same path replaces one).
  const sources = new Map<string, string>();
  for (const filesDir of [...template.layerDirs, template.filesDir]) {
    for (const relativePath of walkFiles(filesDir)) {
      const name = relativePath.split('/').pop() ?? relativePath;
      const target =
        name in RENAMED_FILES
          ? relativePath.slice(0, relativePath.length - name.length) + RENAMED_FILES[name]
          : relativePath;
      sources.set(target, join(filesDir, relativePath));
    }
  }
  for (const [relativePath, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (TEXT_EXTENSIONS.has(extname(source).toLowerCase())) {
      writeFile(relativePath, substitute(readFileSync(source, 'utf8')));
    } else {
      writeFile(relativePath, readFileSync(source));
    }
  }

  writeFile(
    '.pix3/template.json',
    JSON.stringify(
      {
        templateId: template.id,
        editorVersion: CLI_VERSION,
        createdBy: '@pix3/cli',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );

  const created: CreatedProject = { dir, projectId, projectName, template, files: written };
  for (const step of options.postCreateSteps ?? DEFAULT_POST_CREATE_STEPS) {
    written.push(...step(created));
  }
  return created;
};
