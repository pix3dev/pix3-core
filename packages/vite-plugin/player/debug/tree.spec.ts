import { Node3D } from '@pix3/runtime';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DEBUG_HELPER_FLAG, findLiveObject, isUnder, liveTree } from './tree';

const scene = () => {
  const root = new THREE.Scene();
  const player = new Node3D({ id: 'player', name: 'Player' });
  const spawned = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  spawned.name = 'coin';
  spawned.visible = false;
  const pool = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 9);
  pool.count = 7;
  player.add(spawned, pool);
  const helper = new THREE.Object3D();
  helper.userData[DEBUG_HELPER_FLAG] = true;
  root.add(player, helper);
  return { root, player, spawned, pool };
};

describe('liveTree', () => {
  it('lists nodes and the objects the game made at run time, without the debug helpers', () => {
    const { root, spawned, pool } = scene();
    expect(liveTree(root)).toEqual({
      count: 3,
      truncated: false,
      roots: [
        {
          id: 'player',
          nodeId: 'player',
          type: 'Node3D',
          name: 'Player',
          visible: true,
          instances: null,
          more: 0,
          children: [
            {
              id: spawned.uuid,
              nodeId: null,
              type: 'Mesh',
              name: 'coin',
              visible: false,
              instances: null,
              children: [],
              more: 0,
            },
            {
              id: pool.uuid,
              nodeId: null,
              type: 'Mesh',
              name: '',
              visible: true,
              instances: 7,
              children: [],
              more: 0,
            },
          ],
        },
      ],
    });
  });

  it('is empty without a running scene', () => {
    expect(liveTree(null)).toEqual({ count: 0, truncated: false, roots: [] });
  });

  it('caps the children of one object and counts what it left out', () => {
    const root = new THREE.Scene();
    const parent = new THREE.Group();
    for (let i = 0; i < 300; i += 1) parent.add(new THREE.Object3D());
    root.add(parent);
    const tree = liveTree(root);
    expect(tree).toMatchObject({ count: 251, truncated: true });
    expect(tree.roots[0].children).toHaveLength(250);
    expect(tree.roots[0].more).toBe(50);
  });

  it('finds an object by uuid and tells whether it is still in the scene', () => {
    const { root, spawned } = scene();
    expect(findLiveObject(root, 'player')?.name).toBe('Player');
    expect(findLiveObject(root, spawned.uuid)).toBe(spawned);
    expect(findLiveObject(root, 'nope')).toBeNull();
    expect(isUnder(spawned, root)).toBe(true);
    spawned.removeFromParent();
    expect(isUnder(spawned, root)).toBe(false);
  });
});
