import { AmbientLight, DirectionalLight } from 'three';
import {
  AmbientLightNode,
  DirectionalLightNode,
  HemisphereLightNode,
  PointLightNode,
  SpotLightNode,
  type NodeBase,
} from '@pix3/runtime';

/**
 * The editor's "System Lighting": the fallback rig that lights a scene with no
 * light nodes of its own, so meshes don't render as black silhouettes. Shared by
 * the viewport and the scene/prefab thumbnail generator so both show the same
 * picture. The running game has no such lights.
 */
export interface EditorFallbackLights {
  ambient: AmbientLight;
  directional: DirectionalLight;
}

export function createEditorFallbackLights(): EditorFallbackLights {
  const ambient = new AmbientLight(0xffffff, 0.6);
  const directional = new DirectionalLight(0xffffff, 0.8);
  directional.position.set(5, 10, 7);
  return { ambient, directional };
}

export function isExplicitLightNode(node: NodeBase): boolean {
  return (
    node instanceof DirectionalLightNode ||
    node instanceof PointLightNode ||
    node instanceof SpotLightNode ||
    node instanceof AmbientLightNode ||
    node instanceof HemisphereLightNode
  );
}

/** Whether any node in the subtrees of `nodes` is a scene-authored light. */
export function containsExplicitLights(nodes: readonly NodeBase[]): boolean {
  return nodes.some(
    node => isExplicitLightNode(node) || containsExplicitLights(node.children as NodeBase[])
  );
}
