/**
 * PropertyWiggleService — "what does this knob do?" for the inspector.
 *
 * Clicking a property label swings that value around its current one in the
 * editor viewport (waveform: `property-wiggle.ts`), so among fifty similar
 * look parameters the user sees which one moves what before touching any.
 *
 * A wiggle is a preview, never an edit: it writes the live node / component
 * directly — no operation, no history, no dirty scene — and puts the exact
 * original back when it ends. The same guards as the animation timeline preview
 * (`AnimationTimelinePreviewService`):
 * - anything that reads the graph to write it (flush, draft, merge) reads the
 *   authored value (`FlushService.guardAuthored`);
 * - any operation other than selection restores the value BEFORE it performs,
 *   so a real edit, an undo or an agent's merge lands on the authored value.
 *
 * A property whose change rebuilds geometry would rebuild every frame, so the
 * value moves in steps (`quantiseWiggleTime`) and only a new step is written;
 * when a written step costs a long frame the steps get coarser.
 */

import { inject, injectable } from '@/fw/di';
import type { NodeBase, PropertyDefinition, ScriptComponent } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { FlushService } from '@/services/project/FlushService';
import {
  quantiseWiggleTime,
  WIGGLE_PERIOD,
  wiggleDuration,
  wiggleValue,
  type WiggleLevel,
  type WiggleSpec,
} from './property-wiggle';

/** Operations that leave a wiggle running (they do not touch the property). */
const ALLOWED_OPERATION_IDS = new Set(['scene.select-object']);

/** Steps per swing: fine while writes are cheap, coarse when a write costs a long frame. */
const FINE_STEPS = 24;
const COARSE_STEPS = 6;
const SLOW_FRAME_MS = 50;

export interface WiggleTarget {
  /** Stable id of the row (the inspector's property key). */
  key: string;
  /** The live object the property belongs to: a node or a script component. */
  holder: NodeBase | ScriptComponent;
  /** Whether `holder` is a script component (its value lives in `config`). */
  isComponent: boolean;
  propDef: PropertyDefinition;
  spec: WiggleSpec;
}

export interface WiggleState {
  key: string;
  level: WiggleLevel;
  value: number | boolean | string;
}

type Listener = (state: WiggleState | null) => void;

interface Session {
  target: WiggleTarget;
  level: WiggleLevel;
  startedAt: number;
  /** Raw authored state: a config key may be absent, which `setValue` cannot put back. */
  restore: () => void;
  steps: number;
  lastSlot: number;
  lastWriteAt: number;
  value: number | boolean | string;
}

/** True when the property can be wiggled: number, boolean or colour, and not opted out. */
export function isWiggleable(propDef: PropertyDefinition): boolean {
  if (propDef.ui?.wiggle === false || propDef.ui?.hidden) {
    return false;
  }
  return propDef.type === 'number' || propDef.type === 'boolean' || propDef.type === 'color';
}

@injectable()
export class PropertyWiggleService {
  @inject(ViewportRendererService)
  private readonly viewport!: ViewportRendererService;

  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(FlushService)
  private readonly flush!: FlushService;

  private session: Session | null = null;
  private raf: number | null = null;
  private readonly listeners = new Set<Listener>();
  private disposeOperationListener: (() => void) | null = null;
  private disposeAuthoredGuard: (() => void) | null = null;

