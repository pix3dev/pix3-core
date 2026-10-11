/**
 * Which project files are script entries, and which of their exports become `user:*` components.
 *
 * ONE rule for every place that has to agree on it: the editor's `ProjectScriptLoaderService`
 * (registers what Vite's `virtual:pix3/editor-scripts` glob evaluated), the plugin's glob roots
 * and the player's `virtual:pix3/project-scripts` (`packages/vite-plugin` mirrors
 * {@link projectScriptGlobPatterns} and {@link isProjectScriptEntry} — it cannot import the
 * runtime's TypeScript sources at Node run time — pinned by its `script-rule.spec.ts`),
 * `pix3 validate` (level 1 checks that a `user:X` component *exists* without running any code;
 * level 2 compiles the same files and registers exactly like the editor), and the node-profile
 * golden spec. If these drift, a scene the editor loads cleanly fails validation, or — worse —
 * validation passes a component the editor parks as "not registered".
 *
 * The rule, as Vite's glob implements it:
 * - a `.ts` file under `scripts/` or `src/scripts/` (recursively) is an entry — no `.js`, and no
 *   textual gate: a class extending an intermediate base (`extends BaseScript`) in a file without
 *   the words `extends Script` registers like any other (the gate that once asked for them made
 *   `pix3 validate` report such a component as missing while the editor ran it);
 * - `*.spec.ts`, `*.test.ts` and `*.d.ts` are not entries;
 * - every exported value that is a function with a static `getPropertySchema` and whose prototype
 *   chain reaches `Script` registers as **`user:<export name>`** — the export name, not the class's
 *   `.name` and not the file name (`export { Foo as Bar }` registers `user:Bar`).
 *
 * Pure — no DOM, no editor imports.
 */
import { Script } from './ScriptComponent';
import type { ComponentTypeInfo, ScriptRegistry } from './ScriptRegistry';

/** Project-relative folders whose `.ts` files are script entries. */
export const PROJECT_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;

/** A `.ts` file under a script directory that is not an entry: a spec, a test, a declaration. */
export const PROJECT_SCRIPT_EXCLUDE_PATTERN = /\.(?:spec|test)\.ts$|\.d\.ts$/;

/**
 * The `import.meta.glob` patterns of a script root (every `.ts` under `/scripts/`, recursively,
 * minus the excluded kinds), as the plugin's `virtual:pix3/editor-scripts` and the player's project-scripts root
 * write them. `dirs` defaults to {@link PROJECT_SCRIPT_DIRECTORIES}; the bot-policy root passes
 * its own.
 */
export const projectScriptGlobPatterns = (
  dirs: readonly string[] = PROJECT_SCRIPT_DIRECTORIES
): string[] =>
  dirs.flatMap(dir => [
    `/${dir}/**/*.ts`,
    `!/${dir}/**/*.spec.ts`,
    `!/${dir}/**/*.test.ts`,
    `!/${dir}/**/*.d.ts`,
  ]);

/** Namespace of project script component ids (`user:Player`). */
export const USER_SCRIPT_ID_PREFIX = 'user:';

/** Component id a project script export registers under. */
export const userScriptComponentId = (exportName: string): string =>
  `${USER_SCRIPT_ID_PREFIX}${exportName}`;

const normalizeProjectPath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^res:\/\//, '')
    .replace(/^\.?\/+/, '');

/** True for a project-relative path inside one of {@link PROJECT_SCRIPT_DIRECTORIES}. */
export const isProjectScriptPath = (
  path: string,
  dirs: readonly string[] = PROJECT_SCRIPT_DIRECTORIES
): boolean => {
  const normalized = normalizeProjectPath(path);
  return dirs.some(directory => normalized === directory || normalized.startsWith(`${directory}/`));
};

/**
 * True when `path` is a script entry the glob roots pick up, the editor registers and `pix3
 * validate` scans: a `.ts` under one of `dirs` that is not a spec, a test or a declaration.
 */
export const isProjectScriptEntry = (
  path: string,
  dirs: readonly string[] = PROJECT_SCRIPT_DIRECTORIES
): boolean => {
  const normalized = normalizeProjectPath(path);
  return (
    normalized.endsWith('.ts') &&
    !PROJECT_SCRIPT_EXCLUDE_PATTERN.test(normalized) &&
    isProjectScriptPath(normalized, dirs)
  );
};

export type ScriptComponentClass = ComponentTypeInfo['componentClass'];

/**
 * True for an export the editor registers as a component: a function with a static
 * `getPropertySchema` whose prototype chain reaches `Script` (or `Script` itself, as the editor's
 * prototype walk accepts it).
 */
export const isScriptComponentClass = (
  value: unknown,
  base: abstract new (...args: never[]) => unknown = Script
): value is ScriptComponentClass => {
  if (typeof value !== 'function') return false;
  if (typeof (value as { getPropertySchema?: unknown }).getPropertySchema !== 'function') {
    return false;
  }
  if (value === base) return true;
  const baseProto = base.prototype as object;
  let proto = (value as { prototype?: object }).prototype;
  while (proto) {
    if (proto === baseProto) return true;
    proto = Object.getPrototypeOf(proto) as object | undefined;
  }
  return false;
};

/**
 * Register every script-class export of one compiled script module (the namespace of one entry
 * file) as `user:<export name>`, the way the editor does. Returns the ids registered, in export
 * order. Existing registrations with the same id are overwritten (the registry warns).
 */
export const registerProjectScriptExports = (
  registry: ScriptRegistry,
  moduleExports: Readonly<Record<string, unknown>>,
  sourceLabel: string
): string[] => {
  const ids: string[] = [];
  for (const [exportName, exported] of Object.entries(moduleExports)) {
    if (!isScriptComponentClass(exported)) continue;
    const id = userScriptComponentId(exportName);
    registry.registerComponent({
      id,
      displayName: exportName,
      description: `Project component from ${sourceLabel}`,
      category: 'Project',
      componentClass: exported,
      keywords: ['project', 'component', exportName.toLowerCase(), sourceLabel.toLowerCase()],
    });
    ids.push(id);
  }
  return ids;
};
