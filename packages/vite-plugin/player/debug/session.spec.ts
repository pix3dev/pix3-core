import {
  getScriptErrorSink,
  Node3D,
  registerRuntimeSceneRoot,
  registerGameDebug,
  reportScriptError,
  resolveRuntimeTimeConfig,
  type AudioService,
  type ResolvedRuntimeTimeConfig,
  type RuntimeRenderer,
  type RuntimeTimeConfig,
  type SceneRunner,
  type SceneRunnerFrameSample,
} from '@pix3/runtime';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Pix3PlayerState } from '../index';
import { mountDebugOverlay } from './index';
import { DebugSession } from './session';

/** The slice of `SceneRunner` the session uses, with the time mode it would be in. */
const fakeRunner = () => {
  const listeners = new Set<(sample: SceneRunnerFrameSample) => void>();
  let mode: ResolvedRuntimeTimeConfig = resolveRuntimeTimeConfig({ mode: 'realtime' });
  const runner = {
    running: true,
    subscribeFrameStats: (listener: (sample: SceneRunnerFrameSample) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTimeMode: () => ({ ...mode }),
    setTimeMode: vi.fn((config: RuntimeTimeConfig) => {
      mode = resolveRuntimeTimeConfig(config);
    }),
    stepFrames: vi.fn(() => (mode.mode === 'manual' ? 1 : 0)),
    renderOnce: vi.fn(() => true),
  };
  const emit = (over: Partial<SceneRunnerFrameSample> = {}): void => {
    for (const listener of listeners) {
      listener({
        dt: 1 / 60,
        elapsedTime: 0,
        frameNumber: 7,
        logicMs: 1,
        renderMs: 2,
        totalFrameMs: 3,
        unaccountedMs: 13.6,
        rafLatenessMs: 0,
        ...over,
      });
    }
  };
  return { runner, emit, listeners };
};

const context = (runner: ReturnType<typeof fakeRunner>['runner']) => {
  const programs = { count: 3 };
  const state: Pix3PlayerState = {
    status: 'running',
    loadId: 'load-1',
    rev: 3,
    frames: 0,
    errors: [],
    scene: 'scenes/main.pix3scene',
    runner: null,
    renderer: null,
  };
  return {
    programs,
    state,
    value: {
      runner: runner as unknown as SceneRunner,
      renderer: {
        getStatsSnapshot: () => ({
          calls: 12,
          triangles: 400,
          points: 0,
          lines: 0,
          geometries: 5,
          textures: 4,
          programs: programs.count,
        }),
      } as unknown as RuntimeRenderer,
      audio: { getActivePlaybackSnapshot: () => [] } as unknown as AudioService,
      state,
    },
  };
};

const sessions: { dispose(): void }[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  registerRuntimeSceneRoot(null);
  document.body.innerHTML = '';
});

/** A running scene: a 3D node with a mesh the game spawned, and a 2D-layer quad. */
const liveScene = () => {
  const root = new THREE.Scene();
  const ship = new Node3D({ id: 'ship', name: 'Ship' });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  hull.position.set(1, 0, 0);
  ship.add(hull);
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), new THREE.MeshBasicMaterial());
  badge.layers.set(1);
  root.add(ship, badge);
  registerRuntimeSceneRoot(root);
  return { root, ship, hull, badge };
};

const helpersIn = (root: THREE.Object3D): THREE.Box3Helper[] =>
  root.children.filter((child): child is THREE.Box3Helper => child instanceof THREE.Box3Helper);

