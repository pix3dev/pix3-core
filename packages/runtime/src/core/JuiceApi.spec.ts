import { describe, expect, it, vi } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, ShaderLib, Vector2 } from 'three';
import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { Camera3D } from '../nodes/3D/Camera3D';
import { Camera2D } from '../nodes/2D/Camera2D';
import { ShakeBehavior } from '../behaviors/ShakeBehavior';
import { appLifecycle } from './AppLifecycle';
import { SceneSaver } from './SceneSaver';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Node2D } from '../nodes/Node2D';
import { REDUCED_MOTION_HIT_FLASH_AMOUNT } from './JuiceApi';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

interface Harness {
  service: SceneService;
  camera: Camera3D;
  gameTime: GameTime;
  parent: HTMLDivElement;
}

function makeHarness(): Harness {
  const gameTime = new GameTime();
  const camera = new Camera3D({ id: 'cam', name: 'Camera', projection: 'perspective' });
  const service = new SceneService();

  const delegate: SceneServiceDelegate = {
    getActiveCameraNode: () => camera,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1920, height: 1080 }),
    setActiveCameraNode: () => undefined,
    findNodeById: id => (id === camera.nodeId ? camera : null),
    getRootNodes: () => [camera],
    getAudioService: () => null as unknown as AudioService,
    getAssetLoader: () => null as unknown as AssetLoader,
    getResourceManager: () => null as unknown as ResourceManager,
    getECSService: () => null,
    getGameTime: () => gameTime,
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.resolve(),
  };
  service.setDelegate(delegate);

  // Attach a canvas with a parent so the flash overlay can mount.
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  service.attachCanvas(canvas);

  return { service, camera, gameTime, parent };
}

describe("scene.flash runs on the runner's unscaled time (core-tests/game14)", () => {
  it('fades with the ticks the runner advances, through a hitstop, and holds while nothing advances', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback);
      return frames.length;
    });
    const runFrame = () => frames.shift()?.(performance.now() + 10_000);
    const { service, gameTime, parent } = makeHarness();
    service.juice.flash({ intensity: 1, durationSec: 0.2 });
    const overlay = parent.querySelector('div') as HTMLDivElement;

    runFrame(); // wall clock moved a lot, the runner did not: still at full intensity
    expect(Number(overlay.style.opacity)).toBeCloseTo(1, 5);
    service.time.hitstop(500);
    gameTime.advance(0.1); // half the flash in unscaled time, game frozen
    runFrame();
    expect(Number(overlay.style.opacity)).toBeCloseTo(0.5, 5);
    gameTime.advance(0.1);
    runFrame();
    expect(Number(overlay.style.opacity)).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('JuiceApi / impact combo (P0.3 acceptance)', () => {
  it('assembles a juicy hit from three calls: hitstop + camera shake + flash', () => {
    const { service, camera, gameTime, parent } = makeHarness();

    // 1) Freeze
    service.time.hitstop(80);
    expect(service.time.isFrozen).toBe(true);

    // 2) Camera shake
    const shake = service.juice.shake('camera', { amplitude: 12, duration: 0.3 });
    expect(shake).toBeInstanceOf(ShakeBehavior);
    expect(camera.getComponent(ShakeBehavior)).toBe(shake);

    // 3) Flash — a colored overlay mounts under the canvas parent at `intensity`.
    service.juice.flash({ intensity: 0.9, durationSec: 0.2 });
    const flashEl = parent.querySelector('div') as HTMLDivElement | null;
    expect(flashEl).not.toBeNull();
    expect(Number(flashEl?.style.opacity)).toBeCloseTo(0.9, 2);

    // The freeze actually zeroes gameplay dt once the frame advances.
    gameTime.advance(0.016);
    expect(gameTime.scale).toBe(0);
  });

  it('reuses one effect component per node across repeated calls', () => {
    const { service, camera } = makeHarness();

    const first = service.juice.shake('camera', { amplitude: 8 });
    const second = service.juice.shake('camera', { amplitude: 20 });

    expect(second).toBe(first);
    expect(camera.components.filter(c => c instanceof ShakeBehavior)).toHaveLength(1);
  });

  it('returns null when the juice target cannot be resolved', () => {
    const { service } = makeHarness();

    expect(service.juice.shake('does-not-exist')).toBeNull();
    expect(service.juice.punchScale('nope')).toBeNull();
  });
});

