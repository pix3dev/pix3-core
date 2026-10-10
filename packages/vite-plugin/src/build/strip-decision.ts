import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findPackageDir } from '../dev-info.ts';

/**
 * Whether a build may strip unmentioned runtime modules (plan §B.6 item 2, N11). On by default.
 * A dependency that declares `@pix3/runtime` is parsed first (`dependency-imports.ts`): its
 * named imports keep their modules, and an import the build cannot follow (`import * as`, a
 * dynamic import, a parse error) turns strip **off** with a message naming
 * `pix3({ strip: { keep } })` — the owner names the runtime classes the library uses and strip
 * stays on. `strip: false` switches it off for foreign entries; `strip: true` forces it on.
 */
export type StripOption = boolean | { readonly keep?: readonly string[] };

export interface StripDecision {
  readonly enabled: boolean;
  /** Why it is off (or on against findings), for the build log; null when nothing to say. */
  readonly reason: string | null;
  /** Names kept by `pix3({ strip: { keep } })`. */
  readonly keep: readonly string[];
}

const OWN_PACKAGES = new Set([
  '@pix3/runtime',
  '@pix3/vite-plugin',
  '@pix3/editor-core',
  '@pix3/cli',
]);

/** The fix a message names when a dependency's imports cannot be followed. */
export const KEEP_HINT = "pix3({ strip: { keep: ['<RuntimeClass>', …] } })";

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

export interface StripFindings {
  /** Imports of `@pix3/runtime` the build could not follow (from `scanDependencyImports`). */
  readonly opaque: readonly string[];
}

export const decideStrip = (
  option: StripOption | undefined,
  findings: StripFindings = { opaque: [] }
): StripDecision => {
  if (option === false) return { enabled: false, reason: 'pix3({ strip: false })', keep: [] };
  if (option === true) {
    return { enabled: true, reason: 'forced by pix3({ strip: true })', keep: [] };
  }
  const keep = option && typeof option === 'object' ? [...(option.keep ?? [])] : [];
  const opaque = findings.opaque;
  if (opaque.length === 0) {
    return {
      enabled: true,
      reason: keep.length > 0 ? `keeping ${keep.join(', ')} by pix3({ strip: { keep } })` : null,
      keep,
    };
  }
  const first = opaque[0] + (opaque.length > 1 ? ` (+${opaque.length - 1} more)` : '');
  if (option && typeof option === 'object') {
    return {
      enabled: true,
      reason:
        `${first} — the build cannot see which runtime modules it reaches; stripping anyway ` +
        `because pix3({ strip: { keep } }) names what it uses` +
        (keep.length > 0 ? ` (${keep.join(', ')})` : ' (nothing listed!)'),
      keep,
    };
  }
  return {
    enabled: false,
    reason:
      `${first} — the build cannot see which runtime modules it reaches, so nothing is ` +
      `stripped. Name the runtime classes it uses with ${KEEP_HINT} to strip the rest, ` +
      `or pass strip: true to strip regardless`,
    keep,
  };
};
