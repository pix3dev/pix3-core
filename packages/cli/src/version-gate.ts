import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { cliPackageRoot } from './package-root.ts';
import { CLI_VERSION } from './version.ts';

/**
 * The CLI's version gate (plan §A.1, `@pix3/cli` row: «`smoke`/`check` сверяют свой
 * забандленный runtime с `node_modules/@pix3/runtime` проекта, иначе `E_RUNTIME_VERSION`»).
 *
 * `pix3 validate` / `check` / `smoke` / `tree --props` do not load the project's engine: they run
 * the `@pix3/runtime` bundled into this CLI (from this checkout's `packages/runtime`, or the
 * prebuilt bundles a published CLI ships — built from the same lockstep version). A project whose
 * own `node_modules/@pix3/runtime` is another version would be validated and smoke-run by an
 * engine it does not ship, so a green answer would be about a different game. That is an error,
 * not a warning: `check` reports `E_RUNTIME_VERSION`, `smoke` refuses to run. The fix is either
 * side — install the CLI's runtime, or run the CLI that matches the project (`npx pix3 …` resolves
 * the project's own `@pix3/cli`, which a starter pins to the same version).
 *
 * The other `@pix3/*` packages a project installs (`cli`, `vite-plugin`, `editor-core`) are
 * lockstep too; a mismatch there is a warning (`W_PIX3_VERSION_MISMATCH`): it does not change
 * what `check` or `smoke` measure, but the editor and the build are then another version than the
 * kit and the CLI describe.
 *
 * Plain Node, no runtime import.
 */

/** The `@pix3/*` packages released in lockstep with this CLI, besides the runtime. */
export const LOCKSTEP_PACKAGES: readonly string[] = [
  '@pix3/cli',
  '@pix3/vite-plugin',
  '@pix3/editor-core',
];

const readVersion = (packageJson: string): string | null => {
  try {
    const version = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown })
      .version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
};

/**
 * The version of `@pix3/runtime` this CLI runs scenes with: a repo checkout bundles
 * `packages/runtime` from source (its own `package.json`); a published CLI ships bundles built at
 * its own version.
 */
export const bundledRuntimeVersion = (): string => {
  const checkout = join(cliPackageRoot(), '..', 'runtime', 'package.json');
  return (existsSync(checkout) ? readVersion(checkout) : null) ?? CLI_VERSION;
};

/** The version of `name` a project resolves from `node_modules` (walking up, as Node does), or null. */
export const installedPackageVersion = (projectRoot: string, name: string): string | null => {
  let dir = resolve(projectRoot);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(candidate)) return readVersion(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** Version of the `@pix3/runtime` a project resolves from `node_modules` (walking up), or null. */
export const installedRuntimeVersion = (projectRoot: string): string | null =>
  installedPackageVersion(projectRoot, '@pix3/runtime');

export interface RuntimeVersionMismatch {
  readonly installed: string;
  readonly bundled: string;
  readonly message: string;
  readonly fix: string;
}

/**
 * The gate: null when the project has no `@pix3/runtime` installed (nothing to compare — the
 * kit's `.pix3/types` or an `npm install` away) or the same version this CLI runs.
 */
export const runtimeVersionMismatch = (projectRoot: string): RuntimeVersionMismatch | null => {
  const installed = installedRuntimeVersion(projectRoot);
  const bundled = bundledRuntimeVersion();
  if (installed === null || installed === bundled) return null;
  return {
    installed,
    bundled,
    message: `The project installs @pix3/runtime ${installed}, but this CLI validates and runs scenes with the @pix3/runtime ${bundled} bundled into it — its answers would be about an engine the game does not ship.`,
    fix: `run the project's own CLI (npx pix3 …, @pix3/cli ${installed}), or npm install @pix3/runtime@${bundled} @pix3/cli@${bundled}`,
  };
};

export interface PackageVersionMismatch {
  readonly name: string;
  readonly installed: string;
}

/** Installed lockstep `@pix3/*` packages (not the runtime) whose version is not this CLI's. */
export const lockstepMismatches = (projectRoot: string): PackageVersionMismatch[] =>
  LOCKSTEP_PACKAGES.flatMap(name => {
    const installed = installedPackageVersion(projectRoot, name);
    return installed !== null && installed !== CLI_VERSION ? [{ name, installed }] : [];
  });
