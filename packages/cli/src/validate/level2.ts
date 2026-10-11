import { join } from 'node:path';

import {
  collectRenderabilityIssues,
  SceneLoader,
  SceneValidationError,
  type ScriptRegistry,
} from '@pix3/runtime';
import {
  collectLoaderWarnings,
  DiskResourceManager,
  installCanvasOnlyDocument,
  MissingResourceError,
  NodeAssetLoader,
} from '@pix3/runtime/node';

import { diagnostic, type Diagnostic } from './diagnostics.ts';
import { checkComponentConfig, type Level1Environment } from './level1.ts';
import type { ProjectFiles } from './project.ts';
import {
  buildFailures,
  hostImportsPlugin,
  importAndRegister,
  loadEsbuild,
  scriptBuildOptions,
  STUB_NAMESPACE,
  type ScriptImportMap,
} from './script-build.ts';
import { isRecord, type DocPath, type ParsedYaml } from './yaml-doc.ts';

/**
 * Level 2 of `pix3 validate`: the real `SceneLoader`, with the project's scripts compiled by native
 * esbuild and imported — what the editor does with them through Vite, minus the browser.
 *
 * It needs no DOM beyond the canvas-only `document` shim (`@pix3/runtime/node`): measured on every
 * template scene in `.plans/measurements/external-agent-phase0-strict-profile.md`. It does run the
 * project's code (module top level and component constructors), which is why it is separate and
 * can be turned off (`--no-hydrate`).
 */

export type { ScriptImportMap };

/** Bare specifiers kept as-is: right when the host resolves them itself (vitest's aliases). */
export const BARE_SCRIPT_IMPORTS: ScriptImportMap = { runtime: '@pix3/runtime', three: 'three' };

