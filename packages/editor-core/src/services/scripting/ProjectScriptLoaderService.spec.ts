import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Script, ScriptRegistry, type PropertySchema } from '@pix3/runtime';

import { appState, resetAppState } from '@/state';
import type { ScriptRoots } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import { FakeHost } from '@/host/testing/fake-host';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

const scriptClass = (name: string): typeof Script => {
  const ctor = class extends Script {
    static getPropertySchema(): PropertySchema {
      return { nodeType: name, properties: [], groups: {} };
    }
  };
  Object.defineProperty(ctor, 'name', { value: name });
  return ctor;
};

const roots = (
  modules: Record<string, Record<string, unknown>>,
  bots: Record<string, Record<string, unknown>> = {}
): ScriptRoots => ({
  editorScripts: { __pix3Revision: 1, modules },
  botPolicies: { __pix3Revision: 1, modules: bots },
});

const makeLoader = () => {
  const loader = new ProjectScriptLoaderService();
  const registry = new ScriptRegistry();
  const sceneManager = { resolvePendingComponents: vi.fn(() => 0) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.defineProperty(loader, 'scriptRegistry', { value: registry });
  Object.defineProperty(loader, 'sceneManager', { value: sceneManager });
  Object.defineProperty(loader, 'logger', { value: logger });
  Object.defineProperty(loader, 'hostService', { value: new HostService() });
  return { loader, registry, sceneManager, logger };
};

describe('ProjectScriptLoaderService.registerRoots', () => {
  beforeEach(() => resetAppState());
  afterEach(() => {
    HostService.reset();
    resetAppState();
  });

  it('registers every Script export as user:<export name> and publishes ready', () => {
    const { loader, registry, sceneManager } = makeLoader();
    const Player = scriptClass('Player');
    const signal = appState.project.scriptRefreshSignal;

    const result = loader.registerRoots(
      roots({
        '/scripts/Player.ts': { Player, helper: () => 1, SPEED: 3 },
        '/src/scripts/ui/Hud.ts': { HudAlias: scriptClass('Hud') },
      })
    );

    expect(result).toEqual({ registered: ['user:Player', 'user:HudAlias'], skipped: [] });
    expect(registry.getComponentType('user:Player')?.componentClass).toBe(Player);
    expect(registry.getComponentType('user:Player')?.description).toBe(
      'Project component from scripts/Player.ts'
    );
    expect(registry.getComponentType('user:HudAlias')).toBeDefined();
    expect(loader.getRegisteredIds()).toEqual(new Set(['user:Player', 'user:HudAlias']));
    expect(sceneManager.resolvePendingComponents).toHaveBeenCalledTimes(1);
    expect(appState.project.scriptsStatus).toBe('ready');
    expect(appState.project.scriptRefreshSignal).toBe(signal + 1);
  });

  it('ignores non-Script classes, even with a getPropertySchema', () => {
    const { loader } = makeLoader();
    class NotAScript {
      static getPropertySchema(): PropertySchema {
        return { nodeType: 'X', properties: [], groups: {} };
      }
    }
    const result = loader.registerRoots(roots({ '/scripts/x.ts': { NotAScript } }));
    expect(result.registered).toEqual([]);
  });

  it('replaces the previous registrations (a removed script unregisters)', () => {
    const { loader, registry } = makeLoader();
    loader.registerRoots(roots({ '/scripts/A.ts': { A: scriptClass('A') } }));
    const B = scriptClass('B');
    loader.registerRoots(roots({ '/scripts/B.ts': { B } }));

    expect(registry.getComponentType('user:A')).toBeUndefined();
    expect(registry.getComponentType('user:B')?.componentClass).toBe(B);
    expect(loader.getRegisteredIds()).toEqual(new Set(['user:B']));
  });

  it('skips a duplicate export name with a warning; a re-export of the same class is fine', () => {
    const { loader, registry, logger } = makeLoader();
    const Enemy = scriptClass('Enemy');
    const result = loader.registerRoots(
      roots({
        '/scripts/a/Enemy.ts': { Enemy },
        '/scripts/index.ts': { Enemy },
        '/scripts/b/Enemy.ts': { Enemy: scriptClass('Enemy') },
      })
    );

    expect(result.registered).toEqual(['user:Enemy']);
    expect(result.skipped).toEqual([
      {
        file: 'scripts/b/Enemy.ts',
        export: 'Enemy',
        reason: 'duplicate export name: user:Enemy is already registered from scripts/a/Enemy.ts',
      },
    ]);
    expect(registry.getComponentType('user:Enemy')?.componentClass).toBe(Enemy);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not register bot policies as components', () => {
    const { loader } = makeLoader();
    const result = loader.registerRoots(
      roots({}, { '/design/tests/bots/greedy.ts': { Greedy: scriptClass('Greedy') } })
    );
    expect(result.registered).toEqual([]);
    expect(appState.project.scriptsStatus).toBe('ready');
  });

  it('defers roots queued during play mode until play stops', () => {
    const { loader, registry } = makeLoader();
    appState.ui.isPlaying = true;
    loader.queueRoots(roots({ '/scripts/A.ts': { A: scriptClass('A') } }));
    expect(registry.getComponentType('user:A')).toBeUndefined();

    loader.queueRoots(roots({ '/scripts/B.ts': { B: scriptClass('B') } }));
    appState.ui.isPlaying = false;
    return Promise.resolve().then(() => {
      expect(registry.getComponentType('user:A')).toBeUndefined();
      expect(registry.getComponentType('user:B')).toBeDefined();
      loader.dispose();
    });
  });
});

describe('ProjectScriptLoaderService.ensureReady', () => {
  beforeEach(() => resetAppState());
  afterEach(() => {
    HostService.reset();
    resetAppState();
  });

  it("registers the host's current roots when nothing was registered yet", async () => {
    const { loader, registry } = makeLoader();
    HostService.install(
      new FakeHost({ roots: roots({ '/scripts/Spin.ts': { Spin: scriptClass('Spin') } }) })
    );

    await loader.ensureReady();

    expect(registry.getComponentType('user:Spin')).toBeDefined();
    expect(appState.project.scriptsStatus).toBe('ready');
  });

  it('is a no-op once scripts are ready', async () => {
    const { loader, sceneManager } = makeLoader();
    appState.project.scriptsStatus = 'ready';
    HostService.install(new FakeHost());
    await loader.ensureReady();
    expect(sceneManager.resolvePendingComponents).not.toHaveBeenCalled();
  });
});
