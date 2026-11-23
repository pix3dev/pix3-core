import { Vector3 } from 'three';
import { appLifecycle } from '../core/AppLifecycle';
import { Script } from '../core/ScriptComponent';
import type { SceneService } from '../core/SceneService';
import { Node3D } from '../nodes/Node3D';
import type { PropertySchema } from '../fw/property-schema';

export interface ShakeOptions {
  /** Peak positional displacement, in the node's local units. */
  amplitude?: number;
  /** Oscillation speed (higher = faster jitter). */
  frequency?: number;
  /** Duration in seconds. `0` shakes until stopped. */
  duration?: number;
  /** Falloff power applied to `(1 - progress)`; `0` = no decay, `1` = linear. */
  decay?: number;
  /**
   * Shake along one axis only, at this angle in radians in the XY plane (`0` = along +X, `π/2` =
   * along +Y) — a recoil along the blow. Omitted = every direction. For this request only.
   */
  direction?: number;
}

/**
 * Smooth-noise positional shake, additive over whatever else drives the node's
 * position (e.g. a FollowBehavior). It runs on the runner's REAL frame delta
 * ({@link shakeStep}), not the scaled one: it plays through a hitstop — the frozen frame is
 * exactly when an impact shakes — and decays in real time under slow-mo; a pause stops it. A
 * request weaker than the shake playing now is ignored ({@link ShakeEnvelope.start}).
 * Reusable two ways (P0.3):
 *
 *  - **Preset** (`core:Shake`): attach in the inspector, drive on a node signal
 *    via `triggerEvent`, or auto-start with `playOnStart`.
 *  - **Script API**: `scene.juice.shake(node, { amplitude, frequency, ... })`.
 *
 * The offset is removed and re-applied each frame (never accumulated), so it
 * composes with other position writers and always restores cleanly on stop.
 * When shaking a followed camera, attach this after the follower for the least
 * smoothing coupling.
 */
export class ShakeBehavior extends Script {
  private readonly envelope = new ShakeEnvelope();
  private readonly appliedOffset = new Vector3();

  private readonly onTriggerSignal = (): void => {
    this.trigger();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      amplitude: 8,
      frequency: 24,
      duration: 0.35,
      decay: 1.5,
      triggerEvent: '',
      playOnStart: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ShakeBehavior',
      properties: [
        {
          name: 'amplitude',
          type: 'number',
          ui: { label: 'Amplitude', group: 'Shake', min: 0, step: 0.5 },
          getValue: c => (c as ShakeBehavior).getAmplitude(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.amplitude = ShakeBehavior.num(v, 8, 0);
          },
        },
        {
          name: 'frequency',
          type: 'number',
          ui: { label: 'Frequency', group: 'Shake', min: 0, step: 1 },
          getValue: c => (c as ShakeBehavior).getFrequency(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.frequency = ShakeBehavior.num(v, 24, 0);
          },
        },
        {
          name: 'duration',
          type: 'number',
          ui: { label: 'Duration', group: 'Shake', min: 0, step: 0.05, precision: 2, unit: 's' },
          getValue: c => (c as ShakeBehavior).getDuration(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.duration = ShakeBehavior.num(v, 0.35, 0);
          },
        },
        {
          name: 'decay',
          type: 'number',
          ui: {
            label: 'Decay',
            description: 'Falloff power (0 = steady, 1 = linear, >1 = punchy tail)',
            group: 'Shake',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: c => (c as ShakeBehavior).getDecay(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.decay = ShakeBehavior.num(v, 1.5, 0);
          },
        },
        {
          name: 'direction',
          type: 'number',
          ui: {
            label: 'Direction',
            description:
              'Shake along one axis at this angle (radians); remove the key to shake in every direction',
            group: 'Shake',
            step: 0.05,
            precision: 2,
          },
          getValue: c => (c as ShakeBehavior).getDirection() ?? null,
          setValue: (c, v) => {
            const config = (c as ShakeBehavior).config;
            const parsed = typeof v === 'number' ? v : Number(v);
            if (v != null && v !== '' && Number.isFinite(parsed)) config.direction = parsed;
            else delete config.direction;
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal that starts the shake (empty = manual/API only)',
            group: 'Shake',
          },
          getValue: c => (c as ShakeBehavior).getTriggerEvent(),
          setValue: (c, v) => {
            (c as ShakeBehavior).setTriggerEvent(v);
          },
        },
        {
          name: 'playOnStart',
          type: 'boolean',
          ui: { label: 'Play On Start', group: 'Shake' },
          getValue: c => !!(c as ShakeBehavior).config.playOnStart,
          setValue: (c, v) => {
            (c as ShakeBehavior).config.playOnStart = !!v;
          },
        },
      ],
      groups: { Shake: { label: 'Shake', expanded: true } },
    };
  }

