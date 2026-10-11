import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import type { RuntimeRenderer } from './RuntimeRenderer';
import { SceneLoader } from './SceneLoader';
import { SceneManager } from './SceneManager';
import { SceneRunner } from './SceneRunner';
import { SceneSaver } from './SceneSaver';
import type { SceneService } from './SceneService';
import { ScriptRegistry } from './ScriptRegistry';
import { Script } from './ScriptComponent';
import { NodeBase } from '../nodes/NodeBase';

/**
 * Spec §6.19.2: a script's `this.scene.getNodesInGroup` / `callGroup` during play — on the running
 * clone, not on the editor's graph, reading the nodes' own `groups` at call time.
 */

/** The script every grouped node carries: it hands out `this.scene` and records `hit` calls. */
class Probe extends Script {
  static last: Probe | null = null;
  readonly hits: unknown[][] = [];

  override onAttach(): void {
    Probe.last = this;
  }

  get sceneApi(): SceneService {
    if (!this.scene) throw new Error('no scene');
    return this.scene;
  }

  hit(...args: unknown[]): void {
    this.hits.push(args);
  }
}

const probe = (id: string, indent = 4) => {
  const pad = ' '.repeat(indent);
  return `\n${pad}components:\n${pad}  - id: ${id}-probe\n${pad}    type: 'user:Probe'\n${pad}    enabled: true`;
};

const SCENE_A = `version: 1.0.0
root:
  - id: a-root
    type: Node3D
    name: Root
    groups: [world]${probe('a-root')}
    children:
      - id: enemy-1
        type: Node3D
        name: Enemy1
        groups: [enemies]${probe('enemy-1', 8)}
        children:
          - id: enemy-1-child
            type: Node3D
            name: Minion
            groups: [enemies, ' small ']
      - id: wall
        type: Node3D
        name: Wall
  - id: enemy-2
    type: Node3D
    name: Enemy2
    groups: [enemies]${probe('enemy-2')}
`;

const SCENE_B = `version: 1.0.0
root:
  - id: b-root
    type: Node3D
    name: RootB
    groups: [world]${probe('b-root')}
    children:
      - id: boss
        type: Node3D
        name: Boss
        groups: [bosses]
`;

class InMemoryResourceManager extends ResourceManager {
  constructor(private readonly files: Record<string, string>) {
    super('/');
  }

  override async readText(resource: string): Promise<string> {
    const text = this.files[resource.replace(/^res:\/\//i, '')];
    if (text === undefined) throw new Error(`no file at ${resource}`);
    return text;
  }
}

function rendererStub(): RuntimeRenderer {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 320, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 160, configurable: true });
  const noop = vi.fn();
  return {
    beginStatsFrame: noop,
    domElement: canvas,
    render: noop,
    setAutoClear: noop,
    clear: noop,
    clearDepth: noop,
    getStatsSnapshot: vi.fn(() => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    })),
  } as unknown as RuntimeRenderer;
}

async function play(): Promise<{
  runner: SceneRunner;
  scene: SceneService;
  manager: SceneManager;
}> {
  vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1 as unknown as number);
  const audio = new AudioService();
  const resources = new InMemoryResourceManager({
    'scenes/a.pix3scene': SCENE_A,
    'scenes/b.pix3scene': SCENE_B,
  });
  const assets = new AssetLoader(resources, audio);
  const registry = new ScriptRegistry();
  registry.registerComponent({
    id: 'user:Probe',
    displayName: 'Probe',
    description: '',
    category: 'test',
    componentClass: Probe,
    keywords: [],
  });
  const manager = new SceneManager(new SceneLoader(assets, registry, resources), new SceneSaver());
  const runner = new SceneRunner(manager, rendererStub(), audio, assets);
  manager.setActiveSceneGraph(
    'scenes/a.pix3scene',
    await manager.parseScene(SCENE_A, { filePath: 'scenes/a.pix3scene' })
  );
  await runner.startScene('scenes/a.pix3scene');
  const scene = Probe.last?.sceneApi;
  if (!scene) throw new Error('the probe never attached');
  return { runner, scene, manager };
}

