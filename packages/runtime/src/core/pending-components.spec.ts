import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { SceneManager } from './SceneManager';
import { ScriptRegistry } from './ScriptRegistry';
import { Script } from './ScriptComponent';
import { isStaleComponent, replaceStaleComponents } from './component-hydration';

/**
 * Regression guard for the most expensive defect of the Flow-vs-chat measurement: a scene that
 * opened before its project scripts compiled came back **without** its `user:*` components, and the
 * next save — any agent mutation triggers one — wrote that loss into the `.pix3scene`. Observed in
 * 3 of 4 runs: `GameRules`/`ScoreHud` disappeared from `game-root`/`hud` right after `create_node`.
 */

class GameRules extends Script {
  lives = 3;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { lives: 3 };
  }

  static override getPropertySchema() {
    return {
      nodeType: 'GameRules',
      properties: [
        {
          name: 'lives',
          type: 'number' as const,
          getValue: (c: unknown) => (c as GameRules).lives,
          setValue: (c: unknown, value: unknown) => {
            (c as GameRules).lives = value as number;
          },
        },
      ],
    };
  }
}

const SCENE_YAML = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: game-rules
        type: 'user:GameRules'
        enabled: true
        config:
          lives: 5
`;

function makeStack(): { loader: SceneLoader; saver: SceneSaver; registry: ScriptRegistry } {
  const registry = new ScriptRegistry();
  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    registry,
    new ResourceManager('/')
  );
  return { loader, saver: new SceneSaver(), registry };
}

function registerGameRules(registry: ScriptRegistry): void {
  registry.registerComponent({
    id: 'user:GameRules',
    displayName: 'GameRules',
    description: 'test',
    category: 'Project',
    componentClass: GameRules,
    keywords: [],
  });
}

describe('components whose script type is not registered yet', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('parks the definition on the node instead of dropping it', async () => {
    const { loader } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];

    expect(root.components).toHaveLength(0);
    expect(root.pendingComponents).toEqual([
      { id: 'game-rules', type: 'user:GameRules', enabled: true, config: { lives: 5 } },
    ]);
  });

  it('survives a save/load round-trip with its config intact', async () => {
    const { loader, saver } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    // This is the step that used to destroy the data: any agent mutation saves the scene.
    const savedYaml = saver.serializeScene(graph);

    expect(savedYaml).toContain('user:GameRules');
    expect(savedYaml).toContain('lives: 5');

    const reloaded = await loader.parseScene(savedYaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    expect(reloaded.rootNodes[0].pendingComponents).toHaveLength(1);
  });

  it('attaches the parked component once the type registers, applying its authored config', async () => {
    const { loader, registry } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    registerGameRules(registry);

    const attached = loader.resolvePendingComponents(graph.rootNodes);

    expect(attached).toBe(1);
    const root = graph.rootNodes[0];
    expect(root.pendingComponents).toHaveLength(0);
    expect(root.components).toHaveLength(1);
    expect(root.components[0].id).toBe('game-rules');
    expect((root.components[0] as GameRules).lives).toBe(5);
  });

  it('resolves through SceneManager across every open scene', async () => {
    const { loader, saver, registry } = makeStack();
    const manager = new SceneManager(loader, saver);

    manager.setActiveSceneGraph(
      'scene-a',
      await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/a.pix3scene' })
    );
    manager.setActiveSceneGraph(
      'scene-b',
      await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/b.pix3scene' })
    );

    registerGameRules(registry);

    expect(manager.resolvePendingComponents()).toBe(2);
    // Idempotent: nothing left to attach on a second pass.
    expect(manager.resolvePendingComponents()).toBe(0);
    expect(manager.getSceneGraph('scene-a')?.rootNodes[0].components).toHaveLength(1);
    expect(manager.getSceneGraph('scene-b')?.rootNodes[0].components).toHaveLength(1);
  });

  it('reaches components parked on nested children', async () => {
    const { loader, registry } = makeStack();
    const nested = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    children:
      - id: hud
        type: Group2D
        name: Hud
        components:
          - id: score-hud
            type: 'user:GameRules'
            enabled: true
            config:
              lives: 7
`;

    const graph = await loader.parseScene(nested, { filePath: 'res://scenes/main.pix3scene' });
    registerGameRules(registry);

    expect(loader.resolvePendingComponents(graph.rootNodes)).toBe(1);
    const hud = graph.nodeMap.get('hud');
    expect(hud?.components).toHaveLength(1);
    expect((hud?.components[0] as GameRules).lives).toBe(7);
  });

  /**
   * The walk descends `Object3D.children`, and a node's own VISUALS live there: `Sprite2D` does
   * `this.add(this.mesh)`, so a plain `THREE.Mesh` — which has no `pendingComponents` — is a child
   * of a NodeBase in every real scene. Reading `.length` off it threw
   * `Cannot read properties of undefined (reading 'length')`, and because `add_component` resolves
   * pending components before attaching anything, ONE sprite in the scene broke component attach
   * for the whole project. Measured live: an agent spent 15 of its 60 iterations retrying
   * `add_component` on four different nodes with two different component types, every one of them
   * failing with that message, and the turn died on the iteration cap with the mechanic unbuilt.
   */
  it('walks past a node visual that is not a NodeBase', async () => {
    const { loader, registry } = makeStack();

    const withSprite = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: game-rules
        type: 'user:GameRules'
        enabled: true
        config:
          lives: 4
    children:
      - id: coin
        type: Sprite2D
        name: Coin
`;

    const graph = await loader.parseScene(withSprite, { filePath: 'res://scenes/main.pix3scene' });
    const coin = graph.nodeMap.get('coin');
    // Guard the premise: if node visuals ever stop being three.js children, this test is moot.
    expect(
      coin?.children.some(
        child => (child as { pendingComponents?: unknown }).pendingComponents === undefined
      )
    ).toBe(true);

    registerGameRules(registry);
    expect(() => loader.resolvePendingComponents(graph.rootNodes)).not.toThrow();
    expect(graph.nodeMap.get('game-root')?.components).toHaveLength(1);
  });

  it('keeps a live component and a parked one side by side when saving', async () => {
    const { loader, saver, registry } = makeStack();
    registerGameRules(registry);

    const mixed = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: game-rules
        type: 'user:GameRules'
        enabled: true
        config:
          lives: 5
      - id: score-hud
        type: 'user:ScoreHud'
        enabled: true
        config:
          prefix: 'Score: '
`;

    const graph = await loader.parseScene(mixed, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];
    expect(root.components).toHaveLength(1);
    expect(root.pendingComponents).toHaveLength(1);

    const savedYaml = saver.serializeScene(graph);
    expect(savedYaml).toContain('user:GameRules');
    expect(savedYaml).toContain('user:ScoreHud');
    expect(savedYaml).toContain('prefix: "Score: "');
  });
});

