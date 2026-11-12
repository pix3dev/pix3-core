import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';

import { InputService } from '../core/InputService';
import type { SceneService } from '../core/SceneService';
import { CanvasLayer2D } from '../nodes/2D/CanvasLayer2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import type { Group2D } from '../nodes/2D/Group2D';
import { TooltipBehavior } from './TooltipBehavior';

/**
 * `core:Tooltip` on a HUD: a 300×200 canvas mapped 1:1 onto a 300×200 CanvasLayer2D (origin at the
 * centre), real PointerEvents through an attached InputService, frames advanced by hand.
 */
describe('core:Tooltip', () => {
  // happy-dom has no canvas 2D context; the tooltip's Label2D measures 8 px a character.
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
      if (kind !== '2d') return null;
      return {
        setTransform: () => {},
        scale: () => {},
        fillRect: () => {},
        fillText: () => {},
        strokeText: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        shadowColor: '',
        shadowBlur: 0,
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });
  let input: InputService;
  let element: HTMLDivElement;
  let layer: CanvasLayer2D;
  let frame: number;
  let scene: SceneService;
  let tips: TooltipBehavior[];

  const move = (x: number, y: number) =>
    element.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y })
    );
  const down = (x: number, y: number, pointerId = 1) =>
    element.dispatchEvent(new PointerEvent('pointerdown', { pointerId, clientX: x, clientY: y }));
  const up = (x: number, y: number, pointerId = 1) =>
    element.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      frame++;
      input.beginFrame();
      for (const tip of tips) tip.onUpdate(1 / 60);
    }
  };
  const view = () => layer.children.find(c => c.name === 'Tooltip') as Group2D | undefined;
  const shownText = () => {
    const v = view();
    if (!v?.visible) return null;
    return (v.children.find(c => c instanceof Label2D) as Label2D).label;
  };
  const icon = (id: string, x: number, y: number, text: string) => {
    const rect = new ColorRect2D({ id, width: 60, height: 40, position: new Vector2(x, y) });
    layer.adoptChild(rect);
    rect.input = input;
    const tip = TooltipBehavior.create(text, 0.2);
    tip.node = rect;
    tip.scene = scene;
    tip.input = input;
    tips.push(tip);
    return { rect, tip };
  };

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    input.attach(element);
    input.width = 300;
    input.height = 200;
    layer = new CanvasLayer2D({ id: 'hud', width: 300, height: 200 });
    layer.input = input;
    frame = 0;
    scene = {
      get frame() {
        return frame;
      },
    } as unknown as SceneService;
    tips = [];
  });
  afterEach(() => input.detach());

  it('appears beside a resting mouse after its delay and goes when the mouse leaves', () => {
    icon('coins', 0, 0, 'Coins: what every action costs');
    move(150, 100); // the centre of the canvas = the icon
    run(5);
    expect(shownText()).toBeNull(); // still inside the delay
    run(12);
    expect(shownText()).toBe('Coins: what every action costs');
    const v = view()!;
    expect(v.zIndex).toBe(4096);
    // The background fits the text: 30 characters × 8 px plus padding on both sides.
    const bg = v.children.find(c => c instanceof ColorRect2D) as ColorRect2D;
    expect(bg.width).toBeGreaterThan(30 * 8);
    expect(bg.width).toBeLessThan(30 * 8 + 60);
    // Beside the pointer (the canvas centre, world 0,0), not over the icon's centre; on this
    // narrow canvas it flips to the left so it stays on screen.
    const at = v.getWorldPosition(new Vector3());
    expect(Math.abs(at.x)).toBeGreaterThan(bg.width / 2);
    expect(at.y).toBeGreaterThan(bg.height / 2);
    expect(at.x + bg.width / 2).toBeLessThanOrEqual(150);

    move(20, 20); // off the icon
    run(2);
    expect(shownText()).toBeNull();
  });

  it('shows only the topmost tooltip under the pointer', () => {
    icon('panel', 0, 0, 'The panel');
    icon('button', 0, 0, 'The button on it');
    move(150, 100);
    run(20);
    expect(shownText()).toBe('The button on it');
  });

  it('hides on a press, and a touch (no hover move) never opens one', () => {
    icon('coins', 0, 0, 'Coins');
    move(150, 100);
    run(20);
    expect(shownText()).toBe('Coins');
    down(150, 100);
    run(1);
    expect(shownText()).toBeNull();
    up(150, 100);
    run(30);
    expect(shownText()).toBeNull(); // the finger lifted where it was: not a hover

    move(152, 101); // the mouse moves again
    run(20);
    expect(shownText()).toBe('Coins');
  });

  it('ignores a hidden node and a node of no size, and a detached tooltip hides its panel', () => {
    const { rect, tip } = icon('coins', 0, 0, 'Coins');
    rect.visible = false;
    move(150, 100);
    run(20);
    expect(shownText()).toBeNull();
    rect.visible = true;
    move(151, 100);
    run(20);
    expect(shownText()).toBe('Coins');
    tip.onDetach();
    tips = [];
    expect(view()?.visible).toBe(false);
  });

  it('reads its text and delay through the schema the inspector uses', () => {
    const tip = TooltipBehavior.create('a');
    const schema = TooltipBehavior.getPropertySchema();
    schema.properties.find(p => p.name === 'text')!.setValue(tip, 'Probe: explore a zone');
    schema.properties.find(p => p.name === 'delay')!.setValue(tip, -3);
    expect(tip.text).toBe('Probe: explore a zone');
    expect(tip.delay).toBe(0);
  });
});
