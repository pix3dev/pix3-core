import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `.pix3/dev.json` (plan §B.1 «Обнаружение»): how `pix3 editor`, `pix3 check` and the agent kit
 * find the running dev server. Written when the server listens, removed when it closes — and
 * only by the process that wrote it, so a second dev server on the same project does not delete
 * the first one's record on its way out.
 */

export interface Versions {
  readonly plugin: string;
  readonly runtime: string | null;
  readonly editorCore: string | null;
  readonly vite: string;
}

export interface DevInfo {
  readonly url: string;
  readonly editorUrl: string;
  readonly port: number;
  readonly pid: number;
  readonly versions: Versions;
  readonly startedAt: string;
}

export const devJsonPath = (root: string): string => join(root, '.pix3', 'dev.json');

export const writeDevInfo = (root: string, info: DevInfo): void => {
  const path = devJsonPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
};

export const clearDevInfo = (root: string, pid: number = process.pid): void => {
  const path = devJsonPath(root);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    if (current.pid !== pid) return;
  } catch {
    return;
  }
  rmSync(path, { force: true });
};

const readVersion = (packageJson: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

/** The plugin's own version (its `package.json`, one level above `src/` and `dist/`). */
export const pluginVersion = (): string =>
  readVersion(fileURLToPath(new URL('../package.json', import.meta.url))) ?? '0.0.0';

/**
 * Directory of an installed package as the project sees it: `node_modules/<name>` in the root or
 * any ancestor (hoisting). Not `require.resolve` — `@pix3/runtime` does not export its
 * `package.json`.
 */
export const findPackageDir = (root: string, name: string): string | null => {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
};

export const installedVersion = (root: string, name: string): string | null => {
  const dir = findPackageDir(root, name);
  return dir ? readVersion(join(dir, 'package.json')) : null;
};

const parse = (version: string): { major: number; minor: number; prerelease: boolean } | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), prerelease: match[4] !== undefined };
};

/**
 * Plan §A.3 gate: the project's `@pix3/runtime` must equal `@pix3/editor-core` exactly for
 * prereleases and share major.minor for releases. Returns the problem, or null.
 */
export const versionMismatch = (
  runtime: string | null,
  editorCore: string | null
): string | null => {
  if (runtime === null)
    return 'The project has no @pix3/runtime installed. Run: npm i @pix3/runtime';
  if (editorCore === null) return null;
  const a = parse(runtime);
  const b = parse(editorCore);
  const exact = runtime === editorCore;
  const compatible =
    a !== null &&
    b !== null &&
    !a.prerelease &&
    !b.prerelease &&
    a.major === b.major &&
    a.minor === b.minor;
  if (exact || compatible) return null;
  return (
    `This editor (@pix3/editor-core ${editorCore}) needs @pix3/runtime ${editorCore}; the project ` +
    `has ${runtime}. Run: npm i @pix3/runtime@${editorCore}`
  );
};
