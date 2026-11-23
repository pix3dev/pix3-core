import { Vector3 } from 'three';

import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { ShakeBehavior, type ShakeOptions } from '../behaviors/ShakeBehavior';
import { PunchScaleBehavior, type PunchScaleOptions } from '../behaviors/PunchScaleBehavior';
import { PopInBehavior, type PopInOptions } from '../behaviors/PopInBehavior';
import type { SeededRandom } from './seeded-random';
import {
  BURST_DEFAULTS,
  FLOAT_TEXT_DEFAULTS,
  FloatText2D,
  ParticleBurst2D,
  type BurstOptions,
  type FloatTextStyleOptions,
  type JuicePoint2D,
} from './juice-transients';
import { Trail2D, type TrailOptions } from './trail-2d';
import { isShaderEffectHost, type ShaderEffectStack } from '../shader-effects/ShaderEffectStack';
import type { SceneService } from './SceneService';
import type { FlashOptions } from './SceneService';

/**
 * Target of a juice effect: a node instance, a node query (id / name / path),
 * the literal `'camera'` to hit the active 3D camera (falling back to the active
 * 2D camera in pure-2D scenes), or `'camera2d'` to hit the active 2D camera.
 */
export type JuiceTarget = NodeBase | string;

/**
 * Where a transient 2D effect appears: a node, a node query, a 2D world point `{x, y}`, or a point
 * in a node's own space `{x, y, in: node}`.
 */
export type JuiceAnchor = JuiceTarget | JuicePoint2D;

/** Options for {@link JuiceApi.floatText} — the style fields plus a spawn anchor. */
export interface FloatTextOptions extends FloatTextStyleOptions {
  /**
   * Node / node query / 2D world point the popup spawns at. Omitted spawns it at
   * the host root's origin (screen centre in a camera-less 2D scene).
   */
  at?: JuiceAnchor;
}

/** Options for {@link JuiceApi.hitFlash}. */
export interface HitFlashOptions {
  /** Colour the target turns (default `#ffffff`). */
  color?: string;
  /** How long it stays that colour, in real (unscaled) seconds (default 0.06). */
  durationSec?: number;
  /** How far toward `color`, 0..1 (default 1; at most 0.5 under `app.reducedMotion`). */
  amount?: number;
}

/** The most a hit flash blends under `app.reducedMotion` (it still confirms the hit). */
export const REDUCED_MOTION_HIT_FLASH_AMOUNT = 0.5;

const HIT_FLASH = 'core:flash';
const HIT_FLASH_SEC = 0.06;

/** What `shake('camera2d')` shakes in a scene without a Camera2D: the 2D starter's group. */
const SCREEN_SHAKE_FALLBACK = 'design-area';

function isJuicePoint(value: unknown): value is JuicePoint2D {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as JuicePoint2D).x === 'number' &&
    typeof (value as JuicePoint2D).y === 'number' &&
    !(value instanceof NodeBase)
  );
}

/**
 * Fire-and-forget "juice" primitives, reachable from scripts as
 * `this.scene.juice` (P0.3). Each transform effect is backed by the same
 * `core:*` behavior a designer can attach in the inspector, so calling the API
 * and dropping a preset produce identical results. The effect component is
 * created once per node and reused across calls (no per-call allocation, no
 * pile-up). `punchScale` / `popIn` respect the global `Time.scale` (a hitstop freezes them,
 * slow-mo stretches them); `shake`, `hitFlash` and `flash` run on the runner's real time, so they
 * play through the freeze.
 *
 * One hit, all on the contact tick:
 * ```ts
 * this.scene.time.hitstop(60);
 * this.scene.juice.shake('camera2d', { amplitude: 6 });
 * this.scene.juice.hitFlash(target);
 * this.scene.juice.burst(target);
 * this.scene.audio.sfx('hit', { pitchVariation: 0.06 });
 * ```
 *
 * {@link burst} and {@link floatText} work differently from the transform
 * effects: instead of a reusable component on an existing node they spawn a
 * short-lived 2D node that frees itself (see `./juice-transients`).
 */
/** The design short side the juice defaults were tuned on (see `JuiceApi.designScale`). */
const JUICE_REFERENCE_SHORT_SIDE = 540;

