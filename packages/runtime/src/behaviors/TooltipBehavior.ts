import { Vector2 } from 'three';

import type { InputService } from '../core/InputService';
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { CanvasLayer2D } from '../nodes/2D/CanvasLayer2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { Group2D } from '../nodes/2D/Group2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import { Node2D } from '../nodes/Node2D';
import type { NodeBase } from '../nodes/NodeBase';

/** How every tooltip looks; a game sets it once (`TooltipBehavior.style.fontFamily = 'Nunito'`). */
export interface TooltipStyle {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  color: string;
  background: string;
  backgroundOpacity: number;
  /** Text longer than this wraps at `wrapWidth`. */
  wrapAfterChars: number;
  wrapWidth: number;
}

/** One per running scene: which tooltip the mouse rests on, and the one panel that shows it. */
interface TooltipHost {
  frame: number;
  /** The last tooltip whose node the pointer was inside this frame — the topmost in paint order. */
  offer: TooltipBehavior | null;
  current: TooltipBehavior | null;
  timer: number;
  /** A mouse is hovering: the pointer moved with nothing down. A touch never hovers. */
  mouse: boolean;
  lastX: number;
  lastY: number;
  view: Group2D | null;
  background: ColorRect2D | null;
  label: Label2D | null;
}
const hosts = new WeakMap<object, TooltipHost>();
const OFFSET = 18;

/**
 * `core:Tooltip` — a short explanation that appears next to the mouse while it rests on a 2D node
 * (a button, an icon, a resource counter): what it does or what it means. Hover only, after
 * `delay`; a touch never opens one (a press hides it). One tooltip at a time — the topmost node
 * under the pointer wins — drawn in the node's own `CanvasLayer2D` above everything in it.
 * The node needs a size (`width` / `height`). From a script:
 * `node.addComponent(TooltipBehavior.create('Coins: what every action costs'))`, or change the
 * text later with `tooltip.text = …`.
 */
export class TooltipBehavior extends Script {
  static readonly style: TooltipStyle = {
    fontFamily: 'Arial',
    fontWeight: 700,
    fontSize: 22,
    color: '#f5f1e6',
    background: '#26302f',
    backgroundOpacity: 0.94,
    wrapAfterChars: 44,
    wrapWidth: 420,
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { text: '', delay: 0.35 };
  }

  /** A tooltip component with this text, ready for `node.addComponent(...)`. */
  static create(text: string, delay = 0.35): TooltipBehavior {
    const tooltip = new TooltipBehavior(
      `tooltip-${Math.random().toString(36).slice(2, 9)}`,
      'core:Tooltip'
    );
    tooltip.text = text;
    tooltip.delay = delay;
    return tooltip;
  }

  get text(): string {
    return typeof this.config.text === 'string' ? this.config.text : '';
  }
  set text(value: string) {
    this.config.text = String(value ?? '');
  }
  get delay(): number {
    const d = Number(this.config.delay);
    return Number.isFinite(d) ? Math.max(0, d) : 0.35;
  }
  set delay(value: number) {
    const d = Number(value);
    this.config.delay = Number.isFinite(d) ? Math.max(0, d) : 0.35;
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TooltipBehavior',
      properties: [
        {
          name: 'text',
          type: 'string',
          ui: { label: 'Text', group: 'Tooltip' },
          getValue: (c: unknown) => (c as TooltipBehavior).text,
          setValue: (c: unknown, v: unknown) => {
            (c as TooltipBehavior).text = String(v ?? '');
          },
        },
        {
          name: 'delay',
          type: 'number',
          ui: {
            label: 'Delay',
            group: 'Tooltip',
            min: 0,
            max: 5,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: (c: unknown) => (c as TooltipBehavior).delay,
          setValue: (c: unknown, v: unknown) => {
            (c as TooltipBehavior).delay = Number(v);
          },
        },
      ],
      groups: { Tooltip: { label: 'Tooltip', expanded: true } },
    };
  }

