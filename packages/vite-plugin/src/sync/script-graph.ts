import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import type { EnvironmentModuleNode, ViteDevServer } from 'vite';

import { isExcludedPath } from '../files/scan.ts';

/**
 * The scripts the editor executes, and the proof that it executed the bytes on disk (plan §B.2).
 *
 * - `virtual:pix3/editor-scripts` — eager `import.meta.glob` over `scripts/` and `src/scripts/`
 *   (no specs, tests or declarations), exporting `__pix3Revision`;
 * - `virtual:pix3/bot-policies` — the same over `design/tests/bots/`;
 * - every project source module the client environment transforms gets an **executed-content
 *   stamp**, `(globalThis.__pix3Executed ??= {})[path] = sha`, which runs only when that module
 *   body runs. S1 showed the root's own hashes prove nothing about nested modules; the stamp does.
 */

export const EDITOR_SCRIPTS_ID = 'virtual:pix3/editor-scripts';
export const BOT_POLICIES_ID = 'virtual:pix3/bot-policies';
export const ROOT_IDS = [EDITOR_SCRIPTS_ID, BOT_POLICIES_ID] as const;
export const resolvedId = (id: string): string => `\0${id}`;

export const SCRIPT_DIRS = ['scripts', 'src/scripts'] as const;
export const BOT_POLICY_DIRS = ['design/tests/bots'] as const;

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const NOT_A_SCRIPT = /\.(?:spec|test)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

const globPatterns = (dirs: readonly string[]): string[] => {
  const patterns: string[] = [];
  for (const dir of dirs) {
    patterns.push(
      `/${dir}/**/*.ts`,
      `!/${dir}/**/*.spec.ts`,
      `!/${dir}/**/*.test.ts`,
      `!/${dir}/**/*.d.ts`
    );
  }
  return patterns;
};

/** Source of a glob root; `revision` is the file table's `seq` when Vite loads it. */
export const rootModuleSource = (id: string, revision: number): string => {
  const dirs = id === BOT_POLICIES_ID ? BOT_POLICY_DIRS : SCRIPT_DIRS;
  return [
    `export const __pix3Revision = ${revision};`,
    `export const modules = import.meta.glob(${JSON.stringify(globPatterns(dirs))}, { eager: true });`,
    '',
  ].join('\n');
};