describe('live components of a re-registered script (replaceStaleComponents)', () => {
  const TWO = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: first
        type: 'core:Noop'
      - id: game-rules
        type: 'user:GameRules'
        enabled: false
        config:
          lives: 5
      - id: last
        type: 'core:Noop'
`;
  class Noop extends Script {
    static override getPropertySchema() {
      return { nodeType: 'Noop', properties: [] };
    }
  }

  it('swaps only stale instances, in their slot, with id, enabled and config kept', async () => {
    const { loader, saver, registry } = makeStack();
    registerGameRules(registry);
    registry.registerComponent({
      id: 'core:Noop',
      displayName: 'Noop',
      description: 'test',
      category: 'Core',
      componentClass: Noop,
      keywords: [],
    });
    const graph = await loader.parseScene(TWO, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];
    const [first, old, last] = root.components;
    const before = saver.serializeScene(graph);
    expect(replaceStaleComponents(graph.rootNodes, registry)).toBe(0);

    // The script is edited: Vite re-imports it as a new class with a new field.
    class GameRulesV2 extends GameRules {
      shield = 0;
      constructor(id: string, type: string) {
        super(id, type);
        this.config = { lives: 3, shield: 2 };
      }
    }
    registry.registerComponent({
      id: 'user:GameRules',
      displayName: 'GameRules',
      description: 'test',
      category: 'Project',
      componentClass: GameRulesV2,
      keywords: [],
    });
    const detached = vi.spyOn(old, 'onDetach');
    expect(isStaleComponent(old, registry)).toBe(true);

    expect(replaceStaleComponents(graph.rootNodes, registry, (_n, c) => ({ ...c.config }))).toBe(1);
    expect(root.components[0]).toBe(first);
    expect(root.components[2]).toBe(last);
    const fresh = root.components[1] as GameRulesV2;
    expect(fresh).toBeInstanceOf(GameRulesV2);
    expect(fresh).not.toBe(old);
    expect(fresh.id).toBe('game-rules');
    expect(fresh.enabled).toBe(false);
    expect(fresh.node).toBe(root);
    expect(fresh.lives).toBe(5);
    // Class defaults merge under the kept config, as a load does.
    expect(fresh.config).toEqual({ lives: 5, shield: 2 });
    expect(detached).toHaveBeenCalledTimes(1);
    expect(old.node).toBeNull();
    // The file the saver writes differs only by the new default.
    expect(saver.serializeScene(graph)).toBe(
      before.replace('lives: 5', 'lives: 5\n          shield: 2')
    );
    expect(replaceStaleComponents(graph.rootNodes, registry)).toBe(0);
  });

  it('keeps the old instance when its type is gone', async () => {
    const { loader, registry } = makeStack();
    registerGameRules(registry);
    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    const old = graph.rootNodes[0].components[0];
    registry.unregisterComponent('user:GameRules');
    expect(isStaleComponent(old, registry)).toBe(false);
    expect(replaceStaleComponents(graph.rootNodes, registry)).toBe(0);
    expect(graph.rootNodes[0].components[0]).toBe(old);
  });
});