  onStart(): void {
    this.bindTrigger();
    if (this.config.playOnStart) {
      this.trigger();
    }
  }

  override onDetach(): void {
    this.unbindTrigger();
    this.restore();
    this.envelope.stop();
    super.onDetach();
  }

  /**
   * Configure (partial) and (re)start the shake. Used by the juice API. A request weaker than the
   * shake playing now is ignored and leaves the config as it was; `direction` is for this request
   * only (the config's own `direction` applies when it is omitted).
   */
  play(options: ShakeOptions = {}): void {
    const amplitude = ShakeBehavior.optionNum(options.amplitude, 8);
    const frequency = ShakeBehavior.optionNum(options.frequency, 24);
    const duration = ShakeBehavior.optionNum(options.duration, 0.35);
    const decay = ShakeBehavior.optionNum(options.decay, 1.5);
    const started = this.envelope.start({
      amplitude: amplitude ?? this.getAmplitude(),
      frequency: frequency ?? this.getFrequency(),
      duration: duration ?? this.getDuration(),
      decay: decay ?? this.getDecay(),
      direction: finiteOrUndefined(options.direction) ?? this.getDirection(),
    });
    if (!started) return;
    if (amplitude !== undefined) this.config.amplitude = amplitude;
    if (frequency !== undefined) this.config.frequency = frequency;
    if (duration !== undefined) this.config.duration = duration;
    if (decay !== undefined) this.config.decay = decay;
  }

  /** (Re)start the shake from the beginning with the configured values — unless a stronger one plays. */
  trigger(): void {
    this.envelope.start({
      amplitude: this.getAmplitude(),
      frequency: this.getFrequency(),
      duration: this.getDuration(),
      decay: this.getDecay(),
      direction: this.getDirection(),
    });
  }

  /** Stop shaking and restore the node's position. */
  stop(): void {
    this.envelope.stop();
    this.restore();
  }

  onUpdate(dt: number): void {
    if (!this.node) {
      return;
    }

    // Remove last frame's offset so we read/leave the node's "clean" position.
    this.restore();

    if (
      !this.envelope.advance(
        shakeStep(this.scene, dt),
        this.appliedOffset,
        this.node instanceof Node3D
      )
    ) {
      return;
    }
    this.node.position.add(this.appliedOffset);
  }

  private restore(): void {
    if (this.node && (this.appliedOffset.x || this.appliedOffset.y || this.appliedOffset.z)) {
      this.node.position.sub(this.appliedOffset);
    }
    this.appliedOffset.set(0, 0, 0);
  }

  private bindTrigger(): void {
    const trigger = this.getTriggerEvent();
    if (this.node && trigger) {
      this.node.connect(trigger, this, this.onTriggerSignal);
    }
  }

  private unbindTrigger(): void {
    const trigger = this.getTriggerEvent();
    if (this.node && trigger) {
      this.node.disconnect(trigger, this, this.onTriggerSignal);
    }
  }

  private getAmplitude(): number {
    return ShakeBehavior.num(this.config.amplitude, 8, 0);
  }

  private getFrequency(): number {
    return ShakeBehavior.num(this.config.frequency, 24, 0);
  }

  private getDuration(): number {
    return ShakeBehavior.num(this.config.duration, 0.35, 0);
  }

  private getDecay(): number {
    return ShakeBehavior.num(this.config.decay, 1.5, 0);
  }

  private getDirection(): number | undefined {
    return finiteOrUndefined(this.config.direction);
  }

  private getTriggerEvent(): string {
    return typeof this.config.triggerEvent === 'string' ? this.config.triggerEvent.trim() : '';
  }

