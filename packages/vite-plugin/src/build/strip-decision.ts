import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findPackageDir } from '../dev-info.ts';

/**
 * Whether a build may strip unmentioned runtime modules (plan §B.6 item 2, P1 rule): on unless a
 * dependency of the project declares `@pix3/runtime` in its `dependencies`/`peerDependencies` —
 * such a package imports runtime modules the scan never sees (the barrel-import case, N11), and
 * parsing its imports is P2. `pix3({ strip: false })` switches it off for foreign entries;
 * `strip: true` forces it on.
 */
export interface StripDecision {
  readonly enabled: boolean;
  /** Why it is off (or `forced` when the option turned it on), for the build log. */
  readonly reason: string | null;
}

const OWN_PACKAGES = new Set([
  '@pix3/runtime',
  '@pix3/vite-plugin',
  '@pix3/editor-core',
  '@pix3/cli',
]);

const readPackage = (dir: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const namesOf = (pkg: Record<string, unknown>, ...sections: string[]): string[] => {
  const out: string[] = [];
  for (const section of sections) {
    const value = pkg[section];
    if (value && typeof value === 'object') out.push(...Object.keys(value as object));
  }
  return out;
};

/** Project dependencies that themselves depend on `@pix3/runtime`. */
export const runtimeDependents = (root: string): string[] => {
  const pkg = readPackage(root);
  if (!pkg) return [];
  const dependents: string[] = [];
  const names = new Set(
    namesOf(pkg, 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies')
  );
  for (const name of names) {
    if (OWN_PACKAGES.has(name)) continue;
    const dir = findPackageDir(root, name);
    const dependency = dir ? readPackage(dir) : null;
    if (!dependency) continue;
    if (namesOf(dependency, 'dependencies', 'peerDependencies').includes('@pix3/runtime')) {
      dependents.push(name);
    }
  }
  return dependents.sort();
};

export const decideStrip = (root: string, option: boolean | undefined): StripDecision => {
  if (option === false) return { enabled: false, reason: 'pix3({ strip: false })' };
  if (option === true) return { enabled: true, reason: 'forced by pix3({ strip: true })' };
  const dependents = runtimeDependents(root);
  if (dependents.length > 0) {
    return {
      enabled: false,
      reason:
        `${dependents.join(', ')} depend(s) on @pix3/runtime and may import modules the scan ` +
        `cannot see; pass pix3({ strip: true }) to strip anyway`,
    };
  }
  return { enabled: true, reason: null };
};
