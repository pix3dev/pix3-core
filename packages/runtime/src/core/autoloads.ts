/**
 * Autoloads: project-wide script singletons that live for the whole game session, across every
 * `changeScene` (Godot's autoloads). Declared in `pix3project.yaml`:
 *
 * ```yaml
 * autoloads:
 *   - singleton: GameState          # the name scripts look it up by
 *     scriptPath: scripts/GameState.ts
 *     enabled: true                 # optional, default true
 * ```
 *
 * The script file must be a project script entry (`scripts/` or `src/scripts/`, `extends Script`)
 * exporting a `Script` class named like the file: `scripts/GameState.ts` → `user:GameState`.
 *
 * One runtime implementation serves every host: the player (`@pix3/vite-plugin/player`, dev and
 * build), the editor's play mode and the headless harnesses all hand the manifest's list to
 * `SceneRunner.setAutoloads`, and the runner drives an {@link AutoloadHost}. Pure — no DOM.
 */
import { NodeBase } from '../nodes/NodeBase';
import { describeThrown, reportScriptError } from './game-debug';
import type { AutoloadConfig } from './ProjectManifest';
import { userScriptComponentId } from './project-script-registration';
import type { ScriptComponent } from './ScriptComponent';
import type { ScriptRegistry } from './ScriptRegistry';
import type { InputService } from './InputService';
import type { SceneService } from './SceneService';

/** Id of the hidden root the autoload nodes hang under. Never part of a scene graph. */
const AUTOLOAD_ROOT_ID = '__autoloads__';

/** Node id of one autoload's node (also the component id): `autoload:<singleton>`. */
const autoloadNodeId = (singleton: string): string => `autoload:${singleton}`;

/**
 * The component type an autoload's script registers as: the file name without its extension,
 * `scripts/ui/GameState.ts` → `user:GameState` (the export must carry the file's name).
 */
export const autoloadComponentType = (scriptPath: string): string => {
  const normalized = scriptPath.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  return userScriptComponentId(fileName.replace(/\.[cm]?[jt]sx?$/i, ''));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The manifest's `autoloads:` list, normalised the way every host reads it: entries without a
 * `singleton` or a `scriptPath` are dropped, `enabled` defaults to true, a repeated singleton name
 * keeps its first entry. (`pix3 validate` reports what this drops.)
 */
export const normalizeAutoloads = (input: unknown): AutoloadConfig[] => {
  if (!Array.isArray(input)) return [];
  const out: AutoloadConfig[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const scriptPath = typeof entry.scriptPath === 'string' ? entry.scriptPath.trim() : '';
    const singleton = typeof entry.singleton === 'string' ? entry.singleton.trim() : '';
    if (!scriptPath || !singleton || seen.has(singleton)) continue;
    seen.add(singleton);
    out.push({ scriptPath, singleton, enabled: entry.enabled !== false });
  }
  return out;
};

type ScriptClass<T> = abstract new (...args: never[]) => T;

/**
 * The session's autoload singletons. The runner {@link start}s it before the first scene's first
 * frame, {@link tick}s it before the scene every frame, and {@link stop}s it only when the session
 * ends (`SceneRunner.stop()`), never on a scene change. Each singleton is a component on its own
 * node (`autoload:<singleton>`, named like the singleton) under a hidden root that is not in the
 * rendered scene: an autoload is logic and state, not a visual.
 *
 * Lifecycle, per session: every autoload's `onAttach` (in manifest order) when the session starts;
 * `onStart` on the first frame, before any scene component's `onStart`; `onUpdate(dt)` every frame
 * before the scene's; `onDetach` when the session stops, after the scene's.
 */
export class AutoloadHost {
  private entries: readonly AutoloadConfig[] = [];
  private registry: ScriptRegistry | null = null;
  private root: NodeBase | null = null;
  private readonly instances = new Map<string, ScriptComponent>();

  /** The list to build on the next {@link start}. A running session keeps what it built. */
  configure(entries: readonly AutoloadConfig[], registry: ScriptRegistry | null): void {
    this.entries = entries.map(entry => ({ ...entry }));
    this.registry = registry;
  }

  /**
   * Build the singletons (once per session; a second call is a no-op). An entry whose type does
   * not resolve is reported as a script error and skipped — the game runs without it, as a scene
   * component of an unknown type would.
   */
  start(input: InputService, scene: SceneService): void {
    if (this.root) return;
    const root = new NodeBase({
      id: AUTOLOAD_ROOT_ID,
      type: 'Autoloads',
      name: 'Autoloads',
      metadata: { internal: true },
    });
    this.root = root;
    root.input = input;
    root.scene = scene;
    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      const type = autoloadComponentType(entry.scriptPath);
      const id = autoloadNodeId(entry.singleton);
      const component =
        this.registry?.createComponent(type, id, { expectRegistered: false }) ?? null;
      if (!component) {
        const message =
          `Autoload "${entry.singleton}": ${entry.scriptPath} does not register ${type} ` +
          `(the file must be under scripts/ and export a Script class named like the file).`;
        console.error(`[Autoloads] ${message}`);
        reportScriptError({ phase: 'attach', message, componentType: type, componentId: id });
        continue;
      }
      const node = new NodeBase({ id, type: 'Autoload', name: entry.singleton });
      root.adoptChild(node);
      try {
        node.addComponent(component);
      } catch (thrown) {
        const { message, stack } = describeThrown(thrown);
        reportScriptError({
          phase: 'attach',
          message,
          stack,
          componentType: type,
          componentId: id,
        });
      }
      this.instances.set(entry.singleton, component);
    }
  }

  /** Run the singletons' frame: `onStart` on the first one, then `onUpdate(dt)`. */
  tick(dt: number): void {
    this.root?.tick(dt);
  }

  /** End the session: `onDetach` of every singleton (reverse manifest order), then drop them. */
  stop(): void {
    const root = this.root;
    if (!root) return;
    this.root = null;
    const nodes = [...root.children].filter(
      (child): child is NodeBase => child instanceof NodeBase
    );
    for (const node of nodes.reverse()) {
      for (const component of [...node.components]) {
        try {
          node.removeComponent(component);
        } catch (thrown) {
          const { message, stack } = describeThrown(thrown);
          console.error('[Autoloads] onDetach failed', { componentId: component.id, thrown });
          reportScriptError({
            phase: 'detach',
            message,
            stack,
            componentType: component.type,
            componentId: component.id,
          });
        }
      }
    }
    this.instances.clear();
    root.dispose();
  }

  /** The singleton registered under `name`, or of class `type`; null when there is none. */
  get<T extends ScriptComponent = ScriptComponent>(nameOrType: string | ScriptClass<T>): T | null {
    if (typeof nameOrType === 'string') {
      return (this.instances.get(nameOrType) as T | undefined) ?? null;
    }
    for (const component of this.instances.values()) {
      if (component instanceof nameOrType) return component;
    }
    return null;
  }
}