export class JuiceApi {
  /** Monotonic id source for spawned transients (burst / floatText). */
  private transientCounter = 0;

  /** Targets already complained about; see {@link warnOnce}. */
  private readonly warned = new Set<string>();

  /**
   * Hit flashes playing: the flashed stack → when it ends on the runner's unscaled clock, and
   * whether a tick has already drawn it. A flash survives one {@link update} whatever the clock
   * says, so a long tick (a 15 fps frame is longer than the flash) still shows it once.
   */
  private readonly hitFlashes = new Map<ShaderEffectStack, { endSec: number; shown: boolean }>();

  constructor(private readonly scene: SceneService) {}

  /**
   * How much the unset sizes of `burst` / `floatText` grow with the design: the defaults (a 10 px
   * particle, a 28 px label) read right on a design whose short side is
   * {@link JUICE_REFERENCE_SHORT_SIDE}; on a 1080×1920 one they were specks a phone could not show.
   * Never below 1; an explicit option is always taken as given (design px).
   */
  private designScale(): number {
    const { width, height } = this.scene.getLogicalCameraSize();
    const scale = Math.min(width, height) / JUICE_REFERENCE_SHORT_SIDE;
    return Number.isFinite(scale) && scale > 1 ? scale : 1;
  }

  /**
   * Smooth positional shake on a node (or the active camera via `'camera'` /
   * `'camera2d'`). The 2D camera has its own built-in additive shake (not a
   * `ShakeBehavior` component), so those targets fire-and-forget and return null.
   *
   * **`null` is not a failure signal for the camera targets** — they return it on success too. A
   * shake that found no camera used to be indistinguishable from one that worked, so a scene
   * missing its Camera2D just quietly had no juice and nothing ever said so. It now warns instead
   * (once per target, so a per-frame call cannot flood the log).
   */
  shake(target: JuiceTarget, options: ShakeOptions = {}): ShakeBehavior | null {
    if (typeof target === 'string') {
      const key = target.toLowerCase();
      if (key === 'camera2d') {
        const camera2d = this.scene.getActiveCamera2D();
        if (camera2d) {
          camera2d.shake(options);
          return null;
        }
        // No Camera2D (the 2D starter has none): the screen's content is the starter's
        // design-area — the HUD and the game; the background stays put (core-tests/game16).
        const area = this.scene.lookupNode(SCREEN_SHAKE_FALLBACK);
        if (!area) {
          this.warnOnce(
            'camera2d',
            "juice.shake('camera2d') found no active Camera2D and no design-area — nothing shook. " +
              'Add a Camera2D to the scene, or shake a node instead.'
          );
          return null;
        }
        return this.shake(area, options);
      }
      // `'camera'` in a pure-2D scene (no active Camera3D) targets the 2D camera.
      if (key === 'camera' && !this.scene.getActiveCamera()) {
        const camera2d = this.scene.getActiveCamera2D();
        if (camera2d) {
          camera2d.shake(options);
          return null;
        }
      }
    }

    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(ShakeBehavior);
    if (!effect) {
      effect = new ShakeBehavior('core:Shake', 'core:Shake');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Squash-and-stretch scale punch on a node. */
  punchScale(target: JuiceTarget, options: PunchScaleOptions = {}): PunchScaleBehavior | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(PunchScaleBehavior);
    if (!effect) {
      effect = new PunchScaleBehavior('core:PunchScale', 'core:PunchScale');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Spawn pop-in: scale a node from `from`× up to its authored scale. */
  popIn(target: JuiceTarget, options: PopInOptions = {}): PopInBehavior | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(PopInBehavior);
    if (!effect) {
      effect = new PopInBehavior('core:PopIn', 'core:PopIn');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Full-screen impact flash (see {@link SceneService.flash}). */
  flash(options: FlashOptions = {}): void {
    this.scene.flash(options);
  }

  /**
   * Turn one node a flat colour for a moment — the "it was hit" read. Drives the `core:flash`
   * shader effect of the node's material (`Sprite2D`, `AnimatedSprite2D`, `Button2D`,
   * `GeometryMesh`); the sprite's alpha is kept, so only its silhouette flashes. Runs on the
   * runner's real time, so it shows through a hitstop started on the same tick.
   *
   * An authored `core:flash` is borrowed, never changed: its colour, `amount` and `enabled` come
   * back exactly when the flash ends (and a save never sees the flash). Without one, the effect is
   * added for the run and left at `amount` 0 for the next hit. A call during a flash restarts its
   * timer. The first flash of a node recompiles its shader — call
   * `hitFlash(node, { amount: 0 })` in `onStart` for a target hit at a tense moment.
   *
   * Returns whether it flashed; a node without a shader-effect stack (`Label2D`, `SpineSkeleton2D`,
   * a group) warns once and does nothing.
   */
  hitFlash(target: JuiceTarget, options: HitFlashOptions = {}): boolean {
    const node = this.resolveNode(target);
    if (!node) {
      return false;
    }
    if (!isShaderEffectHost(node)) {
      this.warnOnce(
        `hitFlash:${node.type}`,
        `hitFlash: a ${node.type} has no shader effects to flash ("${node.name}") — flash a Sprite2D, ` +
          'AnimatedSprite2D, Button2D or GeometryMesh.'
      );
      return false;
    }
    const stack = node.getShaderEffectStack();
    if (!stack.get(HIT_FLASH) && !stack.attach(HIT_FLASH, { transient: true })) {
      return false;
    }
    const color =
      typeof options.color === 'string' && options.color.trim() ? options.color.trim() : '#ffffff';
    const requested = options.amount ?? 1;
    let amount = Number.isFinite(requested) ? Math.min(1, Math.max(0, requested)) : 1;
    if (this.scene.app.reducedMotion) {
      amount = Math.min(amount, REDUCED_MOTION_HIT_FLASH_AMOUNT);
    }
    const requestedSec = options.durationSec ?? HIT_FLASH_SEC;
    const durationSec = Number.isFinite(requestedSec) ? Math.max(0, requestedSec) : HIT_FLASH_SEC;
    stack.override(HIT_FLASH, { color, amount });
    this.hitFlashes.set(stack, {
      endSec: this.scene.time.unscaledElapsedSec + durationSec,
      shown: false,
    });
    return true;
  }

  /**
   * End the hit flashes whose time is up. Called by `SceneRunner` every tick, after the scripts
   * (through {@link SceneService.updateJuice}).
   */
  update(): void {
    if (this.hitFlashes.size === 0) return;
    const now = this.scene.time.unscaledElapsedSec;
    for (const [stack, flash] of this.hitFlashes) {
      if (!flash.shown) {
        flash.shown = true;
      } else if (now >= flash.endSec) {
        stack.clearOverride(HIT_FLASH);
        this.hitFlashes.delete(stack);
      }
    }
  }

  /** End every flash now (the scene they belong to stopped; a kept node must not stay flashed). */
  clear(): void {
    for (const stack of this.hitFlashes.keys()) {
      stack.clearOverride(HIT_FLASH);
    }
    this.hitFlashes.clear();
  }

  /**
   * One-shot 2D particle burst at a node (or a 2D world point). A transient
   * play-mode visual: it spawns into the 2D tree, animates through `node.tick`
   * (so a hitstop freezes it), and frees itself when the last particle dies —
   * nothing to author, nothing to clean up.
   *
   * ```ts
   * this.scene.juice.burst('bumper-a');                                  // already juicy
   * this.scene.juice.burst(ball, { colors: ['#ffcf33', '#ff4d6d'], count: 24 });
   * this.scene.juice.burst({ x: 0, y: -220 }, { spread: Math.PI / 3, speed: 500 });
   * ```
   *
   * Returns null when the target cannot be resolved or the scene has no 2D node
   * to host the effect.
   */
  burst(target: JuiceAnchor, options: BurstOptions = {}): ParticleBurst2D | null {
    const anchor = this.resolveAnchorNode(target, 'burst');
    if (anchor === undefined) {
      return null;
    }
    const host = this.resolve2DHost(anchor);
    if (!host) {
      console.warn('[JuiceApi] burst: the scene has no 2D node to host the effect.');
      return null;
    }

    const k = this.designScale();
    const burst = new ParticleBurst2D(
      { id: this.nextTransientId('burst'), name: 'JuiceBurst' },
      {
        ...options,
        sizePx: options.sizePx ?? BURST_DEFAULTS.sizePx * k,
        speed: options.speed ?? BURST_DEFAULTS.speed * k,
        gravityY: options.gravityY ?? BURST_DEFAULTS.gravityY * k,
      },
      this.effectsRandom()
    );
    host.adoptChild(burst);
    const local = this.resolveHostLocalPoint(host, anchor, target);
    burst.position.set(local.x, local.y, 0);
    return burst;
  }

  /**
   * Floating text popup ("+100", "MISS!", a combo counter). Same transient
   * lifecycle as {@link burst}: pops in, rises, fades, frees itself — and never
   * takes part in picking, so a popup drifting over a button can't eat the tap.
   *
   * ```ts
   * this.scene.juice.floatText('+100', { at: 'bumper-a', color: '#ffcf33', glow: true });
   * ```
   */
  floatText(text: string, options: FloatTextOptions = {}): FloatText2D | null {
    const label = typeof text === 'string' ? text : String(text ?? '');
    if (label.length === 0) {
      return null;
    }

    const anchor =
      options.at === undefined ? null : this.resolveAnchorNode(options.at, 'floatText');
    if (anchor === undefined) {
      return null;
    }
    const host = this.resolve2DHost(anchor);
    if (!host) {
      console.warn('[JuiceApi] floatText: the scene has no 2D node to host the popup.');
      return null;
    }

    const k = this.designScale();
    const popup = new FloatText2D(
      { id: this.nextTransientId('float-text'), name: 'JuiceFloatText' },
      label,
      {
        ...options,
        fontSizePx: options.fontSizePx ?? FLOAT_TEXT_DEFAULTS.fontSizePx * k,
        driftPx: options.driftPx ?? FLOAT_TEXT_DEFAULTS.driftPx * k,
      }
    );
    host.adoptChild(popup);
    if (options.at !== undefined) {
      const local = this.resolveHostLocalPoint(host, anchor, options.at);
      popup.position.set(local.x, local.y, 0);
    }
    return popup;
  }

  /**
   * A fading motion ribbon that follows a node — the "this thing is fast" read a
   * ball, a dash or a projectile gets for one line of script.
   *
   * Same transient lifecycle as {@link burst}: a runtime-only 2D node spawned into
   * the target's 2D root, ticked through `node.tick` (so a hitstop freezes it) and
   * never pickable. It keeps following until `trail.stop()`, then fades out over
   * `lifeSec` and frees itself; freeing the target does the same.
   *
   * ```ts
   * this.trail = this.scene.juice.trail(this.node, { colors: ['#ffcf33', '#ff4d6d'], widthPx: 18 });
   * // ... later, when the ball is gone:
   * this.trail?.stop();
   * ```
   *
   * Returns null when the target cannot be resolved or the scene has no 2D node to
   * host the ribbon.
   */
  trail(target: JuiceTarget, options: TrailOptions = {}): Trail2D | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    const host = this.resolve2DHost(node);
    if (!host) {
      console.warn('[JuiceApi] trail: the scene has no 2D node to host the ribbon.');
      return null;
    }

    const trail = new Trail2D(
      { id: this.nextTransientId('trail'), name: 'JuiceTrail' },
      node,
      options
    );
    host.adoptChild(trail);
    return trail;
  }

  /**
   * The node a transient effect is anchored to: the resolved node, `null` for a
   * literal point (no node involved), or `undefined` when a query missed — which
   * the callers turn into a null return.
   */
  private resolveAnchorNode(target: JuiceAnchor, label: string): NodeBase | null | undefined {
    if (isJuicePoint(target)) {
      if (target.in === undefined) return null;
      // A point in a node's space: that node decides the host (its band) and the frame.
      const frame = this.resolveNode(target.in);
      if (!frame) {
        console.warn(`[JuiceApi] ${label}: the point's frame "${String(target.in)}" not found.`);
        return undefined;
      }
      return frame;
    }
    const node = this.resolveNode(target);
    if (!node) {
      console.warn(`[JuiceApi] ${label}: target "${String(target)}" not found.`);
      return undefined;
    }
    return node;
  }

  /**
   * The 2D node a transient effect is parented to. Anchored effects go to the
   * TOP-MOST `Node2D` ancestor of their anchor: that keeps them in the anchor's
   * band (a HUD anchor keeps its popup in the un-bloomed `CanvasLayer2D` overlay)
   * and, being the last child of a root, they paint above that root's content
   * without touching anyone's `zIndex`. It also decouples their lifetime from the
   * anchor — a burst outlives the brick it was spawned on.
   *
   * Unanchored effects fall back to the last 2D root that is NOT a CanvasLayer2D
   * (game content, so they bloom), or any 2D root when the scene is HUD-only.
   */
  private resolve2DHost(anchor: NodeBase | null): Node2D | null {
    if (anchor) {
      let host: Node2D | null = null;
      let current: import('three').Object3D | null = anchor;
      while (current) {
        if (current instanceof Node2D) {
          host = current;
          // A CanvasLayer2D is its own band, drawn after the main pass: an effect anchored inside
          // one (a "+100" on a result card's button) stays in it. Climbing past it put the effect
          // in the main band — under the very overlay it was anchored to.
          if (current.isCanvasLayer) break;
        }
        current = current.parent;
      }
      if (host) {
        return host;
      }
    }

    let content: Node2D | null = null;
    let fallback: Node2D | null = null;
    for (const root of this.scene.getRootNodes()) {
      if (root instanceof Node2D) {
        fallback = root;
        if (!root.isCanvasLayer) {
          content = root;
        }
      }
    }
    return content ?? fallback;
  }

  /** Anchor position expressed in the host's local space (the spawn position). */
  private resolveHostLocalPoint(
    host: Node2D,
    anchor: NodeBase | null,
    target: JuiceAnchor
  ): Vector3 {
    const world = new Vector3();
    if (anchor && isJuicePoint(target)) {
      // `{ x, y, in }`: a point in the anchor's own space.
      anchor.updateWorldMatrix(true, false);
      anchor.localToWorld(world.set(target.x, target.y, 0));
    } else if (anchor) {
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(world);
    } else if (isJuicePoint(target)) {
      world.set(target.x, target.y, 0);
    }
    // worldToLocal reads matrixWorld, which is a frame behind whenever the host
    // moved this tick — refresh it so a burst never lands at last frame's offset.
    host.updateWorldMatrix(true, false);
    return host.worldToLocal(world);
  }

  /**
   * The effects' own stream of `scene.random`: a seeded run repeats its sparks, and drawing them
   * does not move the game's sequence (a board dealt from `scene.random` stays the same however
   * many bursts played). Re-forked whenever the run is re-seeded.
   */
  private effectsRandom(): () => number {
    const random = this.scene.random;
    if (!this.fx || this.fxSeed !== random.currentSeedValue) {
      this.fx = random.fork('juice');
      this.fxSeed = random.currentSeedValue;
    }
    const fx = this.fx;
    return () => fx.next();
  }

  private fx: SeededRandom | null = null;
  private fxSeed = -1;

  private nextTransientId(kind: string): string {
    this.transientCounter += 1;
    // Colon-namespaced for the same reason spawned prefabs are: authored ids never
    // contain one, so a transient can never collide with a node lookup by id.
    return `juice:${kind}:${this.transientCounter}`;
  }

  private resolveNode(target: JuiceTarget): NodeBase | null {
    if (target instanceof NodeBase) {
      return target;
    }
    if (typeof target === 'string') {
      const resolved =
        target.toLowerCase() === 'camera'
          ? this.scene.getActiveCamera()
          : this.scene.lookupNode(target);
      if (!resolved) {
        // Every juice method returns null for an unresolved target, and callers reasonably ignore
        // the return value — juice is decoration. Without this, a renamed node turns its effects
        // off permanently and silently, which reads as "the juice API does not work".
        this.warnOnce(target, `juice: no node named "${target}" — the effect did nothing.`);
      }
      return resolved;
    }
    return null;
  }

  /**
   * Log a given complaint once per key.
   *
   * Juice calls sit in gameplay code and run every frame; an un-deduplicated warning would bury the
   * console (and the agent-facing log channel) under thousands of identical lines, which is the
   * same "noise trains you to ignore it" failure as staying silent, only louder.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(`[Juice] ${message}`);
  }
}
