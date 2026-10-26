import { describe, expect, it, vi } from 'vitest';
import { Texture, type Mesh, type MeshBasicMaterial } from 'three';

import { Sprite2D } from './Sprite2D';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';
import { NodeBase } from '../NodeBase';
import type { SceneService } from '../../core/SceneService';

/** The rendered surface: size lives on mesh.scale, the pivot on mesh.position. */
const meshOf = (sprite: Sprite2D): Mesh => (sprite as unknown as { mesh: Mesh }).mesh;
const materialOf = (sprite: Sprite2D): MeshBasicMaterial =>
  (sprite as unknown as { material: MeshBasicMaterial }).material;

describe('Sprite2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields as reactive accessors', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    const reactive = reactiveSchemaPropertyNames(sprite);
    // updateSize/applyAnchorOffset are private — before the install these writes had no
    // working script spelling at all.
    for (const name of ['width', 'height', 'anchor', 'texture', 'textureKey']) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
  });

  it('width/height assignment rescales the mesh (not just the field)', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 100, height: 50 });
    expect(meshOf(sprite).scale.x).toBe(100);

    sprite.width = 200;
    expect(meshOf(sprite).scale.x).toBe(200);
    expect(meshOf(sprite).scale.y).toBe(50);

    sprite.height = 80;
    expect(meshOf(sprite).scale.y).toBe(80);
  });

  it('width assignment on an unsized sprite uses the placeholder height, like the Inspector', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    sprite.width = 200;
    expect(meshOf(sprite).scale.x).toBe(200);
    expect(meshOf(sprite).scale.y).toBe(64);
  });

  it('anchor assignment moves the mesh pivot offset', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 100, height: 100 });
    expect(meshOf(sprite).position.x).toBe(0); // default centre anchor

    sprite.anchor = { x: 0, y: 0 };
    expect(meshOf(sprite).position.x).toBe(50);
    expect(meshOf(sprite).position.y).toBe(50);
  });

  it('leaves the material untouched by unrelated writes (sanity)', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 10, height: 10, color: '#ff0000' });
    sprite.width = 20;
    expect(materialOf(sprite).color.getHex()).toBe(0xff0000);
  });
});

describe('Sprite2D built by a script loads its own texture', () => {
  const sceneWith = (loadTexture: (path: string) => Promise<Texture>) =>
    ({ getAssetLoader: () => ({ loadTexture }) }) as unknown as SceneService;

  it('adoptChild into a running scene loads texturePath (was a white quad)', async () => {
    const texture = new Texture();
    const loadTexture = vi.fn(async () => texture);
    const parent = new NodeBase({ id: 'p' });
    parent.scene = sceneWith(loadTexture);

    const sprite = new Sprite2D({ id: 's', texturePath: 'res://gem.png', width: 10, height: 10 });
    parent.adoptChild(sprite);
    await vi.waitFor(() => expect(materialOf(sprite).map).toBe(texture));
    expect(loadTexture).toHaveBeenCalledTimes(1);
    expect(loadTexture).toHaveBeenCalledWith('res://gem.png');
  });

  it('a texture swap in a running scene loads the new path; re-attach does not reload', async () => {
    const loadTexture = vi.fn(async () => new Texture());
    const parent = new NodeBase({ id: 'p' });
    parent.scene = sceneWith(loadTexture);
    const sprite = new Sprite2D({ id: 's', texturePath: 'res://a.png' });
    parent.adoptChild(sprite);
    await vi.waitFor(() => expect(loadTexture).toHaveBeenCalledTimes(1));

    parent.scene = sceneWith(loadTexture);
    expect(loadTexture).toHaveBeenCalledTimes(1);

    sprite.texturePath = 'res://b.png';
    await vi.waitFor(() => expect(loadTexture).toHaveBeenLastCalledWith('res://b.png'));
  });

  it('without a scene nothing loads (the editor and the SceneLoader load it themselves)', () => {
    const sprite = new Sprite2D({ id: 's', texturePath: 'res://a.png' });
    sprite.texturePath = 'res://b.png';
    expect(materialOf(sprite).map).toBeNull();
  });
});

describe('Sprite2D draws nothing while its first texture loads', () => {
  it('hidden until the texture arrives; a failed load shows the flat quad', async () => {
    let resolveLoad!: (texture: Texture) => void;
    const pending = new Promise<Texture>(resolve => {
      resolveLoad = resolve;
    });
    const parent = new NodeBase({ id: 'p' });
    parent.scene = {
      getAssetLoader: () => ({ loadTexture: () => pending }),
    } as unknown as SceneService;
    const sprite = new Sprite2D({ id: 's', texturePath: 'res://gem.png', width: 10, height: 10 });
    parent.adoptChild(sprite);
    expect(meshOf(sprite).visible).toBe(false);
    resolveLoad(new Texture());
    await vi.waitFor(() => expect(meshOf(sprite).visible).toBe(true));

    const failing = new Sprite2D({ id: 'f', texturePath: 'res://missing.png' });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await failing.loadTexture({
      loadTexture: () => Promise.reject(new Error('404')),
    } as unknown as import('../../core/AssetLoader').AssetLoader);
    quiet.mockRestore();
    expect(meshOf(failing).visible).toBe(true);
  });
});