export type ScriptLoadResult =
  | { readonly status: 'none' }
  | { readonly status: 'loaded'; readonly registered: readonly string[] }
  | { readonly status: 'failed'; readonly diagnostics: Diagnostic[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Compile the project's script entries, import them, register their Script exports. Every bare
 * import other than `@pix3/runtime` / `three` (three addons, rapier, …) becomes an empty module —
 * Vite resolves it from the project's node_modules, not here, and validation only needs the
 * classes to be defined, not to run.
 */
export const loadUserScripts = async (
  project: ProjectFiles,
  entries: readonly string[],
  registry: ScriptRegistry,
  imports: ScriptImportMap,
  /** Where `esbuild` resolves from; the bundle may live in a temp folder with no node_modules. */
  esbuildSpecifier = 'esbuild'
): Promise<ScriptLoadResult> => {
  if (entries.length === 0) return { status: 'none' };
  const esbuild = await loadEsbuild(esbuildSpecifier);
  if (!esbuild) {
    return {
      status: 'unavailable',
      reason:
        'esbuild is not installed (it is an optional dependency of @pix3/cli), so project scripts cannot be compiled',
    };
  }
  let code: string;
  try {
    const result = await esbuild.build({
      ...scriptBuildOptions(project, entries, 'pix3-validate-scripts.ts'),
      // Error locations are reported relative to this; the project root makes them
      // project-relative whatever the process's cwd is.
      absWorkingDir: project.root,
      platform: 'neutral',
      plugins: [
        hostImportsPlugin('pix3-validate-host-imports', imports, project, args => ({
          path: args.path,
          namespace: STUB_NAMESPACE,
        })),
      ],
    });
    code = result.outputFiles?.[0]?.text ?? '';
  } catch (error) {
    const diagnostics = buildFailures(error).map(failure =>
      diagnostic({
        code: 'E_SCRIPT_COMPILE',
        file: failure.location?.file
          ? (project.relativeOf(join(project.root, failure.location.file)) ?? failure.location.file)
          : 'scripts',
        line: failure.location?.line,
        message: `Project scripts do not compile: ${failure.text}. The editor registers none of them, so every user: component stays unregistered.`,
      })
    );
    return { status: 'failed', diagnostics };
  }
  try {
    return {
      status: 'loaded',
      registered: await importAndRegister(code, entries, registry, 'pix3-validate-'),
    };
  } catch (error) {
    return {
      status: 'failed',
      diagnostics: [
        diagnostic({
          code: 'W_SCRIPT_IMPORT',
          file: 'scripts',
          message: `The compiled project scripts threw when imported in Node (${error instanceof Error ? error.message : String(error)}) — probably a browser global used at module top level. user: component properties not checked.`,
        }),
      ],
    };
  }
};

/**
 * The loader's warning for a component it parked (`component-hydration.ts`): type, node id. Read by
 * level 2 (`E_PENDING_COMPONENT`) and by `pix3 smoke`; the E_PENDING_COMPONENT spec pins the text.
 */
export const PENDING_COMPONENT_WARNING =
  /Component type "(.*?)" is not registered yet — kept as pending on node "(.*?)"/;
const OVERRIDE_TARGET = /Override target "(.*?)" not found/;

export interface HydrateOptions {
  readonly env: Level1Environment;
  /** Registry with `core:` and the project's `user:` components. */
  readonly registry: ScriptRegistry;
  readonly file: string;
  readonly text: string;
  readonly parsed: ParsedYaml;
  readonly targetPlatform?: string;
  /** Prefabs (`instance:` targets) are not whole scenes — no renderability lint for them. */
  readonly isPrefab: boolean;
  /** `user:` schemas are available (scripts loaded), so their config can be checked. */
  readonly checkUserConfig: boolean;
}

/** Hydrate one scene through the real loader and report what it rejected, warned or parked. */
export const hydrateScene = async (options: HydrateOptions): Promise<Diagnostic[]> => {
  const { env, registry, file } = options;
  const out: Diagnostic[] = [];
  const disk = new DiskResourceManager(env.project.root);
  const loader = new SceneLoader(new NodeAssetLoader(disk), registry, disk);
  const uninstall = installCanvasOnlyDocument();
  try {
    const { result: graph, warnings } = await collectLoaderWarnings(() =>
      loader.parseScene(options.text, { filePath: `res://${file}` })
    );
    for (const warning of warnings) {
      const pending = PENDING_COMPONENT_WARNING.exec(warning.message);
      if (pending) {
        out.push(
          diagnostic({
            code: 'E_PENDING_COMPONENT',
            file,
            nodeId: pending[2],
            message: `Component ${pending[1]} on node "${pending[2]}" is still unregistered after compiling the project scripts; it never runs.`,
          })
        );
      } else if (warning.error instanceof MissingResourceError) {
        out.push(
          diagnostic({
            code: 'E_MISSING_RESOURCE',
            file,
            message: `${warning.error.resource} does not exist (the loader warned: ${warning.message.split(':')[0]}).`,
          })
        );
      } else if (OVERRIDE_TARGET.test(warning.message)) {
        out.push(
          diagnostic({
            code: 'E_UNKNOWN_OVERRIDE_TARGET',
            file,
            message: `${warning.message.replace(/^\[SceneLoader\]\s*/, '')} The override is dropped.`,
          })
        );
      } else {
        out.push(
          diagnostic({
            code: 'E_LOAD',
            file,
            message: `The loader warned: ${warning.message.replace(/^\[SceneLoader\]\s*/, '')}`,
          })
        );
      }
    }
    if (options.checkUserConfig) {
      walkComponents(options.parsed.data, (type, config, nodeId, at) => {
        if (!type.startsWith('user:')) return;
        const schema = registry.getComponentPropertySchema(type)?.properties;
        if (!schema) return;
        out.push(
          ...checkComponentConfig(env, file, options.parsed, type, schema, config, nodeId, at)
        );
      });
    }
    if (!options.isPrefab) {
      for (const issue of collectRenderabilityIssues(graph.rootNodes, {
        targetPlatform: options.targetPlatform,
      })) {
        if (issue.code === 'inert-nodes') continue; // level 1 reports E_UNKNOWN_NODE_TYPE
        out.push(
          diagnostic({
            code: `W_RENDERABILITY_${issue.code.toUpperCase().replace(/-/g, '_')}`,
            file,
            nodeId: issue.nodeIds[0],
            message: issue.message,
          })
        );
      }
    }
  } catch (error) {
    if (error instanceof SceneValidationError) {
      out.push(
        diagnostic({
          code: 'E_LOAD',
          file,
          message: `The loader rejects the scene: ${error.message}${error.details.length > 0 ? ` (${error.details.join('; ')})` : ''}`,
        })
      );
    } else if (error instanceof MissingResourceError) {
      out.push(
        diagnostic({
          code: 'E_MISSING_RESOURCE',
          file,
          message: `${error.resource} does not exist; the loader fails the whole scene.`,
        })
      );
    } else {
      out.push(
        diagnostic({
          code: 'E_LOAD',
          file,
          message: `The loader threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}.`,
        })
      );
    }
  } finally {
    uninstall();
  }
  return out;
};

const walkComponents = (
  data: unknown,
  visit: (
    type: string,
    config: Record<string, unknown>,
    nodeId: string | undefined,
    at: DocPath
  ) => void
): void => {
  const walkNode = (node: unknown, at: DocPath): void => {
    if (!isRecord(node)) return;
    const nodeId = typeof node.id === 'string' ? node.id : undefined;
    if (Array.isArray(node.components)) {
      node.components.forEach((component, index) => {
        if (isRecord(component) && typeof component.type === 'string') {
          visit(component.type, isRecord(component.config) ? component.config : {}, nodeId, [
            ...at,
            'components',
            index,
            'config',
          ]);
        }
      });
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => walkNode(child, [...at, 'children', index]));
    }
  };
  if (isRecord(data) && Array.isArray(data.root)) {
    data.root.forEach((node, index) => walkNode(node, ['root', index]));
  }
};
