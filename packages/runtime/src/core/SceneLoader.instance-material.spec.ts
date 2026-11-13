import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, MeshLambertMaterial, type Mesh } from 'three';
import { createHeadlessGame } from '../testing/headless-game';
import type { GeometryMesh } from '../nodes/3D/GeometryMesh';

// A prefab clone is rebuilt from schema values, which spell a mesh's `material:` block as flat
// inspector keys (`materialType`, `color`) the loader never read: every GeometryMesh of an
// instance came out in the default blue PBR material (Skyways' island prefabs).
const prefab = `version: 1.0.0
root:
  - id: island
    type: Node3D
    name: Island
    children:
      - id: grass
        type: GeometryMesh
        name: grass
        properties:
          geometry: cylinder
          size: [2, 0.1, 1]
          castShadow: false
          material: { type: lambert, color: "#a9d088" }
      - id: lava
        type: GeometryMesh
        name: lava
        properties:
          geometry: sphere
          material: { type: basic, color: "#ff8b3d" }
          visible: false
`;

const main = `version: 1.0.0
root:
  - id: world
    type: Node3D
    name: World
    children:
      - id: island-0
        instance: res://scenes/prefabs/island.pix3scene
      - id: island-1
        instance: res://scenes/prefabs/island.pix3scene
        overrides:
          byLocalId:
            lava: { properties: { visible: true } }
`;

const materialOf = (mesh: GeometryMesh) =>
  (mesh.children.find(child => (child as unknown as Mesh).isMesh) as unknown as Mesh).material;

describe('SceneLoader: a GeometryMesh inside a prefab instance keeps its material', () => {
  it('keeps the family, the colour, the shape and the shadow flags in every instance', async () => {
    const game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': main, 'scenes/prefabs/island.pix3scene': prefab },
    });
    await game.start('scenes/main.pix3scene');

    for (const id of ['island-0', 'island-1']) {
      const island = game.scene.findNode(id)!;
      const grass = island.findByName('grass') as GeometryMesh;
      const lava = island.findByName('lava') as GeometryMesh;
      expect(grass.serializeConfig()).toMatchObject({
        geometry: 'cylinder',
        size: [2, 0.1, 1],
        castShadow: false,
        material: { type: 'lambert', color: '#a9d088' },
      });
      expect(materialOf(grass)).toBeInstanceOf(MeshLambertMaterial);
      expect(materialOf(lava)).toBeInstanceOf(MeshBasicMaterial);
      expect(lava.serializeConfig().material).toMatchObject({ type: 'basic', color: '#ff8b3d' });
      expect(lava.visible).toBe(id === 'island-1');
    }
    expect(game.errors).toEqual([]);
    game.dispose();
  });
});