describe('DebugSession', () => {
  it('pauses in manual time mode, steps only while paused, and resumes the previous mode', () => {
    const { runner } = fakeRunner();
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 4 });
    const session = new DebugSession(context(runner).value);
    sessions.push(session);
    session.start();

    session.step();
    expect(runner.stepFrames).not.toHaveBeenCalled();

    session.pause();
    expect(session.paused).toBe(true);
    expect(runner.getTimeMode()).toMatchObject({
      mode: 'manual',
      muteAudio: true,
      renderEveryNTicks: 1,
    });
    session.step();
    expect(runner.stepFrames).toHaveBeenCalledWith(1);

    session.resume();
    expect(session.paused).toBe(false);
    expect(runner.getTimeMode()).toMatchObject({ mode: 'fixed', ticksPerFrame: 4 });
  });

  it('leaves a game that drives its own manual ticks alone', () => {
    const { runner } = fakeRunner();
    runner.setTimeMode({ mode: 'manual' });
    runner.setTimeMode.mockClear();
    const session = new DebugSession(context(runner).value);
    session.pause();
    expect(session.paused).toBe(false);
    expect(runner.setTimeMode).not.toHaveBeenCalled();
  });

  it('reads renderer counters from a painted frame and counts programs linked since then', () => {
    const { runner, emit } = fakeRunner();
    const ctx = context(runner);
    const session = new DebugSession(ctx.value);
    sessions.push(session);
    session.start();

    // A tick that skipped its paint has reset counters: not read.
    emit({ renderMs: 0 });
    expect(session.snapshot().renderer).toBeNull();
    emit();
    session.rollWindow();
    expect(session.snapshot()).toMatchObject({
      frameNumber: 7,
      renderer: { calls: 12, programs: 3 },
      programsLinked: 0,
    });

    ctx.programs.count = 5;
    emit();
    expect(session.snapshot().programsLinked).toBe(2);
    expect(session.snapshot().window.frames).toBe(2);
    session.resetStats();
    expect(session.snapshot()).toMatchObject({ programsLinked: 0, stability: { sampleCount: 0 } });
  });

  it('collects script errors through the runtime sink and the page errors of __PIX3_PLAYER__', () => {
    const { runner } = fakeRunner();
    const ctx = context(runner);
    const session = new DebugSession(ctx.value);
    session.start();

    reportScriptError({
      phase: 'update',
      message: 'TypeError: x is undefined',
      nodeName: 'Player',
      componentType: 'user:Mover',
    });
    ctx.state.errors.push('unhandledrejection: boom');

    expect(session.snapshot().errors).toMatchObject({
      count: 2,
      recent: [
        { message: 'TypeError: x is undefined', where: 'update · Player · user:Mover' },
        { message: 'unhandledrejection: boom', where: null },
      ],
    });
    session.dispose();
    expect(getScriptErrorSink()).toBeNull();
  });

  it("includes the game's registerGameDebug snapshot", () => {
    const { runner } = fakeRunner();
    const session = new DebugSession(context(runner).value);
    const unregister = registerGameDebug({ name: 'demo', snapshot: () => ({ level: 3 }) });
    try {
      expect(session.snapshot().game).toEqual({ name: 'demo', snapshot: { level: 3 } });
    } finally {
      unregister();
    }
  });
});

describe('DebugSession: the live scene', () => {
  it('lists the live tree and reads one object in detail, a node with its properties', () => {
    const { hull, ship: shipNode } = liveScene();
    const session = new DebugSession(context(fakeRunner().runner).value);
    expect(session.tree()).toMatchObject({
      count: 3,
      roots: [
        { id: 'ship', nodeId: 'ship', children: [{ id: hull.uuid, nodeId: null }] },
        { type: 'Mesh', nodeId: null },
      ],
    });
    expect(session.node(hull.uuid)).toMatchObject({
      type: 'Mesh',
      nodeId: null,
      world: { position: { x: 1, y: 0, z: 0 } },
      geometry: { type: 'BoxGeometry', params: { width: '2' } },
      materials: [{ type: 'MeshBasicMaterial', color: '#ffffff', map: false }],
      components: [],
    });
    shipNode.position.x = 1 / 3;
    const ship = session.node('ship');
    expect(ship).toMatchObject({ nodeId: 'ship', name: 'Ship', components: [] });
    expect(ship?.properties.position).toBe('{"x":0.333,"y":0,"z":0}');
    expect(session.node('gone')).toBeNull();
  });

  it('highlights an object on its own layers, follows it, and drops the box when it leaves', () => {
    const { root, hull, badge } = liveScene();
    const fake = fakeRunner();
    const session = new DebugSession(context(fake.runner).value);
    sessions.push(session);
    session.start();

    expect(session.highlight(hull.uuid)).toBe(true);
    const [box] = helpersIn(root);
    expect(box.box.getCenter(new THREE.Vector3()).x).toBeCloseTo(1);
    expect(box.layers.mask).toBe(hull.layers.mask);
    // The box is the debug tools' own: never in the tree.
    expect(session.tree().count).toBe(3);

    hull.position.x = 5;
    fake.emit();
    expect(box.box.getCenter(new THREE.Vector3()).x).toBeCloseTo(5);

    expect(session.highlight(badge.uuid)).toBe(true);
    expect(helpersIn(root)).toHaveLength(1);
    expect(helpersIn(root)[0].layers.mask).toBe(badge.layers.mask);

    badge.removeFromParent();
    fake.emit();
    expect(helpersIn(root)).toHaveLength(0);
    expect(session.highlight('gone')).toBe(false);
    expect(fake.runner.renderOnce).not.toHaveBeenCalled();
  });

  it('repaints a paused game once so the box shows, and clears it on highlight(null)', () => {
    const { root } = liveScene();
    const fake = fakeRunner();
    const session = new DebugSession(context(fake.runner).value);
    sessions.push(session);
    session.pause();
    session.highlight('ship');
    expect(helpersIn(root)).toHaveLength(1);
    expect(fake.runner.renderOnce).toHaveBeenCalledTimes(1);
    session.highlight(null);
    expect(helpersIn(root)).toHaveLength(0);
  });
});