/** True for a wire path the editor-scripts or bot-policies glob picks up. */
export const isGlobbedScript = (wirePath: string): boolean =>
  wirePath.endsWith('.ts') &&
  !NOT_A_SCRIPT.test(wirePath) &&
  [...SCRIPT_DIRS, ...BOT_POLICY_DIRS].some(dir => wirePath.startsWith(`${dir}/`));

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export class ScriptGraph {
  private readonly root: string;
  private readonly server: () => ViteDevServer | null;

  /** Absolute directories inside the root that hold no project sources (Vite's `cacheDir`). */
  private readonly ignored: readonly string[];

  constructor(root: string, server: () => ViteDevServer | null, ignored: readonly string[] = []) {
    this.root = root;
    this.server = server;
    this.ignored = ignored.map(dir => dir.replace(/[\\/]+$/, ''));
  }

  /** Module id (absolute path, maybe with a query) → wire path, when it is a project source. */
  wirePathOf(id: string): string | null {
    const file = id.split('?')[0];
    if (!isAbsolute(file) || !SOURCE_EXTENSION.test(file)) return null;
    // A pre-bundled dependency in an in-project `cacheDir` is not the project's code.
    if (this.ignored.some(dir => file.startsWith(`${dir}${sep}`) || file.startsWith(`${dir}/`)))
      return null;
    const rel = relative(this.root, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const wirePath = rel.split(sep).join('/');
    return isExcludedPath(wirePath) ? null : wirePath;
  }

  absoluteOf(wirePath: string): string {
    return `${this.root}${sep}${wirePath.split('/').join(sep)}`;
  }

  /**
   * `transform` hook body: append the executed-content stamp to a project source module. The sha
   * is of the file on disk (what the barrier compares with), not of `code`.
   */
  stamp(code: string, id: string): string | null {
    const wirePath = this.wirePathOf(id);
    if (wirePath === null) return null;
    let sha: string;
    try {
      sha = sha256Hex(readFileSync(id.split('?')[0]));
    } catch {
      return null;
    }
    return (
      `${code}\n;(globalThis.__pix3Executed ??= {})[${JSON.stringify(wirePath)}] = ` +
      `${JSON.stringify(sha)};\n`
    );
  }

  private graph(): ViteDevServer['environments']['client'] | null {
    return this.server()?.environments.client ?? null;
  }

  rootModules(): EnvironmentModuleNode[] {
    const env = this.graph();
    if (!env) return [];
    const out: EnvironmentModuleNode[] = [];
    for (const id of ROOT_IDS) {
      const mod = env.moduleGraph.getModuleById(resolvedId(id));
      if (mod) out.push(mod);
    }
    return out;
  }

  /**
   * Vite ≥ 5.1 SOFT-invalidates static importers of a changed module: the cached transform is
   * reused with re-stamped `?t=` and `load()` does not run again, so `__pix3Revision` would stay
   * stale (S1, finding 1). The roots are hard-invalidated explicitly.
   */
  hardInvalidateRoots(): void {
    const env = this.graph();
    if (!env) return;
    const now = Date.now();
    for (const mod of this.rootModules()) {
      env.moduleGraph.invalidateModule(mod, new Set(), now, true, false);
    }
  }

  /** Client-environment nodes of a file (never Vite 8's mixed nodes — S1, finding 5). */
  modulesOf(wirePath: string): EnvironmentModuleNode[] {
    const env = this.graph();
    if (!env) return [];
    return [...(env.moduleGraph.getModulesByFile(this.absoluteOf(wirePath)) ?? [])];
  }

  /** True when the editor executes `wirePath`: globbed, or imported (transitively) by a root. */
  isEditorModule(wirePath: string): boolean {
    if (isGlobbedScript(wirePath)) return true;
    const roots = new Set(ROOT_IDS.map(resolvedId));
    const seen = new Set<EnvironmentModuleNode>();
    const queue = this.modulesOf(wirePath);
    while (queue.length > 0) {
      const mod = queue.shift() as EnvironmentModuleNode;
      if (seen.has(mod)) continue;
      seen.add(mod);
      if (mod.id && roots.has(mod.id)) return true;
      for (const importer of mod.importers) queue.push(importer);
    }
    return false;
  }

  /**
   * Project modules only the bot policies reach (`.plans/scripts-vite.md` S4/S11): reachable from
   * `virtual:pix3/bot-policies` and not from `virtual:pix3/editor-scripts`, so the game the editor
   * plays never runs them and a change to one need not wait for play to stop. Read from the client
   * graph as it is now (after the barrier's propagation); a module the graph has not seen is not
   * listed, which errs on the side of holding play.
   */
  policyOnlyModules(): string[] {
    const env = this.graph();
    if (!env) return [];
    const reach = (rootId: string): Set<string> => {
      const out = new Set<string>();
      const root = env.moduleGraph.getModuleById(resolvedId(rootId));
      if (!root) return out;
      const seen = new Set<EnvironmentModuleNode>([root]);
      const queue = [...root.importedModules];
      while (queue.length > 0) {
        const mod = queue.shift() as EnvironmentModuleNode;
        if (seen.has(mod)) continue;
        seen.add(mod);
        const wirePath = mod.file ? this.wirePathOf(mod.file) : null;
        if (wirePath !== null) out.add(wirePath);
        for (const imported of mod.importedModules) queue.push(imported);
      }
      return out;
    };
    // No editor root in the graph yet: nothing can be proven policy-only.
    if (!env.moduleGraph.getModuleById(resolvedId(EDITOR_SCRIPTS_ID))) return [];
    const game = reach(EDITOR_SCRIPTS_ID);
    return [...reach(BOT_POLICIES_ID)].filter(path => !game.has(path)).sort();
  }

  /** HMR-propagate one file through the client graph (stamps `lastHMRTimestamp` up the chain). */
  async reload(wirePath: string): Promise<number> {
    const env = this.graph();
    if (!env) return 0;
    const mods = this.modulesOf(wirePath);
    for (const mod of mods) await env.reloadModule(mod);
    return mods.length;
  }

  /** Re-run the roots' globs (a script was added or removed). */
  async reloadRoots(): Promise<void> {
    const env = this.graph();
    if (!env) return;
    for (const mod of this.rootModules()) await env.reloadModule(mod);
  }
}
