import { describe, expect, it } from 'vitest';
import { AmbientLight, DirectionalLight } from 'three';
import { DirectionalLightNode, Group2D, Node3D } from '@pix3/runtime';
import { containsExplicitLights, createEditorFallbackLights } from './editor-fallback-lighting';

describe('editor fallback lighting', () => {
  it('builds the System Lighting rig', () => {
    const { ambient, directional } = createEditorFallbackLights();
    expect(ambient).toBeInstanceOf(AmbientLight);
    expect(ambient.intensity).toBe(0.6);
    expect(directional).toBeInstanceOf(DirectionalLight);
    expect(directional.intensity).toBe(0.8);
    expect(directional.position.toArray()).toEqual([5, 10, 7]);
  });

  it('detects explicit lights in nested scene nodes', () => {
    const root = new Group2D({ id: 'root-group', name: 'Root Group' });
    root.adoptChild(new DirectionalLightNode({ id: 'nested-light', name: 'Nested Light' }));
    expect(containsExplicitLights([root])).toBe(true);
  });

  it('reports no lights for a light-free tree', () => {
    const root = new Node3D({ id: 'island', name: 'Island' });
    root.adoptChild(new Node3D({ id: 'rock', name: 'Rock' }));
    expect(containsExplicitLights([root])).toBe(false);
  });
});
