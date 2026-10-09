import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Node2D, Node3D, type SceneGraph } from '@pix3/runtime';

import { appState } from '@/state';
import {
  ViewportTransformSession,
  type ViewportTransformSessionDeps,
} from './ViewportTransformSession';
import type { Active2DTransform } from './TransformTool2d';

/**
 * Esc during a drag (plan §G.2 gate "Esc во время drag → записи нет"): the nodes go back to their
 * start state and no operation is recorded — for 2D handle drags and for the 3D gizmo.
 */

const graphOf = (...nodes: Array<Node2D | Node3D>): SceneGraph =>
  ({ rootNodes: nodes, nodeMap: new Map(nodes.map(n => [n.nodeId, n])) }) as unknown as SceneGraph;

function session(graph: SceneGraph, controls?: object) {
  const invokeAndPush = vi.fn(async () => true);
  const deps = {
    getTransformControls: () => controls,
    getActiveSceneGraph: () => graph,
    getSceneGraph: () => graph,
    getOperationService: () => ({ invokeAndPush }),
    getTargetNodeForObject: () => null,
    getTransformTool2d: () => ({ clearActiveHandle: vi.fn() }),
    getSelection2DOverlay: () => undefined,
    updateNodeTransform: vi.fn(),
    syncAll2DVisuals: vi.fn(),
    end2DInteraction: vi.fn(),
    update2DSelectionOverlayForNodes: vi.fn(),
    updateSelection: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as ViewportTransformSessionDeps;
  return { session: new ViewportTransformSession(deps), invokeAndPush };
}

describe('ViewportTransformSession — Esc cancels a drag', () => {
  it('2D: the dragged node is back, no operation, the gesture flag drops', async () => {
    const node = new Node2D({ id: 'n', name: 'N' });
    const { session: s, invokeAndPush } = session(graphOf(node));
    s.active2DTransform = {
      nodeIds: ['n'],
      handle: 'move',
      startStates: new Map([
        [
          'n',
          { position: new THREE.Vector3(1, 2, 0), rotation: 0, scale: new THREE.Vector2(1, 1) },
        ],
      ]),
    } as unknown as Active2DTransform;
    node.position.set(50, 60, 0); // mid-drag
    appState.ui.gestureInProgress = true;

    expect(s.cancel2DTransform()).toBe(true);
    expect([node.position.x, node.position.y]).toEqual([1, 2]);
    expect(s.has2DTransform()).toBe(false);
    expect(appState.ui.gestureInProgress).toBe(false);
    await s.complete2DTransform(); // the release that follows
    expect(invokeAndPush).not.toHaveBeenCalled();
  });

  it('3D: the gizmo drag ends, the node is back, its mouseUp records nothing', async () => {
    const node = new Node3D({ id: 'm', name: 'M' });
    const controls = {
      dragging: true,
      object: node as THREE.Object3D,
      pointerUp: vi.fn(function (this: { dragging: boolean }) {
        // TransformControls dispatches `mouseUp` → the session's completion handler.
        void s.handleTransformCompleted();
        this.dragging = false;
      }),
    };
    const { session: s, invokeAndPush } = session(graphOf(node), controls);
    s.captureTransformStartState(node);
    node.position.set(9, 9, 9);
    node.scale.set(2, 2, 2);

    expect(s.cancel3DTransform()).toBe(true);
    await Promise.resolve();
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    expect(node.scale.toArray()).toEqual([1, 1, 1]);
    expect(controls.dragging).toBe(false);
    expect(invokeAndPush).not.toHaveBeenCalled();
    expect(s.cancel3DTransform()).toBe(false); // nothing left to cancel
  });
});
