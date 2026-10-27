import { Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import { applyEasing, isKeyframeEasing, type KeyframeEasing } from '../animation/easing';
import type { PropertySchema } from '../fw/property-schema';

export interface PopInOptions {
  /**
   * Starting fraction of the resting scale (0 = from nothing). The resting scale is the node's
   * scale when the pop first starts; an axis at 0 there (a node hidden by `scale: [0, 0]` until
   * its pop) rests at 1.
   */
  from?: number;
  /** Duration in seconds. */
  duration?: number;
  /** Easing curve; `backOut` / `elasticOut` give the springy pop. */
  easing?: KeyframeEasing;
  /** Same as {@link easing}: the name `scene.tween.to` uses for it. */
  ease?: KeyframeEasing;
}

const DEFAULT_EASING: KeyframeEasing = 'backOut';

/**
 * Spawn "pop-in": scales the node from `from`× up to its authored scale with an
 * overshoot easing. Ticked through `node.tick`, so it respects `Time.scale`.
 * The authored (resting) scale is captured once on start, so re-triggering the
 * pop always targets the correct final scale. An axis captured at 0 rests at 1: a node pre-shrunk
 * to nothing so it stays invisible until its pop would otherwise "pop" to zero and never appear. Reusable as the `core:PopIn`
 * preset (auto-plays on start by default) or via `scene.juice.popIn(node)`.
 */
export class PopInBehavior extends Script {
  private active = false;
  private elapsed = 0;
  private captured = false;
  private readonly baseScale = new Vector3(1, 1, 1);

  private readonly onTriggerSignal = (): void => {
    this.trigger();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      from: 0,
      duration: 0.4,
      easing: DEFAULT_EASING,
      triggerEvent: '',
      playOnStart: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PopInBehavior',
      properties: [
        {
          name: 'from',
          type: 'number',
          ui: {
            label: 'From Scale',
            description: 'Starting fraction of the authored scale',
            group: 'Pop In',
            min: 0,
            step: 0.05,
            precision: 2,
          },
          getValue: c => (c as PopInBehavior).getFrom(),
          setValue: (c, v) => {
            (c as PopInBehavior).config.from = PopInBehavior.num(v, 0, 0);
          },
        },
        {
          name: 'duration',
          type: 'number',
          ui: { label: 'Duration', group: 'Pop In', min: 0, step: 0.05, precision: 2, unit: 's' },
          getValue: c => (c as PopInBehavior).getDuration(),
          setValue: (c, v) => {
            (c as PopInBehavior).config.duration = PopInBehavior.num(v, 0.4, 0);
          },
        },
        {
          name: 'easing',
          type: 'select',
          ui: {
            label: 'Easing',
            group: 'Pop In',
            options: ['backOut', 'elasticOut', 'bounceOut', 'cubicOut', 'quadOut', 'linear'],
          },
          getValue: c => (c as PopInBehavior).getEasing(),
          setValue: (c, v) => {
            (c as PopInBehavior).config.easing = isKeyframeEasing(v) ? v : DEFAULT_EASING;
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal that triggers the pop (empty = manual/API only)',
            group: 'Pop In',
          },
          getValue: c => (c as PopInBehavior).getTriggerEvent(),
          setValue: (c, v) => {
            (c as PopInBehavior).setTriggerEvent(v);
          },
        },
        {
          name: 'playOnStart',
          type: 'boolean',
          ui: { label: 'Play On Start', group: 'Pop In' },
          getValue: c => !!(c as PopInBehavior).config.playOnStart,
          setValue: (c, v) => {
            (c as PopInBehavior).config.playOnStart = !!v;
          },
        },
      ],
      groups: { 'Pop In': { label: 'Pop In', expanded: true } },
    };
  }

  onStart(): void {
    this.captureBase();
    this.bindTrigger();
    if (this.config.playOnStart) {
      this.trigger();
    }
  }

  override onDetach(): void {
    this.unbindTrigger();
    if (this.node && this.captured) {
      this.node.scale.copy(this.baseScale);
    }
    this.active = false;
    super.onDetach();
  }

  /** Configure (partial) and (re)start the pop. Used by the juice API. */
  play(options: PopInOptions = {}): void {
    if (options.from != null) this.config.from = PopInBehavior.num(options.from, 0, 0);
    if (options.duration != null)
      this.config.duration = PopInBehavior.num(options.duration, 0.4, 0);
    const easing = options.easing ?? options.ease;
    if (easing != null && isKeyframeEasing(easing)) {
      this.config.easing = easing;
    }
    this.trigger();
  }

  /** (Re)start the pop from `from`× the authored scale. */
  trigger(): void {
    if (!this.node) {
      return;
    }
    this.captureBase();
    this.elapsed = 0;
    this.active = true;
    // Snap to the starting scale immediately so there is no one-frame flash at
    // full size before the first update.
    const from = this.getFrom();
    this.node.scale.set(this.baseScale.x * from, this.baseScale.y * from, this.baseScale.z * from);
  }

  onUpdate(dt: number): void {
    if (!this.active || !this.node) {
      return;
    }

    this.elapsed += dt;
    const duration = this.getDuration();
    const t = duration > 0 ? Math.min(this.elapsed / duration, 1) : 1;
    const from = this.getFrom();
    const factor = from + (1 - from) * applyEasing(this.getEasing(), t);
    this.node.scale.set(
      this.baseScale.x * factor,
      this.baseScale.y * factor,
      this.baseScale.z * factor
    );

    if (t >= 1) {
      this.node.scale.copy(this.baseScale);
      this.active = false;
    }
  }

  private captureBase(): void {
    if (!this.node || this.captured) {
      return;
    }
    const { x, y, z } = this.node.scale;
    this.baseScale.set(
      PopInBehavior.resting(x),
      PopInBehavior.resting(y),
      PopInBehavior.resting(z)
    );
    this.captured = true;
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

  private getFrom(): number {
    return PopInBehavior.num(this.config.from, 0, 0);
  }

  private getDuration(): number {
    return PopInBehavior.num(this.config.duration, 0.4, 0);
  }

  private getEasing(): KeyframeEasing {
    return isKeyframeEasing(this.config.easing) ? this.config.easing : DEFAULT_EASING;
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

  /** A captured axis of 0 rests at 1 (see {@link captureBase}); a mirrored -1 stays mirrored. */
  private static resting(axis: number): number {
    return Math.abs(axis) < 1e-6 ? 1 : axis;
  }

  private static num(value: unknown, fallback: number, min: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, parsed);
  }
}