describe('JuiceApi / 2D camera shake targets', () => {
  function makeService(opts: {
    active3D: Camera3D | null;
    active2D: Camera2D | null;
  }): SceneService {
    const gameTime = new GameTime();
    const service = new SceneService();
    const delegate: SceneServiceDelegate = {
      getActiveCameraNode: () => opts.active3D,
      getActiveCamera2DNode: () => opts.active2D,
      getInputService: () => new InputService(),
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 1920, height: 1080 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => null as unknown as AudioService,
      getAssetLoader: () => null as unknown as AssetLoader,
      getResourceManager: () => null as unknown as ResourceManager,
      getECSService: () => null,
      getGameTime: () => gameTime,
      raycastViewport: () => null,
      reportFrameProfilerActivities: () => undefined,
      loadAndStartScene: () => Promise.resolve(),
    };
    service.setDelegate(delegate);
    return service;
  }

  // Camera2D shake is its own additive state (not a ShakeBehavior component), so
  // "did it start?" = a solved offset becomes non-zero.
  function isShaking(cam: Camera2D): boolean {
    cam.solve(0.05);
    const off = cam.getShakeOffset(new Vector2());
    return off.x !== 0 || off.y !== 0;
  }

  it("'camera2d' shakes the active Camera2D and returns null", () => {
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: null, active2D: cam2d });

    const result = service.juice.shake('camera2d', { amplitude: 12, duration: 1 });
    expect(result).toBeNull();
    expect(isShaking(cam2d)).toBe(true);
  });

  it("'camera' falls back to the active Camera2D only when there is no active Camera3D", () => {
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: null, active2D: cam2d });

    const result = service.juice.shake('camera', { amplitude: 12, duration: 1 });
    expect(result).toBeNull();
    expect(isShaking(cam2d)).toBe(true);
  });

  it("'camera' targets the Camera3D (not the Camera2D) when a Camera3D is active", () => {
    const camera3d = new Camera3D({ id: 'cam', name: 'Camera', projection: 'perspective' });
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: camera3d, active2D: cam2d });

    const result = service.juice.shake('camera', { amplitude: 12, duration: 1 });
    expect(result).toBeInstanceOf(ShakeBehavior);
    expect(camera3d.getComponent(ShakeBehavior)).toBe(result);
    expect(isShaking(cam2d)).toBe(false);
  });

  it("'camera2d' returns null when no Camera2D is active", () => {
    const service = makeService({ active3D: null, active2D: null });
    expect(service.juice.shake('camera2d')).toBeNull();
  });
});

describe('reduced motion (scene.app.reducedMotion)', () => {
  const offsetAfter = (service: SceneService, camera: Camera3D): number => {
    const before = camera.position.clone();
    const shake = service.juice.shake('camera', { amplitude: 10, frequency: 7, duration: 1 });
    shake?.onUpdate(0.05);
    const moved = camera.position.distanceTo(before);
    shake?.stop();
    return moved;
  };

  it('shakes a quarter as far and does not flash; a run override beats the game, the game the system', () => {
    const query = { matches: true } as MediaQueryList;
    vi.stubGlobal('matchMedia', () => query);
    const { service, camera, parent } = makeHarness();
    try {
      appLifecycle.setReducedMotion('game', false);
      expect(service.app.reducedMotion).toBe(false);
      const full = offsetAfter(service, camera);
      expect(full).toBeGreaterThan(0);
      service.app.setReducedMotion(null); // the system's prefers-reduced-motion again
      expect(service.app.reducedMotion).toBe(true);
      expect(offsetAfter(service, camera)).toBeCloseTo(full * 0.25, 6);
      service.flash({ intensity: 1 });
      expect(parent.querySelector('div')).toBeNull();
      service.app.setReducedMotion(false);
      appLifecycle.setReducedMotion('run', true);
      expect(service.app.reducedMotion).toBe(true);
      service.app.clear(); // a session's end forgets the game's choice, not the run's
      appLifecycle.setReducedMotion('run', null);
      expect(service.app.reducedMotion).toBe(true);
    } finally {
      appLifecycle.setReducedMotion('run', null);
      appLifecycle.setReducedMotion('game', null);
      vi.unstubAllGlobals();
    }
  });
});

