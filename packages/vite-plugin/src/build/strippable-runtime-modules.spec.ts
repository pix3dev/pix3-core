// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  buildStrippedModuleSource,
  NEUTRALISED_IMPORTERS,
  resolveStrippableRuntimeModules,
  STRIPPABLE_RUNTIME_MODULES,
  valueExportNames,
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

const parseRuntimeModule = (modulePath: string): ts.SourceFile =>
  ts.createSourceFile(
    `${modulePath}.ts`,
    readFileSync(path.join(RUNTIME_SRC, `${modulePath}.ts`), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );

const someNode = (root: ts.Node, test: (node: ts.Node) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (test(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const memberName = (member: ts.ClassElement): string =>
  ts.isConstructorDeclaration(member)
    ? 'constructor'
    : member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
      ? member.name.text
      : '(computed)';

/**
 * The members of a lazy importer that construct one of `classNames` (`get physics2d()` →
 * `new Physics2DService()`), plus the getters that read one of those (`get netNodes()` reads
 * `this.network`): the property names through which any other module reaches the class.
 */
const constructingMembers = (
  lazyImporter: string,
  classNames: ReadonlySet<string>
): Set<string> => {
  const members: ts.ClassElement[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) members.push(...node.members);
    ts.forEachChild(node, collect);
  };
  collect(parseRuntimeModule(lazyImporter));
  const found = new Set(
    members
      .filter(member =>
        someNode(
          member,
          node =>
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            classNames.has(node.expression.text)
        )
      )
      .map(memberName)
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const member of members) {
      if (!ts.isGetAccessorDeclaration(member) || found.has(memberName(member))) continue;
      const reads = someNode(
        member,
        node =>
          ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword &&
          found.has(node.name.text)
      );
      if (reads) {
        found.add(memberName(member));
        grew = true;
      }
    }
  }
  return found;
};

/**
 * Per listed module: the runtime modules that reach it through a lazy importer's constructing
 * member (`this.scene?.physics2d` in a behaviour that imports only the service's types) — an
 * edge the value-import graph cannot see, and exactly as binding: a kept behaviour that calls
 * `scene.physics2d` against a stripped service throws.
 */
const buildLazyReachGraph = (): {
  reachers: Map<string, Set<string>>;
  members: Map<string, Set<string>>;
} => {
  const reachers = new Map<string, Set<string>>();
  const members = new Map<string, Set<string>>();
  const sources = listRuntimeSources(RUNTIME_SRC).map(file => toModulePath(file));
  const parsed = new Map<string, ts.SourceFile>();
  const sourceOf = (modulePath: string): ts.SourceFile => {
    let file = parsed.get(modulePath);
    if (!file) {
      file = parseRuntimeModule(modulePath);
      parsed.set(modulePath, file);
    }
    return file;
  };
  for (const entry of STRIPPABLE_RUNTIME_MODULES) {
    const classNames = new Set(
      valueExportNames(readFileSync(path.join(RUNTIME_SRC, `${entry.modulePath}.ts`), 'utf8'))
    );
    const names = new Set<string>();
    const lazyImporters = new Set(entry.lazyValueImporters ?? []);
    for (const lazyImporter of lazyImporters) {
      for (const name of constructingMembers(lazyImporter, classNames)) names.add(name);
    }
    members.set(entry.modulePath, names);
    if (names.size === 0) continue;
    const found = new Set<string>();
    for (const modulePath of sources) {
      if (modulePath === entry.modulePath) continue;
      const reaches = someNode(
        sourceOf(modulePath),
        node => ts.isPropertyAccessExpression(node) && names.has(node.name.text)
      );
      if (reaches) found.add(modulePath);
    }
    reachers.set(entry.modulePath, found);
  }
  return { reachers, members };
};

describe('strippable runtime modules', () => {
  const graph = buildValueImportGraph();
  const lazy = buildLazyReachGraph();

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
      // What keeps it alive: value importers, and modules reaching it through a lazy getter.
      const actual = [
        ...new Set([
          ...(graph.get(entry.modulePath) ?? new Set<string>()),
          ...(lazy.reachers.get(entry.modulePath) ?? new Set<string>()),
        ]),
      ];
      const declared = new Set([...(entry.importers ?? []), ...(entry.lazyValueImporters ?? [])]);

      const unaccounted = actual.filter(
        importer =>
          !neutralised.has(importer) && !declared.has(importer) && importer !== entry.modulePath
      );
      expect(
        unaccounted,
        `${entry.modulePath} gained value importer(s), or module(s) reaching it through a lazy ` +
          `getter, not declared in the table. Either add them ` +
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

  it('keeps a module whenever a script can reach it through a lazy getter', () => {
    // `this.scene.physics2d` in a project script constructs the service; the getter's name must
    // keep it, or the game gets the stub. Derived from the getters, not from a list.
    const reached = new Map<string, string[]>();
    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      const names = [...(lazy.members.get(entry.modulePath) ?? [])];
      if (names.length > 0) reached.set(entry.modulePath, names);
      for (const name of names) {
        expect(
          entry.keepWhenMentioned,
          `${entry.modulePath} is constructed by the lazy member \`${name}\` of ` +
            `${(entry.lazyValueImporters ?? []).join(', ')}: a script that writes it must keep it`
        ).toContain(name);
      }
    }
    // The ones the build relies on today (the derivation itself must not go blind).
    expect(reached.get('core/Physics2DService')).toContain('physics2d');
    expect(reached.get('core/Collision2DService')).toContain('collision2d');
    expect(reached.get('core/TweenApi')).toContain('tween');
    expect(reached.get('core/trail-2d')).toContain('trail');
    expect(reached.get('net/NetworkService')).toEqual(
      expect.arrayContaining(['network', 'netNodes'])
    );
    expect([...(lazy.reachers.get('core/Physics2DService') ?? [])]).toContain(
      'behaviors/PhysicsBody2DBehavior'
    );
  });

  it('a behaviour constructed from code keeps the service it reaches', () => {
    // `addComponent(new PhysicsBody2DBehavior())`: the class name alone is the mention.
    for (const [behaviour, service] of [
      ['PhysicsBody2DBehavior', 'core/Physics2DService'],
      ['Collider2DBehavior', 'core/Physics2DService'],
      ['PhysicsWorld2DBehavior', 'core/Physics2DService'],
      ['RevoluteJoint2DBehavior', 'core/Physics2DService'],
      ['Hitbox2DBehavior', 'core/Collision2DService'],
    ] as const) {
      const stripped = resolveStrippableRuntimeModules(name => name === behaviour).map(
        entry => entry.modulePath
      );
      expect(stripped, `${behaviour} kept, ${service} stripped`).not.toContain(service);
      expect(stripped).not.toContain(`behaviors/${behaviour}`);
    }
  });

  it('keeps a module when any of its value exports is mentioned, not only its keep-names', () => {
    const exportsOf = (modulePath: string): string[] =>
      valueExportNames(readFileSync(path.join(RUNTIME_SRC, `${modulePath}.ts`), 'utf8'));
    const paths = (mentioned: string): string[] =>
      resolveStrippableRuntimeModules(name => name === mentioned, exportsOf).map(
        entry => entry.modulePath
      );
    expect(paths('pointInPolygon')).not.toContain('core/collision-shapes-2d');
    expect(paths('CHARACTER_STATE_FINISHED_SIGNAL')).not.toContain(
      'behaviors/CharacterVisual2DBehavior'
    );
    expect(paths('describeRejectCode')).not.toContain('net/NetworkService');
    // Without the exports (the table alone) the first one was a stub that throws.
    expect(
      resolveStrippableRuntimeModules(name => name === 'pointInPolygon').map(e => e.modulePath)
    ).toContain('core/collision-shapes-2d');
    // Every listed module has value exports the build can read (or the protection is blind).
    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      expect(exportsOf(entry.modulePath), entry.modulePath).not.toEqual([]);
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