  get state(): WiggleState | null {
    const s = this.session;
    return s ? { key: s.target.key, level: s.level, value: s.value } : null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A click on a label: start a level-1 wiggle; the same label while it runs goes to the
   * full range (looping); a third click stops it. Another label retargets.
   */
  toggle(target: WiggleTarget): WiggleLevel | null {
    const current = this.session;
    if (current && current.target.key === target.key) {
      if (current.level === 1) {
        current.level = 2;
        current.startedAt = performance.now();
        current.lastSlot = -1;
        this.emit();
        return 2;
      }
      this.stop();
      return null;
    }
    this.stop();
    this.begin(target);
    return 1;
  }

  /** End the wiggle and put the authored value back. */
  stop(): void {
    const s = this.session;
    if (!s) {
      return;
    }
    this.session = null;
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    s.restore();
    this.disposeOperationListener?.();
    this.disposeOperationListener = null;
    this.disposeAuthoredGuard?.();
    this.disposeAuthoredGuard = null;
    this.viewport.requestRender();
    this.emit();
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private begin(target: WiggleTarget): void {
    this.session = {
      target,
      level: 1,
      startedAt: performance.now(),
      restore: snapshotRaw(target),
      steps: FINE_STEPS,
      lastSlot: -1,
      lastWriteAt: 0,
      value: target.spec.base,
    };
    this.disposeOperationListener = this.operations.addListener(this.onOperationEvent);
    this.disposeAuthoredGuard = this.flush.guardAuthored(this.readAuthored);
    this.emit();
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    const s = this.session;
    if (!s) {
      return;
    }
    // performance.now(), not the rAF timestamp: that one is the frame's start and can sit on a
    // different base than the click's performance.now() (seen in Chrome on real input).
    const now = performance.now();
    const t = Math.max(0, (now - s.startedAt) / 1000);
    if (t >= wiggleDuration(s.target.spec.kind, s.level)) {
      this.stop();
      return;
    }
    // The frame after a write took long: the write (a rebuild) is expensive, step coarser.
    if (s.lastWriteAt > 0) {
      if (now - s.lastWriteAt > SLOW_FRAME_MS) s.steps = COARSE_STEPS;
      s.lastWriteAt = 0;
    }
    const slot = Math.floor(t / (WIGGLE_PERIOD / s.steps));
    if (slot !== s.lastSlot) {
      s.lastSlot = slot;
      s.value = wiggleValue(s.target.spec, s.level, quantiseWiggleTime(t, s.steps));
      this.write(s.target, s.value);
      s.lastWriteAt = performance.now();
      this.emit();
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private write(target: WiggleTarget, value: unknown): void {
    try {
      target.propDef.setValue(target.holder, value);
    } catch (error) {
      console.warn('[PropertyWiggle] setValue failed; stopping', error);
      this.stop();
      return;
    }
    this.viewport.requestRender();
  }

  /** Writers of the graph read the authored value; the wiggle resumes on the next frame. */
  private readonly readAuthored = <T>(read: () => T): T => {
    const s = this.session;
    if (!s) return read();
    s.restore();
    try {
      return read();
    } finally {
      if (this.session === s) {
        this.write(s.target, s.value);
      }
    }
  };

  private readonly onOperationEvent = (event: OperationEvent): void => {
    if (!this.session) {
      return;
    }
    if (event.type === 'operation:invoked' && !ALLOWED_OPERATION_IDS.has(event.metadata.id)) {
      // Before it performs: the edit (or undo, or merge) sees the authored value.
      this.stop();
      return;
    }
    if (event.type === 'operation:undone' || event.type === 'operation:redone') {
      this.stop();
    }
  };

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('[PropertyWiggle] Listener failed', error);
      }
    }
  }
}

/**
 * Capture what restoring needs. A component's value lives in `config[name]` (the `config*`
 * helpers) and may be absent there — `setValue(undefined)` would write the fallback, and the
 * flush would see a key the file never had — so the raw entry is put back. A node property goes
 * back through its own `setValue`.
 */
function snapshotRaw(target: WiggleTarget): () => void {
  const { holder, propDef } = target;
  const config = target.isComponent
    ? ((holder as ScriptComponent).config as Record<string, unknown> | undefined)
    : undefined;
  if (config && typeof config === 'object') {
    const had = Object.prototype.hasOwnProperty.call(config, propDef.name);
    const raw = config[propDef.name];
    const authored = propDef.getValue(holder);
    return () => {
      // Scripts with a custom setValue keep their own state in sync…
      try {
        if (authored !== undefined) propDef.setValue(holder, authored);
      } catch {
        /* the raw restore below is what counts */
      }
      // …and the config entry is exactly what it was.
      if (had) config[propDef.name] = raw;
      else delete config[propDef.name];
    };
  }
  const authored = propDef.getValue(holder);
  const copy =
    authored && typeof authored === 'object' ? JSON.parse(JSON.stringify(authored)) : authored;
  return () => {
    propDef.setValue(holder, copy);
  };
}
