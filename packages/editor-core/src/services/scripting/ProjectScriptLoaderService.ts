import { subscribe } from 'valtio/vanilla';

import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import {
  isScriptComponentClass,
  SceneManager,
  ScriptRegistry,
  userScriptComponentId,
  type ScriptComponentClass,
} from '@pix3/runtime';
import type { ScriptRoots } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import { LoggingService } from '@/services/core/LoggingService';

export interface SkippedScriptExport {
  /** Project-relative path of the module that exported it (`scripts/Foo.ts`). */
  readonly file: string;
  readonly export: string;
  readonly reason: string;
}

export interface RegisterRootsResult {
  /** Component ids registered by this call (`user:<ExportName>`), in module/export order. */
  readonly registered: string[];
  readonly skipped: SkippedScriptExport[];
}

/** Glob key of `virtual:pix3/editor-scripts` (`/scripts/Foo.ts`) → project path (`scripts/Foo.ts`). */
const projectPathOfGlobKey = (key: string): string => key.replace(/^(\.\.?\/|\/)+/, '');

/**
 * Registers the project's script components from the host's script roots (plan
 * `.plans/editor-core-port.md` §3, D7).
 *
 * The editor compiles nothing: Vite imports `scripts/` and `src/scripts/` through the plugin's
 * `virtual:pix3/editor-scripts` root, and the host hands the evaluated modules over as
 * {@link ScriptRoots}. Every export that is a `Script` subclass with a static `getPropertySchema`
 * registers as `user:<export name>` — the rule `register-project-scripts.ts` applies in the player
 * and `pix3 validate` applies headless (`project-script-registration.ts` in the runtime).
 *
 * Live components are not re-instantiated on re-registration (1.x parity): a new class reaches a
 * scene on its next load. Components parked on nodes because their type was missing at load are
 * attached right away.
 */
@injectable()
export class ProjectScriptLoaderService {
  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(HostService)
  private readonly hostService!: HostService;

  private readonly registeredIds = new Set<string>();
  /** Roots that arrived during play mode ({@link queueRoots}); applied when play stops. */
  private pendingRoots: ScriptRoots | null = null;
  private disposePlayWatch: (() => void) | null = null;

  /**
   * Replace every `user:*` registration with the script classes of `roots.editorScripts`.
   * Bot policies (`roots.botPolicies`) are not components; `GameBotHost` reads them.
   */
  registerRoots(roots: ScriptRoots): RegisterRootsResult {
    const registered: string[] = [];
    const skipped: SkippedScriptExport[] = [];
    try {
      this.clearRegisteredScripts();
      const owners = new Map<string, { file: string; ctor: ScriptComponentClass }>();
      for (const [key, exportsMap] of Object.entries(roots.editorScripts.modules)) {
        const file = projectPathOfGlobKey(key);
        for (const [exportName, value] of Object.entries(exportsMap)) {
          if (!isScriptComponentClass(value)) continue;
          const owner = owners.get(exportName);
          if (owner) {
            // A re-export of the same class under the same name is the same component.
            if (owner.ctor !== value) {
              skipped.push({
                file,
                export: exportName,
                reason: `duplicate export name: user:${exportName} is already registered from ${owner.file}`,
              });
            }
            continue;
          }
          owners.set(exportName, { file, ctor: value });
          const id = userScriptComponentId(exportName);
          this.scriptRegistry.registerComponent({
            id,
            displayName: exportName,
            description: `Project component from ${file}`,
            category: 'Project',
            componentClass: value,
            keywords: ['project', 'component', exportName.toLowerCase(), file.toLowerCase()],
          });
          this.registeredIds.add(id);
          registered.push(id);
        }
      }
      for (const skip of skipped) {
        this.logger.warn(`Skipped project script ${skip.file} → ${skip.export}: ${skip.reason}`);
      }
      this.attachPendingSceneComponents();
      appState.project.scriptRefreshSignal++;
      appState.project.scriptsStatus = 'ready';
    } catch (error) {
      appState.project.scriptsStatus = 'error';
      this.logger.error('Failed to register project scripts', error);
    }
    return { registered, skipped };
  }

  /**
   * {@link registerRoots} now, or — during play mode — once play stops (the running game keeps
   * the classes it started with). The latest roots win.
   */
  queueRoots(roots: ScriptRoots): void {
    if (!appState.ui.isPlaying) {
      this.pendingRoots = null;
      this.registerRoots(roots);
      return;
    }
    this.pendingRoots = roots;
    this.disposePlayWatch ??= subscribe(appState.ui, () => {
      if (appState.ui.isPlaying || !this.pendingRoots) return;
      const pending = this.pendingRoots;
      this.pendingRoots = null;
      this.disposePlayWatch?.();
      this.disposePlayWatch = null;
      this.registerRoots(pending);
    });
  }

  /** Resolves once project scripts are registered (registers the host's current roots if not yet). */
  async ensureReady(): Promise<void> {
    const status = appState.project.scriptsStatus;
    if (status === 'ready' || status === 'error' || !HostService.isInstalled()) return;
    this.registerRoots(this.hostService.host.scripts.current());
  }

  getRegisteredIds(): ReadonlySet<string> {
    return this.registeredIds;
  }

  private clearRegisteredScripts(): void {
    for (const id of this.registeredIds) {
      this.scriptRegistry.unregisterComponent(id);
    }
    this.registeredIds.clear();
  }

  /**
   * Scenes can load before their scripts register; their `user:*` components are parked on the
   * nodes. Attach them now that the types exist — otherwise the next save drops them. Best-effort.
   */
  private attachPendingSceneComponents(): void {
    try {
      const attached = this.sceneManager.resolvePendingComponents();
      if (attached > 0) {
        this.logger.info(
          `Attached ${attached} scene component(s) that were waiting for their script type`
        );
      }
    } catch (error) {
      this.logger.error('Failed to attach pending scene components', error);
    }
  }

  dispose(): void {
    this.disposePlayWatch?.();
    this.disposePlayWatch = null;
    this.pendingRoots = null;
    this.clearRegisteredScripts();
  }
}
