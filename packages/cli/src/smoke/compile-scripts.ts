import { pathToFileURL } from 'node:url';

import type { ScriptRegistry } from '@pix3/runtime';

import type { ProjectFiles } from '../validate/project.ts';
import {
  buildFailures,
  hostImportsPlugin,
  importAndRegister,
  loadEsbuild,
  scriptBuildOptions,
  STUB_NAMESPACE,
  type ScriptImportMap,
} from '../validate/script-build.ts';

/**
 * Compile the project's scripts for **running**, not just for registering.
 *
 * `pix3 validate` level 2 compiles the same entries but turns every bare import other than
 * `@pix3/runtime` / `three` into an empty module — it only needs the classes defined. A smoke run
 * executes them, so here a bare import is bundled for real from the project's own `node_modules`
 * (a consumer project such as one that uses Rapier directly has it installed), falling back to the
 * CLI's install for `three/*` addons. Only what resolves nowhere is stubbed, and every stub is
 * reported: a game whose physics library became `{}` is not the game.
 */

export type CompileResult =
  | {
      readonly status: 'loaded';
      readonly registered: readonly string[];
      readonly stubbed: readonly string[];
      readonly bundledPackages: readonly string[];
    }
  | { readonly status: 'none' }
  | {
      readonly status: 'compile-failed';
      readonly failures: readonly {
        readonly message: string;
        readonly file?: string;
        readonly line?: number;
      }[];
    }
  | {
      readonly status: 'import-failed';
      readonly error: unknown;
      readonly stubbed: readonly string[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

export const compileAndImportScripts = async (
  project: ProjectFiles,
  entries: readonly string[],
  registry: ScriptRegistry,
  imports: ScriptImportMap,
  options: {
    readonly esbuildSpecifier?: string;
    /** Where `three/*` addons resolve when the project has no `three` of its own. */
    readonly fallbackResolveDir?: string;
  } = {}
): Promise<CompileResult> => {
  if (entries.length === 0) return { status: 'none' };
  const esbuild = await loadEsbuild(options.esbuildSpecifier ?? 'esbuild');
  if (!esbuild) {
    return {
      status: 'unavailable',
      reason:
        'esbuild is not installed (it is an optional dependency of @pix3/cli), so the project scripts cannot be compiled',
    };
  }
  const stubbed = new Set<string>();
  const bundled = new Set<string>();
  const fallbackDir = options.fallbackResolveDir;
  let code: string;
  try {
    const result = await esbuild.build({
      ...scriptBuildOptions(project, entries, 'pix3-smoke-scripts.ts'),
      platform: 'browser',
      // Sources in the map are relative to this root, not the invoking CLI's cwd.
      absWorkingDir: project.root,
      // Stacks point at the project's own files (Node applies it: `setSourceMapsEnabled`).
      sourcemap: 'inline',
      // A directory URL keeps Windows drive letters and separators unambiguous for Node.
      sourceRoot: `${pathToFileURL(project.root).href.replace(/\/$/, '')}/`,
      plugins: [
        hostImportsPlugin('pix3-smoke-imports', imports, project, async (args, build) => {
          if (args.pluginData === 'pix3-smoke') return undefined;
          if (args.path.startsWith('node:') || args.path.startsWith('virtual:')) {
            stubbed.add(args.path);
            return { path: args.path, namespace: STUB_NAMESPACE };
          }
          const attempt = async (resolveDir: string) =>
            build.resolve(args.path, { kind: args.kind, resolveDir, pluginData: 'pix3-smoke' });
          let resolved = await attempt(args.resolveDir);
          if (resolved.errors.length > 0 && fallbackDir && packageNameOf(args.path) === 'three') {
            resolved = await attempt(fallbackDir);
          }
          if (resolved.errors.length > 0 || !resolved.path) {
            stubbed.add(args.path);
            return { path: args.path, namespace: STUB_NAMESPACE };
          }
          bundled.add(packageNameOf(args.path));
          return { path: resolved.path, external: resolved.external };
        }),
      ],
    });
    code = result.outputFiles?.[0]?.text ?? '';
  } catch (error) {
    return {
      status: 'compile-failed',
      failures: buildFailures(error).map(failure => ({
        message: failure.text,
        file: failure.location?.file,
        line: failure.location?.line,
      })),
    };
  }
  try {
    return {
      status: 'loaded',
      registered: await importAndRegister(code, entries, registry, 'pix3-smoke-scripts-'),
      stubbed: [...stubbed].sort(),
      bundledPackages: [...bundled].sort(),
    };
  } catch (error) {
    return { status: 'import-failed', error, stubbed: [...stubbed].sort() };
  }
};
