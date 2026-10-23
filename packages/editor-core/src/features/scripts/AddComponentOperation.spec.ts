import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import type { PropertySchema } from '@/fw';
import {
  NodeBase,
  replaceStaleComponents,
  SceneManager,
  Script,
  ScriptRegistry,
  type ScriptComponentClass,
} from '@pix3/runtime';
import { createInitialAppState } from '@/state/AppState';

import { AddComponentOperation } from './AddComponentOperation';
import { RemoveComponentOperation } from './RemoveComponentOperation';

/**
 * Undo of Add Component and redo of Remove Component after a live swap (`.plans/done/scripts-vite.md`
 * S7): a re-registered script replaced the instance the history entry captured; the entry must
 * find the component by id, or the undo/redo is a no-op on screen.
 */

const scriptClass = (name: string): ScriptComponentClass => {
  const ctor = class extends Script {
    static getPropertySchema(): PropertySchema {
      return { nodeType: name, properties: [] };
    }
  };
  Object.defineProperty(ctor, 'name', { value: name });
  return ctor;
};

const createHarness = () => {
  const state = createInitialAppState();
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://scene.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    lastModifiedTime: null,
  };
  const node = new NodeBase({ id: 'node-1', type: 'Node3D', name: 'Node 1' });
  const registry = new ScriptRegistry();
  const register = (ctor: ScriptComponentClass): void =>
    registry.registerComponent({
      id: 'user:Mover',
      displayName: 'Mover',
      description: 'Mover',
      category: 'Project',
      componentClass: ctor,
      keywords: [],
    });
  register(scriptClass('MoverV1'));
  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  };
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) return { getActiveSceneGraph: () => sceneGraph } as T;
      if (token === ScriptRegistry) return registry as T;
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };
  const context = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;
  /** The script changed on disk and re-registered: live components follow (S7). */
  const swap = (): number => {
    register(scriptClass('MoverV2'));
    return replaceStaleComponents(sceneGraph.rootNodes, registry);
  };
  return { context, node, registry, swap };
};

describe('AddComponentOperation', () => {
  it('undo removes the component by id after a live swap replaced the instance', async () => {
    const h = createHarness();
    const result = await new AddComponentOperation({
      nodeId: 'node-1',
      componentType: 'user:Mover',
      componentId: 'mover',
    }).perform(h.context);
    expect(result.didMutate).toBe(true);
    const added = h.node.components[0];
    expect(added.id).toBe('mover');

    expect(h.swap()).toBe(1);
    expect(h.node.components[0]).not.toBe(added);
    expect(h.node.components[0].id).toBe('mover');

    await result.commit!.undo();
    expect(h.node.components).toEqual([]);

    await result.commit!.redo();
    expect(h.node.components.map(c => c.id)).toEqual(['mover']);
  });
});

describe('RemoveComponentOperation', () => {
  it('redo removes the component by id after undo brought the old instance back and a swap replaced it', async () => {
    const h = createHarness();
    const component = h.registry.createComponent('user:Mover', 'mover')!;
    component.config = { speed: 3 };
    h.node.addComponent(component);

    const result = await new RemoveComponentOperation({
      nodeId: 'node-1',
      componentId: 'mover',
    }).perform(h.context);
    expect(result.didMutate).toBe(true);
    expect(h.node.components).toEqual([]);

    await result.commit!.undo();
    expect(h.node.components[0]).toBe(component);
    expect(h.node.components[0].config).toEqual({ speed: 3 });

    // The history watch of LiveComponentService replaces an instance an undo brings back.
    expect(h.swap()).toBe(1);
    expect(h.node.components[0]).not.toBe(component);

    await result.commit!.redo();
    expect(h.node.components).toEqual([]);
  });
});