  private setTriggerEvent(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbindTrigger();
    }
    this.config.triggerEvent = typeof value === 'string' ? value.trim() : '';
    if (wasBound) {
      this.bindTrigger();
    }
  }

  private static num(value: unknown, fallback: number, min: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, parsed);
  }

  /** An option as the config would store it (`num` with a floor of 0), or undefined when omitted. */
  private static optionNum(value: number | undefined, fallback: number): number | undefined {
    return value == null ? undefined : ShakeBehavior.num(value, fallback, 0);
  }
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** What one shake plays: {@link ShakeOptions} resolved against the shaker's own defaults. */
export interface ShakeParams {
  amplitude: number;
  frequency: number;
  duration: number;
  decay: number;
  direction?: number;
}

/**
 * The envelope every shake plays (`core:Shake`, `Camera2D`): a smooth-noise offset whose amplitude
 * falls off as `(1 - progress)^decay`.
 */
export class ShakeEnvelope {
  private params: ShakeParams | null = null;
  private elapsed = 0;

  /**
   * The amplitude it shakes with right now (amplitude × envelope; 0 when idle) — what a new
   * request has to reach to replace it.
   */
  get strength(): number {
    const params = this.params;
    return params ? params.amplitude * this.damp(params) : 0;
  }

  /**
   * Start `params` from the beginning, unless the shake playing now is stronger: a light hit
   * during a heavy one's shake is ignored instead of cutting it short. Compared with the current
   * strength, not the peak, so a decaying tail never blocks the next blow. Returns whether it
   * started.
   */
  start(params: ShakeParams): boolean {
    if (params.amplitude < this.strength) return false;
    this.params = { ...params };
    this.elapsed = 0;
    return true;
  }

  stop(): void {
    this.params = null;
  }

  /**
   * Advance by `stepSec` and write this frame's offset into `out` (z only when `depth`). Returns
   * false — `out` untouched — when idle or the shake just ended.
   */
  advance(stepSec: number, out: Vector3, depth: boolean): boolean {
    const params = this.params;
    if (!params) return false;
    this.elapsed += Math.max(0, stepSec);
    if (params.duration > 0 && this.elapsed >= params.duration) {
      this.params = null;
      return false;
    }
    const amp = params.amplitude * this.damp(params) * shakeMotionScale();
    const phase = this.elapsed * params.frequency;
    if (params.direction !== undefined) {
      const along = shakeNoise(phase, 0) * amp;
      out.set(Math.cos(params.direction) * along, Math.sin(params.direction) * along, 0);
    } else {
      out.set(
        shakeNoise(phase, 0) * amp,
        shakeNoise(phase, 100) * amp,
        depth ? shakeNoise(phase, 200) * amp * 0.5 : 0
      );
    }
    return true;
  }

  private damp(params: ShakeParams): number {
    const progress = params.duration > 0 ? this.elapsed / params.duration : 0;
    return Math.pow(Math.max(0, 1 - progress), params.decay);
  }
}

/**
 * Seconds a shake advances this tick: the runner's REAL frame delta
 * ({@link GameTime.unscaledDeltaSec}) — once per tick through a hitstop and at full speed under
 * slow-mo, nothing while paused — or the given `dt` where no runner drives the scene.
 */
export function shakeStep(scene: SceneService | undefined, dt: number): number {
  return scene?.time.unscaledDeltaSec ?? dt;
}

/**
 * Smooth pseudo-random value in ~[-1, 1] from a sum of incommensurate sines.
 * Deterministic (no Math.random), continuous over time, and decorrelated per
 * axis via the `seed` offset — so shakes look organic and replay identically.
 * Exported so other shake-driven nodes (e.g. {@link ../nodes/2D/Camera2D})
 * reuse the exact same deterministic noise.
 */
export function shakeNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.373 + seed * 12.9898) * 0.5 +
    Math.sin(t * 2.917 + seed * 7.233) * 0.3 +
    Math.sin(t * 5.109 + seed * 19.19) * 0.2
  );
}

/** How far a shake moves under `scene.app.reducedMotion`: a quarter (`core:Shake`, `Camera2D`). */
export const REDUCED_MOTION_SHAKE_SCALE = 0.25;

/** The amplitude factor every shake applies while it plays. */
export function shakeMotionScale(): number {
  return appLifecycle.reducedMotion ? REDUCED_MOTION_SHAKE_SCALE : 1;
}
