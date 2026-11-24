import { describe, expect, it } from 'vitest';
import {
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  Texture,
  type Material,
  type Mesh,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { ProgramKeeper } from './program-keeper';
import { Sprite2D } from '../nodes/2D/Sprite2D';

/**
 * three.js's program bookkeeping, reduced to what decides a link: a program per cache key, shared
 * by every material that uses it, linked when the first one needs it and deleted when the last one
 * is disposed (`WebGLPrograms.acquireProgram` / `releaseProgram`, `onMaterialDispose`). The key is
 * the parts of three's that a shader effect changes: the program cache key and the defines.
 */
class FakeRenderer {
  links = 0;
  readonly users = new Map<string, number>();
  private readonly programOf = new Map<Material, Set<string>>();
  private readonly current = new Map<Material, string>();

  readonly properties = {
    get: (material: Material): { currentProgram?: { cacheKey: string } } => {
      const key = this.current.get(material);
      return key ? { currentProgram: { cacheKey: key } } : {};
    },
  };

  compile(object: Object3D): void {
    object.traverse(child => this.use((child as Mesh).material as Material));
  }

  /** A draw of a mesh with `material` (what `WebGLRenderer.render` does per object). */
  use(material: Material): void {
    const key = `${material.customProgramCacheKey()}|${Object.keys(material.defines ?? {})
      .sort()
      .join(',')}`;
    let own = this.programOf.get(material);
    if (!own) {
      own = new Set();
      this.programOf.set(material, own);
      material.addEventListener('dispose', () => this.release(material));
    }
    if (!own.has(key)) {
      own.add(key);
      const count = this.users.get(key) ?? 0;
      if (count === 0) this.links += 1;
      this.users.set(key, count + 1);
    }
    this.current.set(material, key);
  }

  private release(material: Material): void {
    for (const key of this.programOf.get(material) ?? []) {
      const count = (this.users.get(key) ?? 1) - 1;
      if (count === 0) this.users.delete(key);
      else this.users.set(key, count);
    }
    this.programOf.delete(material);
    this.current.delete(material);
  }
}

const meshOf = (sprite: Sprite2D): Mesh =>
  sprite.children.find(child => (child as unknown as Mesh).isMesh) as unknown as Mesh;

/** A network of flashed sprites, drawn and freed — PipeBlast's burning link. */
function burnNetwork(gl: FakeRenderer, keeper: ProgramKeeper | null, size: number): void {
  const camera = new OrthographicCamera();
  const scene = new Scene();
  const sprites = Array.from({ length: size }, (_, i) => new Sprite2D({ id: `block-${i}` }));
  for (const sprite of sprites) {
    sprite.getShaderEffectStack().attach('core:flash', { transient: true });
    keeper?.hold(meshOf(sprite), camera, scene);
    gl.use(meshOf(sprite).material as Material);
  }
  for (const sprite of sprites) (meshOf(sprite).material as Material).dispose(); // queueFree
}

describe('ProgramKeeper', () => {
  it('a variant only freed nodes used is linked again for each network — unless it is held', () => {
    const bare = new FakeRenderer();
    for (let hit = 0; hit < 5; hit++) burnNetwork(bare, null, 10);
    expect(bare.links).toBe(5); // a network shares one program, but loses it when freed

    const gl = new FakeRenderer();
    const keeper = new ProgramKeeper(gl as unknown as WebGLRenderer);
    for (let hit = 0; hit < 5; hit++) burnNetwork(gl, keeper, 10);
    expect(gl.links).toBe(1);
    expect(keeper.size).toBe(1);
  });

  it('holds a stand-in with the source’s defines and program key, pinning neither its texture nor its node', () => {
    const gl = new FakeRenderer();
    const keeper = new ProgramKeeper(gl as unknown as WebGLRenderer);
    const sprite = new Sprite2D({ id: 'block' });
    const material = meshOf(sprite).material as MeshBasicMaterial;
    material.map = new Texture();
    sprite.getShaderEffectStack().attach('core:flash', { transient: true });

    keeper.hold(meshOf(sprite), new OrthographicCamera(), new Scene());
    const [key] = gl.users.keys();
    expect(key).toContain('core:flash');
    expect(key).toContain('PIX3_FX_FLASH');

    const held = (keeper as unknown as { held: Map<string, MeshBasicMaterial> }).held;
    const standIn = [...held.values()][0];
    expect(standIn).not.toBe(material);
    expect(standIn.map).toBeNull();
    expect(standIn.onBeforeCompile).not.toBe(material.onBeforeCompile);
    expect(standIn.customProgramCacheKey()).toBe(material.customProgramCacheKey());

    material.dispose();
    expect(gl.users.get(key)).toBe(1); // the stand-in still uses it

    keeper.dispose();
    expect(gl.users.size).toBe(0);
  });

  it('looks at a material once per variant: a second material of a held variant drops its stand-in', () => {
    const gl = new FakeRenderer();
    const keeper = new ProgramKeeper(gl as unknown as WebGLRenderer);
    const camera = new OrthographicCamera();
    const scene = new Scene();
    const a = new Sprite2D({ id: 'a' });
    const b = new Sprite2D({ id: 'b' });
    for (const sprite of [a, b]) {
      sprite.getShaderEffectStack().attach('core:flash', { transient: true });
      keeper.hold(meshOf(sprite), camera, scene);
      keeper.hold(meshOf(sprite), camera, scene);
    }
    expect(keeper.size).toBe(1);
    expect([...gl.users.values()]).toEqual([1]);

    // The same material in another variant (an authored flash switched off) is looked at again.
    a.getShaderEffectStack().setEnabled('core:flash', false);
    keeper.hold(meshOf(a), camera, scene);
    expect(keeper.size).toBe(2);
  });
});