const ids = (nodes: readonly NodeBase[]) => nodes.map(node => node.nodeId);

describe('SceneService groups (scripts during play)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Probe.last = null;
  });

  it('sees the membership the scene file declares, in tree order, on the running clone', async () => {
    const { runner, scene, manager } = await play();

    const enemies = scene.getNodesInGroup('enemies');
    expect(ids(enemies)).toEqual(['enemy-1', 'enemy-1-child', 'enemy-2']);
    // The clone the scripts run on, not the editor's graph.
    const authored = manager.getActiveSceneGraph()?.nodeMap.get('enemy-1');
    expect(enemies[0]).not.toBe(authored);
    expect(enemies[0]).toBe(scene.findNodeById('enemy-1'));
    // Names are trimmed, as in `isInGroup`; an unknown or blank group is empty.
    expect(ids(scene.getNodesInGroup(' small'))).toEqual(['enemy-1-child']);
    expect(scene.getNodesInGroup('nobody')).toEqual([]);
    expect(scene.getNodesInGroup('  ')).toEqual([]);
    runner.stop();
  });

  it('follows addToGroup / removeFromGroup, spawned and freed nodes at once', async () => {
    const { runner, scene } = await play();
    const wall = scene.findNode('Wall');
    const enemy2 = scene.findNode('Enemy2');
    if (!wall || !enemy2) throw new Error('fixture');

    wall.addToGroup('enemies');
    enemy2.removeFromGroup('enemies');
    expect(ids(scene.getNodesInGroup('enemies'))).toEqual(['enemy-1', 'enemy-1-child', 'wall']);

    const spawned = new NodeBase({ id: 'spawned', name: 'Spawned', groups: ['enemies'] });
    wall.adoptChild(spawned);
    expect(ids(scene.getNodesInGroup('enemies'))).toContain('spawned');

    scene.findNode('Enemy1')?.removeFromParent();
    expect(ids(scene.getNodesInGroup('enemies'))).toEqual(['wall', 'spawned']);
    runner.stop();
  });

  it('after changeScene, answers for the new scene only', async () => {
    const { runner, scene } = await play();
    expect(ids(scene.getNodesInGroup('world'))).toEqual(['a-root']);

    await scene.changeScene('res://scenes/b.pix3scene', { transition: 'none' });

    expect(ids(scene.getNodesInGroup('world'))).toEqual(['b-root']);
    expect(ids(scene.getNodesInGroup('bosses'))).toEqual(['boss']);
    expect(scene.getNodesInGroup('enemies')).toEqual([]);
    runner.stop();
  });

  it('callGroup calls the method on every component that has it, and warns once when none does', async () => {
    const { runner, scene } = await play();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probeOf = (name: string) => scene.findNode(name)?.getComponent(Probe) ?? null;

    // enemy-1 and enemy-2 carry a Probe; the Minion has no component and is skipped.
    expect(scene.callGroup('enemies', 'hit', 3, 'x')).toBe(2);
    expect(probeOf('Enemy1')?.hits).toEqual([[3, 'x']]);
    expect(probeOf('Enemy2')?.hits).toEqual([[3, 'x']]);
    expect(probeOf('Root')?.hits).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    // A method no component has: nothing is called, nothing throws, one warning.
    expect(scene.callGroup('enemies', 'explode')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('callGroup("enemies", "explode")');

    // An empty group is not a mistake worth a warning (Godot's call_group on no nodes).
    expect(scene.callGroup('nobody', 'hit')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('is empty outside a running game', async () => {
    const { runner, scene } = await play();
    runner.stop();
    expect(scene.getNodesInGroup('enemies')).toEqual([]);
    expect(scene.callGroup('enemies', 'hit')).toBe(0);
  });
});
