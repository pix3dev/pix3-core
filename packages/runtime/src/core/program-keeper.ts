import { Mesh, type Camera, type Material, type Scene, type WebGLRenderer } from 'three';

/** What three keeps per material (`renderer.properties`): the program it draws with now. */
interface MaterialRenderProperties {
  currentProgram?: { cacheKey?: string };
}

/**
 * Keeps one WebGL program per shader variant alive for the renderer's lifetime.
 *
 * three.js counts the materials that use a program and deletes it the moment the last one is
 * disposed. A variant only short-lived nodes use — a sprite `juice.hitFlash` turned into the
 * `core:flash` variant, freed a moment later — was therefore compiled again on every hit: in
 * PipeBlast 15 links of one variant in one round, ~200 ms of render each on SwiftShader. The
 * keeper compiles a stand-in material (a clone with the same defines, shader composer and program
 * cache key) once per variant and never disposes it, so the program outlives every node that uses
 * it; later nodes of the same variant find it in three's program cache and link nothing.
 *
 * Variants are told apart by three's own program cache key (read back after the compile), so a
 * second material of a held variant costs a cache lookup and the stand-in is dropped. Each source
 * variant of a material is looked at once. The stand-in keeps no texture and no closure of its node. A variant
 * whose key depends on render-time state the compile does not reproduce (a material with clipping
 * planes, compiled outside its pass) may be held under another key: its own program is then not
 * held — no worse than without the keeper.
 */
export class ProgramKeeper {
  private readonly held = new Map<string, Material>();
  /** Per source material, the variants (cache key + defines) already looked at. */
  private readonly seen = new WeakMap<Material, Set<string>>();

  constructor(private readonly renderer: WebGLRenderer) {}

  /** Variants held (one program each, or two for a transparent double-sided material). */
  get size(): number {
    return this.held.size;
  }

  /**
   * Compile `mesh`'s material against `scene` (lights, fog) now, unless this variant of it was
   * looked at before, and hold its program. The first material of a variant pays the compile here (a deliberate
   * prewarm: its node draws with the same program this frame); later ones cost a key lookup.
   */
  hold(mesh: Mesh, camera: Camera, scene: Scene): void {
    // A headless run (`pix3 smoke` in Node) draws nothing: its renderer compiles no program to hold.
    if (typeof (this.renderer as { compile?: unknown }).compile !== 'function') return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const variant = `${material.customProgramCacheKey()}|${Object.keys(material.defines ?? {})
        .sort()
        .join(',')}`;
      let variants = this.seen.get(material);
      if (!variants) this.seen.set(material, (variants = new Set()));
      if (variants.has(variant)) continue;
      variants.add(variant);
      this.holdOne(mesh, material, camera, scene);
    }
  }

  /** Release every held program (the renderer is going away). */
  dispose(): void {
    for (const material of this.held.values()) material.dispose();
    this.held.clear();
  }

  private holdOne(mesh: Mesh, material: Material, camera: Camera, scene: Scene): void {
    const cacheKey = material.customProgramCacheKey();
    const standIn = material.clone();
    // `Material.copy` copies neither of these; both decide the program.
    if (material.defines) standIn.defines = { ...material.defines };
    standIn.onBeforeCompile = material.onBeforeCompile;
    standIn.customProgramCacheKey = () => cacheKey;
    standIn.visible = true;
    const probe = new Mesh(mesh.geometry, standIn);
    probe.receiveShadow = mesh.receiveShadow;
    this.renderer.compile(probe, camera, scene);

    const properties = this.renderer.properties.get(standIn) as MaterialRenderProperties;
    const programKey = properties.currentProgram?.cacheKey;
    if (!programKey || this.held.has(programKey)) {
      standIn.dispose(); // the variant is held already: the program stays
      return;
    }
    // Never drawn again: drop what would pin the node (its composer closure, its texture).
    standIn.onBeforeCompile = () => {};
    (standIn as { map?: unknown }).map = null;
    this.held.set(programKey, standIn);
  }
}