describe('juice.hitFlash', () => {
  const flash = (sprite: Sprite2D) => sprite.getShaderEffectStack().get('core:flash');
  const amountOf = (sprite: Sprite2D): number =>
    flash(sprite)!.uniforms.uPix3FlashAmount.value as number;
  const colorOf = (sprite: Sprite2D): Color =>
    flash(sprite)!.uniforms.uPix3FlashColor.value as Color;
  const materialOf = (sprite: Sprite2D): MeshBasicMaterial =>
    (sprite.children.find(c => (c as unknown as Mesh).isMesh) as unknown as Mesh)
      .material as MeshBasicMaterial;
  const yamlOf = (sprite: Sprite2D): string =>
    new SceneSaver().serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
    });

  it('sets amount for durationSec of unscaled time — through a hitstop — then leaves the added effect at 0', () => {
    const { service, gameTime } = makeHarness();
    const sprite = new Sprite2D({ id: 'target', width: 40, height: 40 });
    gameTime.advance(1 / 60);

    expect(service.juice.hitFlash(sprite, { color: '#ff0000' })).toBe(true);
    expect(amountOf(sprite)).toBe(1);
    // The authored colour converts once (sRGB hex → linear), like any colour param.
    expect(colorOf(sprite).getHexString()).toBe('ff0000');
    expect(materialOf(sprite).defines?.PIX3_FX_FLASH).toBeDefined();

    service.time.hitstop(500);
    gameTime.advance(0.05);
    service.updateJuice();
    expect(gameTime.scale).toBe(0);
    expect(amountOf(sprite)).toBe(1);
    gameTime.advance(0.02);
    service.updateJuice();
    expect(amountOf(sprite)).toBe(0);
    expect(flash(sprite)).toBeDefined(); // kept for the next hit, no recompile then
  });

  it('keeps the alpha: the flash mixes the colour only, before the opaque write', () => {
    const { service } = makeHarness();
    const sprite = new Sprite2D({ id: 'target' });
    service.juice.hitFlash(sprite);
    const material = materialOf(sprite);
    expect(material.transparent).toBe(true);
    const shader = {
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    (material.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
    const mix = shader.fragmentShader.indexOf('outgoingLight = mix(outgoingLight, uPix3FlashColor');
    expect(mix).toBeGreaterThan(0);
    // `opaque_fragment` writes `vec4(outgoingLight, diffuseColor.a)`: the texture's alpha survives.
    expect(mix).toBeLessThan(shader.fragmentShader.indexOf('#include <opaque_fragment>'));
    expect(shader.uniforms.uPix3FlashAmount).toBe(flash(sprite)!.uniforms.uPix3FlashAmount);
  });

  it('borrows an authored core:flash and gives back exactly its state; a repeat restarts the timer', () => {
    const { service, gameTime } = makeHarness();
    const sprite = new Sprite2D({ id: 'target' });
    sprite.attachEffect('core:flash', {
      enabled: false,
      params: { color: '#00ff00', amount: 0.2 },
    });
    const authoredYaml = yamlOf(sprite);
    gameTime.advance(1 / 60);

    service.juice.hitFlash(sprite, { durationSec: 0.06 });
    expect(amountOf(sprite)).toBe(1);
    expect(colorOf(sprite).getHexString()).toBe('ffffff');
    expect(materialOf(sprite).defines?.PIX3_FX_FLASH).toBeDefined(); // on, though authored off
    expect(yamlOf(sprite)).toBe(authoredYaml); // a save mid-flash sees the authored effect

    gameTime.advance(0.04);
    service.updateJuice();
    service.juice.hitFlash(sprite, { durationSec: 0.06, color: '#0000ff' });
    gameTime.advance(0.04); // 0.08 after the first call, 0.04 after the second
    service.updateJuice();
    expect(amountOf(sprite)).toBe(1);
    gameTime.advance(0.03);
    service.updateJuice();

    expect(amountOf(sprite)).toBeCloseTo(0.2, 6);
    expect(colorOf(sprite).getHexString()).toBe('00ff00');
    expect(flash(sprite)!.enabled).toBe(false);
    expect(materialOf(sprite).defines?.PIX3_FX_FLASH).toBeUndefined();
    expect(yamlOf(sprite)).toBe(authoredYaml);
  });

  it('survives one tick however long it was, and ends with the scene', () => {
    const { service, gameTime } = makeHarness();
    const sprite = new Sprite2D({ id: 'target' });
    gameTime.advance(1 / 60);

    // Called between ticks (an input handler); the next tick is longer than the flash.
    service.juice.hitFlash(sprite, { durationSec: 0.06 });
    gameTime.advance(0.1);
    service.updateJuice();
    expect(amountOf(sprite)).toBe(1); // that tick's frame draws it
    gameTime.advance(0.1);
    service.updateJuice();
    expect(amountOf(sprite)).toBe(0);

    service.juice.hitFlash(sprite, { durationSec: Infinity }); // not a number of seconds: default
    service.clearTweens(); // SceneRunner.stop()
    expect(amountOf(sprite)).toBe(0);
  });

  it('an effect it added is never saved', () => {
    const { service } = makeHarness();
    const sprite = new Sprite2D({ id: 'target' });
    service.juice.hitFlash(sprite);
    expect(yamlOf(sprite)).not.toContain('effects');
    expect(sprite.getInstancePropertySchema()).toBeNull();
  });

  it('flashes only its target: two sprites never share the material or the uniforms', () => {
    const { service } = makeHarness();
    const a = new Sprite2D({ id: 'a' });
    const b = new Sprite2D({ id: 'b' });
    service.juice.hitFlash(a);
    service.juice.hitFlash(b, { amount: 0 });
    expect(materialOf(a)).not.toBe(materialOf(b));
    expect(flash(a)!.uniforms.uPix3FlashAmount).not.toBe(flash(b)!.uniforms.uPix3FlashAmount);
    expect(amountOf(a)).toBe(1);
    expect(amountOf(b)).toBe(0); // the warm-up call: compiled in, nothing shown
  });

  it('plays at half strength under reduced motion', () => {
    const { service } = makeHarness();
    const sprite = new Sprite2D({ id: 'target' });
    try {
      appLifecycle.setReducedMotion('run', true);
      service.juice.hitFlash(sprite);
      expect(amountOf(sprite)).toBe(REDUCED_MOTION_HIT_FLASH_AMOUNT);
    } finally {
      appLifecycle.setReducedMotion('run', null);
    }
  });

  it('warns once and does nothing on a node without shader effects', () => {
    const { service } = makeHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const group = new Node2D({ id: 'group', name: 'group' });
    expect(service.juice.hitFlash(group)).toBe(false);
    expect(service.juice.hitFlash(group)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