  onUpdate(dt: number): void {
    const scene = this.scene;
    const input = this.input;
    const node = this.node;
    if (!scene || !input || !(node instanceof Node2D)) return;
    let host = hosts.get(scene);
    if (!host) {
      host = {
        frame: -1,
        offer: null,
        current: null,
        timer: 0,
        mouse: false,
        lastX: NaN,
        lastY: NaN,
        view: null,
        background: null,
        label: null,
      };
      hosts.set(scene, host);
    }
    // The first tooltip to tick in a frame settles the previous frame's offers (a frame of lag:
    // components tick in tree order, so the topmost node's offer comes last).
    if (host.frame !== scene.frame) {
      host.frame = scene.frame;
      settle(host, input, dt);
    }
    const { x, y } = input.pointerPosition;
    if (host.mouse && this.text && node.containsScreenPoint(x, y)) host.offer = this;
  }

  onDetach(): void {
    const host = this.scene ? hosts.get(this.scene) : undefined;
    if (host?.current === this) {
      host.current = null;
      if (host.view) host.view.visible = false;
    }
    if (host?.offer === this) host.offer = null;
    super.onDetach();
  }
}

function settle(host: TooltipHost, input: InputService, dt: number): void {
  const { x, y } = input.pointerPosition;
  if (input.pointerDownCount > 0) {
    // A press (or a touch) is not a hover; and its position must not read as a hover move later.
    host.mouse = false;
    host.lastX = x;
    host.lastY = y;
  } else if (x !== host.lastX || y !== host.lastY) {
    host.mouse = true;
    host.lastX = x;
    host.lastY = y;
  }
  const target = host.mouse ? host.offer : null;
  host.offer = null;
  if (target !== host.current) {
    host.current = target;
    host.timer = 0;
  }
  if (!target || !(target.node instanceof Node2D)) {
    if (host.view) host.view.visible = false;
    return;
  }
  host.timer += dt;
  if (host.timer < target.delay) return;
  show(host, target.node, target.text, x, y);
}

/** The layer a tooltip draws in: the node's CanvasLayer2D, else its topmost 2D ancestor. */
function layerOf(node: Node2D): Node2D {
  let top: Node2D = node;
  for (let n: NodeBase | null = node; n; n = n.parentNode) {
    if (n instanceof CanvasLayer2D) return n;
    if (n instanceof Node2D) top = n;
  }
  return top;
}

function show(
  host: TooltipHost,
  node: Node2D,
  text: string,
  screenX: number,
  screenY: number
): void {
  const style = TooltipBehavior.style;
  if (!host.view || !host.background || !host.label) {
    host.view = new Group2D({ id: '__pix3_tooltip', name: 'Tooltip', width: 1, height: 1 });
    host.background = new ColorRect2D({
      id: '__pix3_tooltip_bg',
      width: 1,
      height: 1,
      color: style.background,
    });
    host.label = new Label2D({ id: '__pix3_tooltip_text', label: '' });
    host.view.adoptChild(host.background);
    host.view.adoptChild(host.label);
  }
  const { view, background, label } = host;
  const layer = layerOf(node);
  if (view.parentNode !== layer) layer.adoptChild(view);
  view.zIndex = 4096;
  label.labelFontFamily = style.fontFamily;
  label.labelFontWeight = style.fontWeight;
  label.labelFontSize = style.fontSize;
  label.labelColor = style.color;
  label.labelAlign = 'left';
  label.width = text.length > style.wrapAfterChars ? style.wrapWidth : 0;
  if (label.label !== text) label.label = text;
  const size = label.textSize;
  const pad = Math.round(style.fontSize * 0.55);
  background.width = size.width + pad * 2;
  background.height = size.height + pad;
  background.color = style.background;
  background.opacity = style.backgroundOpacity;
  // Up and to the right of the pointer, flipped to stay on the screen.
  // Own vectors: screenPointToWorld's default target is a shared scratch.
  const at = view.screenPointToWorld(screenX, screenY, new Vector2());
  const input = node.input;
  const corner = input ? view.screenPointToWorld(input.width, 0, new Vector2()) : null;
  if (!at) return;
  const w = background.width,
    h = background.height;
  let cx = at.x + OFFSET + w / 2;
  let cy = at.y + OFFSET + h / 2;
  if (corner && cx + w / 2 > corner.x) cx = at.x - OFFSET - w / 2;
  if (corner && cy + h / 2 > corner.y) cy = at.y - OFFSET - h / 2;
  layer.updateWorldMatrix(true, false);
  const local = layer.worldToLocal(view.position.clone().set(cx, cy, 0));
  view.position.set(local.x, local.y, 0);
  view.visible = true;
}
