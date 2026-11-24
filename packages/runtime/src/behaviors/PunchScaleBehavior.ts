import { Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import { Node3D } from '../nodes/Node3D';
import type { PropertySchema } from '../fw/property-schema';

/** Which axes a punch scales: all alike, or one with the others compensating (squash & stretch). */
export type PunchScaleAxis = 'all' | 'x' | 'y';

const PUNCH_AXES: readonly PunchScaleAxis[] = ['all', 'x', 'y'];

/** The thinnest a squash & stretch axis gets (×0.1) however large a negative `amount`. */
const MIN_AXIS_FACTOR = 0.1;

export interface PunchScaleOptions {
  /**
   * Peak scale delta (0.3 = +30% at the first bounce). Negative = the other way first: with
   * `axis: 'y'`, `-0.25` squashes (a landing), `0.25` stretches (a jump).
   */
  amount?: number;
  /** Duration in seconds. */
  duration?: number;
  /** Number of oscillations before settling. */
  vibrato?: number;
  /**
   * `'all'` (default) scales every axis alike. `'y'` / `'x'` scale that axis by `f` and keep the
   * size: a 2D node's other axis by `1/f` (area kept), a 3D node's other two by `1/√f` (volume
   * kept).
   */
  axis?: PunchScaleAxis;
}

/**
 * Squash-and-stretch "punch" on the node's scale — an instant pop that
 * oscillates back to the authored scale. Ticked through `node.tick`, so it
 * respects the global `Time.scale`. Reusable as the `core:PunchScale` preset
 * (trigger on a signal / play on start) or via `scene.juice.punchScale(node)`.
 *
 * The resting scale is captured on trigger (not construction), so it plays
 * correctly regardless of the node's authored scale and never drifts. Scale is about the node's
 * origin: a character whose origin is at its feet squashes onto the ground. A collider on the
 * same node deforms with it; put the picture on a child node to squash only the picture.
 */
export class PunchScaleBehavior extends Script {
  private active = false;
  private elapsed = 0;
  private readonly baseScale = new Vector3(1, 1, 1);
  /**
   * The options of the {@link play} call playing now — for that punch only; what it omits is
   * read from the config every frame (so an inspector edit still lands). `null` for a
   * {@link trigger}ed punch, which plays the config as authored.
   */
  private playing: PunchScaleOptions | null = null;

  private readonly onTriggerSignal = (): void => {
    this.trigger();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      amount: 0.3,
      duration: 0.35,
      vibrato: 3,
      triggerEvent: '',
      playOnStart: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PunchScaleBehavior',
      properties: [
        {
          name: 'amount',
          type: 'number',
          ui: {
            label: 'Amount',
            description: 'Peak scale delta (0.3 = +30%; negative = the other way first, a squash)',
            group: 'Punch Scale',
            min: -0.9,
            step: 0.05,
            precision: 2,
          },
          getValue: c => PunchScaleBehavior.num((c as PunchScaleBehavior).config.amount, 0.3, -0.9),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.amount = PunchScaleBehavior.num(v, 0.3, -0.9);
          },
        },
        {
          name: 'duration',
          type: 'number',
          ui: {
            label: 'Duration',
            group: 'Punch Scale',
            min: 0,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: c => PunchScaleBehavior.num((c as PunchScaleBehavior).config.duration, 0.35, 0),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.duration = PunchScaleBehavior.num(v, 0.35, 0);
          },
        },
        {
          name: 'vibrato',
          type: 'number',
          ui: {
            label: 'Vibrato',
            description: 'Oscillations before settling',
            group: 'Punch Scale',
            min: 0,
            step: 1,
          },
          getValue: c => PunchScaleBehavior.num((c as PunchScaleBehavior).config.vibrato, 3, 0),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.vibrato = PunchScaleBehavior.num(v, 3, 0);
          },
        },
        {
          name: 'axis',
          type: 'enum',
          ui: {
            label: 'Axis',
            description:
              "'all' scales evenly; 'x' / 'y' stretch that axis and keep the area (2D) / volume (3D)",
            group: 'Punch Scale',
            options: [...PUNCH_AXES],
          },
          getValue: c => PunchScaleBehavior.axisOf((c as PunchScaleBehavior).config.axis),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.axis = PunchScaleBehavior.axisOf(v);
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal that triggers the punch (empty = manual/API only)',
            group: 'Punch Scale',
          },
          getValue: c => (c as PunchScaleBehavior).getTriggerEvent(),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).setTriggerEvent(v);
          },
        },
        {
          name: 'playOnStart',
          type: 'boolean',
          ui: { label: 'Play On Start', group: 'Punch Scale' },
          getValue: c => !!(c as PunchScaleBehavior).config.playOnStart,
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.playOnStart = !!v;
          },
        },
      ],
      groups: { 'Punch Scale': { label: 'Punch Scale', expanded: true } },
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
    this.active = false;
    super.onDetach();
  }

  /**
   * (Re)start the punch with `options` for this punch only — the config is never written, so an
   * omitted option is the authored config's (the defaults on a component the juice API made),
   * never a previous call's. Used by the juice API.
   */
  play(options: PunchScaleOptions = {}): void {
    this.start({ ...options });
  }

  /** (Re)start the punch from the beginning with the config as authored. */
  trigger(): void {
    this.start(null);
  }

  private start(options: PunchScaleOptions | null): void {
    if (!this.node) {
      return;
    }
    this.playing = options;
    // Capture the resting scale only when idle so a re-trigger mid-punch does
    // not latch onto an already-scaled value.
    if (!this.active) {
      this.baseScale.copy(this.node.scale);
    }
    this.elapsed = 0;
    this.active = true;
  }

  onUpdate(dt: number): void {
    if (!this.active || !this.node) {
      return;
    }

    this.elapsed += dt;
    const duration = this.getDuration();
    if (duration <= 0 || this.elapsed >= duration) {
      this.node.scale.copy(this.baseScale);
      this.active = false;
      return;
    }

    const progress = this.elapsed / duration;
    // Instant pop at t=0 that decays (1-t)^2 while oscillating `vibrato` times.
    const envelope = Math.pow(1 - progress, 2);
    const wave = Math.cos(progress * this.getVibrato() * Math.PI * 2);
    const factor = 1 + this.getAmount() * envelope * wave;
    const axis = this.getAxis();
    if (axis === 'all') {
      this.node.scale.set(
        this.baseScale.x * factor,
        this.baseScale.y * factor,
        this.baseScale.z * factor
      );
      return;
    }
    const f = Math.max(MIN_AXIS_FACTOR, factor);
    const is3D = this.node instanceof Node3D;
    const other = is3D ? 1 / Math.sqrt(f) : 1 / f;
    this.node.scale.set(
      this.baseScale.x * (axis === 'x' ? f : other),
      this.baseScale.y * (axis === 'y' ? f : other),
      this.baseScale.z * (is3D ? other : 1)
    );
  }

  private restore(): void {
    if (this.node && this.active) {
      this.node.scale.copy(this.baseScale);
    }
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

  /** An option of the play running now, else the config's value. */
  private value<K extends keyof PunchScaleOptions>(key: K): unknown {
    return this.playing?.[key] ?? this.config[key];
  }

  private getAmount(): number {
    return PunchScaleBehavior.num(this.value('amount'), 0.3, -0.9);
  }

  private getDuration(): number {
    return PunchScaleBehavior.num(this.value('duration'), 0.35, 0);
  }

  private getAxis(): PunchScaleAxis {
    return PunchScaleBehavior.axisOf(this.value('axis'));
  }

  private static axisOf(value: unknown): PunchScaleAxis {
    return PUNCH_AXES.includes(value as PunchScaleAxis) ? (value as PunchScaleAxis) : 'all';
  }

  private getVibrato(): number {
    return PunchScaleBehavior.num(this.value('vibrato'), 3, 0);
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
}
