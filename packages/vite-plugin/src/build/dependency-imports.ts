import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import * as vite from 'vite';

import { findPackageDir } from '../dev-info.ts';

/**
 * N11 (plan §B.6 item 2): what a project dependency imports from `@pix3/runtime`. The scan of
 * `mentionedNames` reads the project's own text sources, never `node_modules`, so a library with
 * `import { GeometryMesh } from '@pix3/runtime'` would otherwise get the stub — the barrel
 * re-exports it and the stub's importer is internal. Every package the project depends on that
 * itself declares `@pix3/runtime` is parsed here before the build decides what to strip:
 *
 * - a named import (or `export { X } from`) adds `X` to the names that keep modules;
 * - `import * as`, a dynamic `import('@pix3/runtime')`, `export * from`, `require(…)` or a file
 *   that does not parse is **opaque**: the build cannot see which modules the package reaches,
 *   so strip goes off with a message naming `pix3({ strip: { keep } })`.
 *
 * The AST comes from the bundler's own parser (`this.parse` in a hook; `parseAst` in a spec).
 * TypeScript sources (a workspace package, a library shipping `.ts`) are lowered to JS first
 * with Vite's own transform (`transformWithOxc` under Vite 8, `transformWithEsbuild` under 7).
 * A `transform`-hook safety net in the plugin runs the same walk over every `node_modules`
 * module the bundle actually pulls in, for packages this pre-scan did not know about.
 */

export const RUNTIME_SPECIFIER = '@pix3/runtime';

export interface RuntimeImportFindings {
  /** Named imports of the runtime barrel: the identifiers that keep modules in the bundle. */
  readonly names: Set<string>;
  /** Imports the build cannot follow, each a sentence naming the file and the form. */
  readonly opaque: string[];
}

interface EstreeNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is EstreeNode =>
  typeof value === 'object' && value !== null && typeof (value as EstreeNode).type === 'string';

const literalString = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const cooked = (node.quasis[0] as { value?: { cooked?: unknown } }).value?.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  return null;
};

const isRuntimeSource = (source: string | null): boolean =>
  source === RUNTIME_SPECIFIER || (source !== null && source.startsWith(`${RUNTIME_SPECIFIER}/`));

const specifierName = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
};

/** Walk one module's AST for what it takes from `@pix3/runtime`; `file` names it in messages. */
export const collectRuntimeImports = (
  ast: unknown,
  file: string,
  findings: RuntimeImportFindings = { names: new Set(), opaque: [] }
): RuntimeImportFindings => {
  const opaque = (what: string): void => {
    findings.opaque.push(`${file}: ${what}`);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isNode(node)) return;
    switch (node.type) {
      case 'ImportDeclaration': {
        if (!isRuntimeSource(literalString(node.source))) break;
        if (node.importKind === 'type') break;
        for (const specifier of (node.specifiers as unknown[]) ?? []) {
          if (!isNode(specifier)) continue;
          if (specifier.importKind === 'type') continue;
          if (specifier.type === 'ImportSpecifier') {
            const name = specifierName(specifier.imported);
            if (name) findings.names.add(name);
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            opaque(
              `import * as ${specifierName(specifier.local) ?? '…'} from '${RUNTIME_SPECIFIER}'`
            );
          }
          // A default import: the runtime has no default export; the bundler reports it.
        }
        return;
      }
      case 'ExportNamedDeclaration': {
        if (isRuntimeSource(literalString(node.source)) && node.exportKind !== 'type') {
          for (const specifier of (node.specifiers as unknown[]) ?? []) {
            if (!isNode(specifier) || specifier.exportKind === 'type') continue;
            const name = specifierName(specifier.local);
            if (name) findings.names.add(name);
          }
          return;
        }
        break;
      }
      case 'ExportAllDeclaration': {
        if (isRuntimeSource(literalString(node.source))) {
          opaque(`export * from '${RUNTIME_SPECIFIER}'`);
          return;
        }
        break;
      }
      case 'ImportExpression': {
        if (isRuntimeSource(literalString(node.source))) {
          opaque(`import('${RUNTIME_SPECIFIER}')`);
          return;
        }
        break;
      }
      case 'CallExpression': {
        const callee = node.callee;
        const args = node.arguments as unknown[] | undefined;
        if (
          isNode(callee) &&
          callee.type === 'Identifier' &&
          callee.name === 'require' &&
          isRuntimeSource(literalString(args?.[0]))
        ) {
          opaque(`require('${RUNTIME_SPECIFIER}')`);
          return;
        }
        break;
      }
      default:
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end')
        continue;
      if (typeof value === 'object' && value !== null) visit(value);
    }
  };
  visit(ast);
  return findings;
};

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);
const NEEDS_LOWERING = /\.(?:[cm]?ts|[jt]sx)$/;
const NOT_A_SOURCE = /\.(?:spec|test)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
]);

/** Every parseable source of a package, as absolute paths (sorted; nested packages excluded). */
export const listPackageSources = (packageDir: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !NOT_A_SOURCE.test(entry.name)
      ) {
        out.push(absolute);
      }
    }
  };
  walk(packageDir);
  return out;
};

/** TypeScript / JSX → plain JS, with whichever transform the installed Vite ships. */
export const lowerToJs = async (code: string, filename: string): Promise<string> => {
  const api = vite as Partial<{
    transformWithOxc: (code: string, filename: string) => Promise<{ code: string }>;
    transformWithEsbuild: (code: string, filename: string) => Promise<{ code: string }>;
  }>;
  const transform = api.transformWithOxc ?? api.transformWithEsbuild;
  if (!transform)
    throw new Error('this Vite has neither transformWithOxc nor transformWithEsbuild');
  return (await transform(code, filename)).code;
};

export interface DependencyScanOptions {
  readonly root: string;
  /** Package names (from `runtimeDependents`). */
  readonly packages: readonly string[];
  /** The bundler's parser (`this.parse` of a hook). */
  readonly parse: (code: string) => unknown;
}

export interface DependencyScan extends RuntimeImportFindings {
  /** `package → files parsed`, for the log and the report. */
  readonly parsed: Record<string, number>;
}

/**
 * Parse every source of the given packages that mentions `@pix3/runtime` at all (a cheap text
 * test first: three's one file is a megabyte). Opaque findings carry the package name and the
 * path relative to it.
 */
export const scanDependencyImports = async (
  options: DependencyScanOptions
): Promise<DependencyScan> => {
  const findings: RuntimeImportFindings = { names: new Set(), opaque: [] };
  const parsed: Record<string, number> = {};
  for (const name of options.packages) {
    const dir = findPackageDir(options.root, name);
    if (!dir) continue;
    parsed[name] = 0;
    for (const file of listPackageSources(dir)) {
      let code: string;
      try {
        code = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!code.includes(RUNTIME_SPECIFIER)) continue;
      const label = `${name}/${relative(dir, file).split(sep).join('/')}`;
      try {
        if (NEEDS_LOWERING.test(file)) code = await lowerToJs(code, file);
        collectRuntimeImports(options.parse(code), label, findings);
        parsed[name]++;
      } catch (error) {
        findings.opaque.push(
          `${label}: could not be parsed (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
  }
  return { ...findings, parsed };
};
