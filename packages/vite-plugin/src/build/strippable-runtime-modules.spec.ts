// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildStrippedModuleSource,
  NEUTRALISED_IMPORTERS,
  resolveStrippableRuntimeModules,
  STRIPPABLE_RUNTIME_MODULES,
} from './strippable-runtime-modules.ts';

const RUNTIME_SRC = path.resolve(import.meta.dirname, '../../../runtime/src');

const listRuntimeSources = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listRuntimeSources(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(entryPath);
    }
  }
  return found;
};

const resolveRelativeImport = (fromFile: string, specifier: string): string | null => {
  const target = path.normalize(path.join(path.dirname(fromFile), specifier));
  for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

// Module paths are POSIX in the table; normalise the OS separator so the graph lookup does not
// quietly degrade into "no importer found anywhere" on a Windows checkout.
const toModulePath = (absolutePath: string): string =>
  path.relative(RUNTIME_SRC, absolutePath).split(path.sep).join('/').replace(/\.ts$/, '');

/**
 * Value importers per module path, mirroring what the bundler sees: `import type` and clauses
 * made only of `type X` specifiers are erased and pin nothing.
 */
const buildValueImportGraph = (): Map<string, Set<string>> => {
  const importers = new Map<string, Set<string>>();
  const importPattern = /import\s+(type\s+)?([^'";]*?)from\s+['"]([^'"]+)['"]/g;

  for (const file of listRuntimeSources(RUNTIME_SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const [, typeKeyword, clause, specifier] = match;
      if (typeKeyword) continue;
      if (!specifier.startsWith('.')) continue;
      const specifiers = clause.includes('{')
        ? clause
            .slice(clause.indexOf('{') + 1, clause.indexOf('}'))
            .split(',')
            .map(part => part.trim())
            .filter(part => part.length > 0)
        : [];
      const onlyTypes =
        clause.includes('{') &&
        !clause.replace(/\{[\s\S]*\}/, '').trim() &&
        specifiers.every(part => part.startsWith('type '));
      if (onlyTypes) continue;
      const resolved = resolveRelativeImport(file, specifier);
      if (!resolved) continue;
      const key = toModulePath(resolved);
      const existing = importers.get(key) ?? new Set<string>();
      existing.add(toModulePath(file));
      importers.set(key, existing);
    }
  }
  return importers;
};

describe('strippable runtime modules', () => {
  const graph = buildValueImportGraph();

  it('lists modules that exist in the runtime', () => {
    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      expect(
        existsSync(path.join(RUNTIME_SRC, `${entry.modulePath}.ts`)),
        `${entry.modulePath} is not a runtime module`
      ).toBe(true);
    }
  });

  it('has no unaccounted value importer — the guard against runtime drift', () => {
    // If someone adds `import { Slider2D } from '...'` to a module that a player always keeps, the
    // table has to change or the stub ships broken. This test is what makes that visible.
    const listed = new Set(STRIPPABLE_RUNTIME_MODULES.map(entry => entry.modulePath));
    const neutralised = new Set<string>(NEUTRALISED_IMPORTERS);

    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      const actual = [...(graph.get(entry.modulePath) ?? new Set<string>())];
      const declared = new Set([...(entry.importers ?? []), ...(entry.lazyValueImporters ?? [])]);

      const unaccounted = actual.filter(
        importer =>
          !neutralised.has(importer) && !declared.has(importer) && importer !== entry.modulePath
      );
      expect(
        unaccounted,
        `${entry.modulePath} gained value importer(s) not declared in the table. Either add them ` +
          `to \`importers\` (if they are strippable too), justify them in \`lazyValueImporters\`, ` +
          `or remove the entry.`
      ).toEqual([]);

      // The reverse direction: a declared importer that no longer imports it is stale.
      for (const declaredImporter of declared) {
        expect(
          actual.includes(declaredImporter),
          `${entry.modulePath} declares importer ${declaredImporter}, which no longer imports it`
        ).toBe(true);
      }

      for (const importer of entry.importers ?? []) {
        expect(
          listed.has(importer),
          `${entry.modulePath} declares ${importer} in \`importers\`, but that module is not itself strippable`
        ).toBe(true);
      }
    }
  });

  it('keeps behaviour ids in sync with register-behaviors', () => {
    const registerSource = readFileSync(
      path.join(RUNTIME_SRC, 'behaviors/register-behaviors.ts'),
      'utf8'
    );
    const registered = new Map<string, string>();
    const blockPattern = /id:\s*'(core:[A-Za-z0-9_]+)'[\s\S]*?componentClass:\s*([A-Za-z0-9_]+)/g;
    for (const match of registerSource.matchAll(blockPattern)) {
      registered.set(match[2], match[1]);
    }
    expect(registered.size).toBeGreaterThan(10);

    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      const className = path.basename(entry.modulePath);
      const id = registered.get(className);
      if (!id) continue;
      expect(
        entry.keepWhenMentioned,
        `${entry.modulePath} must keep the module when the scene names ${id}`
      ).toContain(id);
    }
  });

  it('strips nothing that is mentioned, and rescues importers transitively', () => {
    const none = resolveStrippableRuntimeModules(() => false).map(entry => entry.modulePath);
    expect(none).toContain('net/NetworkService');
    expect(none).toContain('nodes/2D/UI/Slider2D');

    const replicated = resolveStrippableRuntimeModules(name => name === 'core:ReplicatedTransform');
    const kept = new Set(
      STRIPPABLE_RUNTIME_MODULES.map(entry => entry.modulePath).filter(
        modulePath => !replicated.some(entry => entry.modulePath === modulePath)
      )
    );
    expect(kept.has('behaviors/ReplicatedTransformBehavior')).toBe(true);
    expect(kept.has('behaviors/NetworkedNodeBehavior')).toBe(true);
    expect(kept.has('net/NetworkService')).toBe(true);
    expect(kept.has('nodes/2D/UI/Slider2D')).toBe(false);

    const physics = resolveStrippableRuntimeModules(name => name === 'core:PhysicsBody2D');
    const strippedPaths = new Set(physics.map(entry => entry.modulePath));
    expect(strippedPaths.has('core/Physics2DService')).toBe(false);
    expect(strippedPaths.has('core/collision-shapes-2d')).toBe(false);
    expect(strippedPaths.has('core/Collision2DService')).toBe(true);
  });

  it('builds a stub with the same value exports as the real module', () => {
    const source = readFileSync(path.join(RUNTIME_SRC, 'nodes/2D/UI/Slider2D.ts'), 'utf8');
    const stub = buildStrippedModuleSource(source, 'nodes/2D/UI/Slider2D');
    expect(stub).toContain('export class Slider2D {');
    expect(stub).toContain('static getPropertySchema() { return []; }');
    expect(stub).toContain('was stripped from this build');

    const mixed = buildStrippedModuleSource(
      [
        'export const DEFAULT_SPEED = 3;',
        'export async function createThing() {}',
        'export abstract class Base {}',
        'export { helper as renamed };',
      ].join('\n'),
      'x'
    );
    expect(mixed).toContain('export const DEFAULT_SPEED = undefined;');
    expect(mixed).toContain('export function createThing()');
    expect(mixed).toContain('export class Base {');
    expect(mixed).toContain('export const renamed = undefined;');
    expect(buildStrippedModuleSource('', 'empty')).toContain('export {};');
  });
});
