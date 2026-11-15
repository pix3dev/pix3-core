import { describe, expect, it, vi } from 'vitest';

import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { ResourceManager } from './ResourceManager';
import { SceneService } from './SceneService';
import { NodeBase } from '../nodes/NodeBase';

/**
 * `scene.findNode(id)` remembers what an id query found (a HUD asks for the same nodes every
 * tick and each walk of the tree cost it), but answers exactly as a fresh walk would: a node
 * that was freed, detached or belongs to a previous scene is looked up again.
 */
function setup() {
  const roots: NodeBase[] = [];
  const walk = vi.fn((id: string): NodeBase | null => {
    for (const root of roots) {
      const found = root.findById(id);
      if (found) return found;
    }
    return null;
  });
  const service = new SceneService();
  service.setDelegate({
    getActiveCameraNode: () => null,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 0, height: 0 }),
    setActiveCameraNode: () => undefined,
    findNodeById: walk,
    getRootNodes: () => roots,
    getAudioService: () => new AudioService(),
    getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
    getResourceManager: () => new ResourceManager('/'),
    getECSService: () => null,
    getGameTime: () => new GameTime(),
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.resolve(),
  });
  const root = new NodeBase({ id: 'root', name: 'Root' });
  const panel = new NodeBase({ id: 'panel', name: 'Panel' });
  const label = new NodeBase({ id: 'coins-label', name: 'Coins' });
  root.adoptChild(panel);
  panel.adoptChild(label);
  roots.push(root);
  return { service, walk, roots, root, panel, label };
}

describe('SceneService.findNode by id', () => {
  it('walks the tree once for repeated queries of one id', () => {
    const { service, walk, label } = setup();
    expect(service.findNode('coins-label')).toBe(label);
    expect(service.findNode('coins-label')).toBe(label);
    expect(service.findNode('coins-label')).toBe(label);
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('a detached node is not returned again; a node moved elsewhere in the scene still is', () => {
    const { service, root, panel, label } = setup();
    expect(service.findNode('coins-label')).toBe(label);
    const other = new NodeBase({ id: 'other', name: 'Other' });
    root.adoptChild(other);
    other.adoptChild(label);
    expect(service.findNode('coins-label')).toBe(label);
    label.removeFromParent();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(service.findNode('coins-label')).toBeNull();
    // A new node with the same id (a rebuilt badge) is found, not the stale one.
    const rebuilt = new NodeBase({ id: 'coins-label', name: 'Coins' });
    panel.adoptChild(rebuilt);
    expect(service.findNode('coins-label')).toBe(rebuilt);
    warn.mockRestore();
  });

  it('forgets the nodes of a previous scene', () => {
    const { service, roots, label } = setup();
    expect(service.findNode('coins-label')).toBe(label);
    // The scene changes: new roots, a node with the same id in them.
    const next = new NodeBase({ id: 'root', name: 'Root' });
    const nextLabel = new NodeBase({ id: 'coins-label', name: 'Coins' });
    next.adoptChild(nextLabel);
    roots.splice(0, roots.length, next);
    expect(service.findNode('coins-label')).toBe(nextLabel);
  });

  it('name queries are answered fresh each time (not remembered)', () => {
    const { service, root, label } = setup();
    expect(service.findNode('Coins')).toBe(label);
    label.name = 'Gems';
    const other = new NodeBase({ id: 'coins-2', name: 'Coins' });
    root.adoptChild(other);
    expect(service.findNode('Coins')).toBe(other);
  });
});
