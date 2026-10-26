import { describe, expect, it } from 'vitest';
import { Group2D } from './Group2D';
import { ColorRect2D } from './ColorRect2D';
import { SceneLoader } from '../../core/SceneLoader';
import { SceneSaver } from '../../core/SceneSaver';
import { AssetLoader } from '../../core/AssetLoader';
import { AudioService } from '../../core/AudioService';
import { ResourceManager } from '../../core/ResourceManager';
import { ScriptRegistry } from '../../core/ScriptRegistry';
import type { MeshBasicMaterial } from 'three';

const materialOf = (node: ColorRect2D): MeshBasicMaterial =>
  (node as unknown as { material: MeshBasicMaterial }).material;

describe('Group2D.clipChildren', () => {
  it('puts the group rect as clipping planes on every child material, spawned ones included', () => {
    const board = new Group2D({ id: 'board', width: 200, height: 100, clipChildren: true });
    board.position.set(50, 0, 0);
    const gem = new ColorRect2D({ id: 'gem', width: 10, height: 10 });
    board.adoptChild(gem);
    board.updateMatrixWorld(true);
    board.tick(0);

    const planes = materialOf(gem).clippingPlanes;
    expect(planes).toHaveLength(4);
    // x ∈ [-50, 150], y ∈ [-50, 50]
    expect(planes!.map(plane => plane.constant)).toEqual([50, 150, 50, 50]);

    const spawned = new ColorRect2D({ id: 'spawned', width: 10, height: 10 });
    board.adoptChild(spawned);
    board.tick(0);
    expect(materialOf(spawned).clippingPlanes).toBe(planes);

    board.disownChild(gem);
    board.tick(0);
    expect(materialOf(gem).clippingPlanes).toBeNull();

    board.clipChildren = false;
    expect(materialOf(spawned).clippingPlanes).toBeNull();
  });

  it('round-trips through the scene file', async () => {
    const resources = new ResourceManager('/');
    const loader = new SceneLoader(
      new AssetLoader(resources, new AudioService()),
      new ScriptRegistry(),
      resources
    );
    const graph = await loader.parseScene(`version: 1.0.0
root:
  - id: board
    type: Group2D
    name: Board
    properties:
      width: 200
      height: 100
      clipChildren: true
`);
    const board = graph.rootNodes[0] as Group2D;
    expect(board.clipChildren).toBe(true);
    const yaml = new SceneSaver().serializeScene(graph);
    expect(yaml).toContain('clipChildren: true');
  });
});