describe('mountDebugOverlay', () => {
  it('mounts the panel, exposes __PIX3_PLAYER__.debug and tears both down', () => {
    const { runner, listeners } = fakeRunner();
    const ctx = context(runner);
    const unmount = mountDebugOverlay(ctx.value);

    const host = document.querySelector('.pix3-debug-overlay');
    expect(host?.shadowRoot?.querySelector('.title')?.textContent).toBe('Pix3 debug');
    expect(ctx.state.debug?.snapshot()).toMatchObject({ scene: 'scenes/main.pix3scene' });
    expect(ctx.state.debug?.tree()).toEqual({ count: 0, truncated: false, roots: [] });
    expect(listeners.size).toBe(1);

    host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="pause"]')?.click();
    expect(runner.getTimeMode().mode).toBe('manual');

    unmount();
    expect(document.querySelector('.pix3-debug-overlay')).toBeNull();
    expect(ctx.state.debug).toBeUndefined();
    expect(listeners.size).toBe(0);
    // Unmounting a paused session hands the game its clock back.
    expect(runner.getTimeMode().mode).toBe('realtime');
  });

  it('Scene tab: reads the tree on opening, filters it, selects, highlights and clears', () => {
    const { root, hull } = liveScene();
    const { runner } = fakeRunner();
    const unmount = mountDebugOverlay(context(runner).value);
    const shadow = document.querySelector('.pix3-debug-overlay')?.shadowRoot as ShadowRoot;
    const rows = () => [...shadow.querySelectorAll<HTMLElement>('.tree .node')];
    const click = (selector: string) => shadow.querySelector<HTMLElement>(selector)?.click();
    try {
      expect(rows()).toHaveLength(0);
      click('[data-tab="scene"]');
      expect(shadow.querySelector<HTMLElement>('[data-pane="profiler"]')?.hidden).toBe(true);
      // The ship holds nothing authored, so it starts closed: the rows are the roots.
      expect(rows().map(row => row.dataset.id)).toEqual(['ship', root.children[1].uuid]);
      expect(shadow.querySelector('.scene-count')?.textContent).toBe('3 objects');
      click('[data-id="ship"] .twisty');
      expect(rows()).toHaveLength(3);
      click('[data-id="ship"] .twisty');
      expect(rows()).toHaveLength(2);

      const filter = shadow.querySelector('input') as HTMLInputElement;
      filter.value = 'box';
      filter.dispatchEvent(new Event('input'));
      expect(rows()).toHaveLength(0);
      filter.value = 'mesh';
      filter.dispatchEvent(new Event('input'));
      // A match deep down shows with its ancestors.
      expect(rows().map(row => row.dataset.id)).toEqual(['ship', hull.uuid, root.children[1].uuid]);
      expect(shadow.querySelector('.scene-count')?.textContent).toBe('3 objects · 2 match');

      click(`[data-id="${hull.uuid}"] .name`);
      expect(helpersIn(root)).toHaveLength(1);
      expect(shadow.querySelector('.detail-head .type')?.textContent).toBe('Mesh');
      expect(shadow.querySelector(`[data-id="${hull.uuid}"]`)?.classList).toContain('selected');

      click('[data-action="clear"]');
      expect(helpersIn(root)).toHaveLength(0);
      expect(shadow.querySelector('.detail-head')).toBeNull();
    } finally {
      unmount();
    }
  });
});
