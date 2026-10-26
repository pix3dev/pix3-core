import { Plane, Vector3, type Material, type Object3D } from 'three';

/**
 * Clips 2D subtrees to an axis-aligned rect: four world-space clipping planes put on every material
 * under the subtrees (the 2D batcher keys its runs on them, so batched quads clip too). Used by
 * `ScrollContainer2D` for its viewport and by `Group2D.clipChildren`. Re-run {@link apply} each
 * frame: it follows the owner's world position and scale, picks up nodes spawned since the last
 * call and releases the materials of nodes that left. Rotation is ignored (the rect stays
 * axis-aligned), and a nested clipper overwrites an outer one on the nodes they share — the
 * innermost rect wins rather than the intersection.
 */
export class ChildClip2D {
  private readonly planes = [
    new Plane(new Vector3(1, 0, 0), 0),
    new Plane(new Vector3(-1, 0, 0), 0),
    new Plane(new Vector3(0, 1, 0), 0),
    new Plane(new Vector3(0, -1, 0), 0),
  ];
  private readonly applied = new Set<Material>();
  private readonly worldPos = new Vector3();
  private readonly worldScale = new Vector3();

  /** Clip `subtrees` to the `width`×`height` rect centred on `owner`. */
  apply(owner: Object3D, width: number, height: number, subtrees: Iterable<Object3D>): void {
    owner.getWorldPosition(this.worldPos);
    owner.getWorldScale(this.worldScale);
    const halfWidth = (width * Math.abs(this.worldScale.x)) / 2;
    const halfHeight = (height * Math.abs(this.worldScale.y)) / 2;
    this.planes[0].constant = -(this.worldPos.x - halfWidth);
    this.planes[1].constant = this.worldPos.x + halfWidth;
    this.planes[2].constant = -(this.worldPos.y - halfHeight);
    this.planes[3].constant = this.worldPos.y + halfHeight;

    const next = new Set<Material>();
    for (const subtree of subtrees) {
      subtree.traverse(object => {
        const material = (object as Object3D & { material?: Material | Material[] }).material;
        if (!material) return;
        for (const entry of Array.isArray(material) ? material : [material]) {
          if (entry.clippingPlanes !== this.planes) {
            entry.clippingPlanes = this.planes;
            entry.clipIntersection = false;
            entry.needsUpdate = true;
          }
          next.add(entry);
        }
      });
    }
    for (const material of this.applied) {
      if (!next.has(material)) this.release(material);
    }
    this.applied.clear();
    for (const material of next) this.applied.add(material);
  }

  /** Remove the planes from every material this clipper set them on. */
  clear(): void {
    for (const material of this.applied) this.release(material);
    this.applied.clear();
  }

  private release(material: Material): void {
    // Another clipper may have claimed it since (a node moved into a nested clip group).
    if (material.clippingPlanes === this.planes) {
      material.clippingPlanes = null;
      material.needsUpdate = true;
    }
  }
}
