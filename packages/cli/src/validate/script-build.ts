import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerProjectScriptExports, type ScriptRegistry } from '@pix3/runtime';
import type { BuildOptions, OnResolveArgs, OnResolveResult, Plugin, PluginBuild } from 'esbuild';

import type { ProjectFiles } from './project.ts';
import { isRecord } from './yaml-doc.ts';

/**
 * Compiling the project's script entries with esbuild where Vite would serve them — shared by
 * `pix3 validate` level 2 (defines the classes) and `pix3 smoke` (runs them). What differs is
 * only where a bare import goes: validate stubs it, smoke bundles it from the project.
 */

/** What a compiled user script's `@pix3/runtime` and `three` imports are rewritten to. */
export interface ScriptImportMap {
  /** Specifier for `@pix3/runtime` — must be the very instance the caller uses. */
  readonly runtime: string;
  /** Specifier for `three`. */
  readonly three: string;
}

type EsbuildModule = typeof import('esbuild');

export const loadEsbuild = async (specifier: string): Promise<EsbuildModule | null> => {
  try {
    return (await import(specifier)) as EsbuildModule;
  } catch {
    return null;
  }
};

/** Where an empty module stands in for an import (`module.exports = {}`). */
export const STUB_NAMESPACE = 'pix3-stub';

/**
 * The build options every script compile shares: one stdin module re-exporting each entry as
 * `__pix3_entry_<n>` (read back by {@link importAndRegister}), and Vite's asset loaders and dev
 * `import.meta.env`.
 */
export const scriptBuildOptions = (
  project: ProjectFiles,
  entries: readonly string[],
  sourcefile: string
): BuildOptions => ({
  stdin: {
    contents: entries
      .map(
        (file, index) => `export * as __pix3_entry_${index} from ${JSON.stringify(`./${file}`)};`
      )
      .join('\n'),
    resolveDir: project.root,
    sourcefile,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  logLevel: 'silent',
  loader: { '.glsl': 'text', '.vert': 'text', '.frag': 'text', '.css': 'empty', '.wasm': 'binary' },
  define: {
    'import.meta.env.BASE_URL': JSON.stringify('/'),
    'import.meta.env.DEV': 'true',
    'import.meta.env.PROD': 'false',
    'import.meta.env.MODE': JSON.stringify('development'),
  },
});

/**
 * Stands in for Vite: `@pix3/runtime` and `three` are the host's (external), `?raw` / `?url` load
 * as Vite loads them, and every other bare import goes to `resolveBare` (an `undefined` answer
 * leaves it to esbuild).
 */
export const hostImportsPlugin = (
  name: string,
  imports: ScriptImportMap,
  project: ProjectFiles,
  resolveBare: (
    args: OnResolveArgs,
    build: PluginBuild
  ) => OnResolveResult | undefined | Promise<OnResolveResult | undefined>
): Plugin => ({
  name,
  setup(build) {
    build.onResolve({ filter: /^@pix3\/runtime$/ }, () => ({
      path: imports.runtime,
      external: true,
    }));
    build.onResolve({ filter: /^three$/ }, () => ({ path: imports.three, external: true }));
    build.onResolve({ filter: /\?(raw|url)$/ }, args => {
      const [path, query] = args.path.split('?');
      return {
        path: join(args.resolveDir, path),
        namespace: query === 'raw' ? 'pix3-raw' : 'pix3-url',
      };
    });
    build.onResolve({ filter: /^[^./]/ }, args =>
      args.kind === 'entry-point' ? undefined : resolveBare(args, build)
    );
    build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pix3-raw' }, async args => {
      const { readFile } = await import('node:fs/promises');
      return {
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
        loader: 'js',
      };
    });
    build.onLoad({ filter: /.*/, namespace: 'pix3-url' }, args => ({
      contents: `export default ${JSON.stringify(`res://${project.relativeOf(args.path) ?? args.path}`)};`,
      loader: 'js',
    }));
  },
});

export interface BuildFailure {
  readonly text: string;
  readonly location?: { readonly file: string; readonly line: number } | null;
}

/** What a failed `esbuild.build` reports: its error list, or the error itself as one entry. */
export const buildFailures = (error: unknown): BuildFailure[] => {
  const failures = (error as { errors?: BuildFailure[] }).errors ?? [];
  return failures.length > 0 ? failures : [{ text: String(error), location: null }];
};

/**
 * Import the compiled entries (through a temp module file) and register every entry's Script
 * exports; returns the registered ids. Throws what the import throws.
 */
export const importAndRegister = async (
  code: string,
  entries: readonly string[],
  registry: ScriptRegistry,
  tempPrefix: string
): Promise<string[]> => {
  const dir = mkdtempSync(join(tmpdir(), tempPrefix));
  const modulePath = join(dir, 'scripts.mjs');
  try {
    writeFileSync(modulePath, code);
    const module = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const registered: string[] = [];
    entries.forEach((file, index) => {
      const namespace = module[`__pix3_entry_${index}`];
      if (isRecord(namespace))
        registered.push(...registerProjectScriptExports(registry, namespace, file));
    });
    return registered;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
