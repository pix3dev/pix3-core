import { afterEach, describe, expect, it } from 'vitest';

import './property-editors';

import { appState } from '@/state';

import { AnimationResourceEditor, NumberField, SliderNumberEditor } from './property-editors';

describe('Numeric property editors', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['pix3-number-field', 'pix3-slider-number-editor'] as const)(
    '%s trims decimal zeros while preserving values and display precision',
    async tag => {
      const editor = document.createElement(tag) as NumberField | SliderNumberEditor;
      editor.min = -100;
      editor.max = 100;
      editor.precision = 2;
      document.body.appendChild(editor);
      for (const [value, expected] of [
        [0, '0'],
        [30, '30'],
        [1.5, '1.5'],
        [1.234, '1.23'],
        [0.01, '0.01'],
        [-3, '-3'],
        [-0.001, '0'],
      ] as const) {
        editor.value = value;
        await editor.updateComplete;
        const input = editor.shadowRoot?.querySelector<HTMLInputElement>('.number-input');
        const display = input?.value ?? editor.shadowRoot?.querySelector('.value')?.textContent;
        expect(display).toBe(expected);
        expect(editor.value).toBe(value);
      }
    }
  );
});

describe('pix3-number-field keyboard steps and range fill', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    appState.ui.gestureInProgress = false;
  });

  const mount = async (init: Partial<NumberField>): Promise<NumberField> => {
    const field = document.createElement('pix3-number-field') as NumberField;
    Object.assign(field, init);
    document.body.appendChild(field);
    await field.updateComplete;
    return field;
  };
  const key = (target: Element, type: string, k: string, mods: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, ...mods }));

  it('arrows step by step; Shift ×10, Ctrl/Alt ×0.1; a held run previews, the release commits once', async () => {
    const field = await mount({ value: 0.5, step: 0.01, precision: 2, min: 0, max: 100 });
    const target = field.shadowRoot!.querySelector('.field')!;
    const previews: number[] = [];
    const commits: number[] = [];
    field.addEventListener('preview-change', e => previews.push((e as CustomEvent).detail.value));
    field.addEventListener('commit-change', e => commits.push((e as CustomEvent).detail.value));

    key(target, 'keydown', 'ArrowUp');
    key(target, 'keydown', 'ArrowUp');
    expect(appState.ui.gestureInProgress).toBe(true);
    key(target, 'keyup', 'ArrowUp');
    expect(previews).toEqual([0.51, 0.52]);
    expect(commits).toEqual([0.52]);
    expect(appState.ui.gestureInProgress).toBe(false);

    key(target, 'keydown', 'ArrowDown', { shiftKey: true });
    key(target, 'keyup', 'ArrowDown');
    expect(field.value).toBe(0.42);

    key(target, 'keydown', 'ArrowUp', { ctrlKey: true });
    key(target, 'keydown', 'ArrowUp', { altKey: true });
    key(target, 'keyup', 'ArrowUp');
    expect(field.value).toBe(0.422);
    await field.updateComplete;
    // The fine digit is visible once a fine step was used.
    expect(field.shadowRoot!.querySelector('.value')!.textContent).toBe('0.422');

    // A normal step adds to an off-grid value instead of snapping it.
    key(target, 'keydown', 'ArrowUp');
    key(target, 'keyup', 'ArrowUp');
    expect(field.value).toBe(0.432);
  });

  it('clamps steps to the range and fills the background up to the value', async () => {
    const field = await mount({ value: 0.25, step: 0.1, min: 0, max: 1 });
    const fill = () => field.shadowRoot!.querySelector<HTMLElement>('.fill');
    expect(fill()!.style.width).toBe('25%');
    const target = field.shadowRoot!.querySelector('.field')!;
    key(target, 'keydown', 'ArrowUp', { shiftKey: true });
    key(target, 'keyup', 'ArrowUp');
    await field.updateComplete;
    expect(field.value).toBe(1);
    expect(fill()!.style.width).toBe('100%');

    const open = await mount({ value: 3 });
    expect(open.shadowRoot!.querySelector('.fill')).toBeNull();
  });

  it('shows as many decimals as the step needs (0.005 keeps three with precision 2)', async () => {
    const field = await mount({ value: 0.015, step: 0.005, precision: 2 });
    expect(field.shadowRoot!.querySelector('.value')!.textContent).toBe('0.015');
  });

  it('arrows in text edit step from the typed text; an untouched blur commits nothing', async () => {
    const field = await mount({ value: 1.234, step: 0.01, precision: 2 });
    const commits: number[] = [];
    field.addEventListener('commit-change', e => commits.push((e as CustomEvent).detail.value));
    key(field.shadowRoot!.querySelector('.field')!, 'keydown', 'Enter');
    await field.updateComplete;
    const input = field.shadowRoot!.querySelector('input')!;
    // The edit text is the stored value, not the rounded display.
    expect(input.value).toBe('1.234');
    input.dispatchEvent(new Event('blur'));
    expect(commits).toEqual([]);

    key(field.shadowRoot!.querySelector('.field')!, 'keydown', 'Enter');
    await field.updateComplete;
    const input2 = field.shadowRoot!.querySelector('input')!;
    input2.value = '2';
    key(input2, 'keydown', 'ArrowUp');
    key(input2, 'keyup', 'ArrowUp');
    expect(input2.value).toBe('2.01');
    expect(commits).toEqual([2.01]);
  });
});

describe('a scrub is a gesture (the idle flush waits for the release)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    appState.ui.gestureInProgress = false;
  });

  const pointer = (type: string, init: Record<string, unknown>): PointerEvent => {
    const event = new MouseEvent(type, { bubbles: true, composed: true, ...init }) as PointerEvent;
    for (const [key, value] of Object.entries(init)) {
      Object.defineProperty(event, key, { value });
    }
    return event;
  };

  it('pix3-number-field: gestureInProgress while dragging, off on release; a plain click is none', async () => {
    const field = document.createElement('pix3-number-field') as NumberField;
    document.body.appendChild(field);
    await field.updateComplete;
    const target = field.shadowRoot!.querySelector('.field') as HTMLElement;
    target.dispatchEvent(pointer('pointerdown', { button: 0, pointerId: 1, movementX: 0 }));
    expect(appState.ui.gestureInProgress).toBe(false);
    target.dispatchEvent(pointer('pointermove', { pointerId: 1, movementX: 12 }));
    expect(appState.ui.gestureInProgress).toBe(true);
    target.dispatchEvent(pointer('pointerup', { pointerId: 1 }));
    expect(appState.ui.gestureInProgress).toBe(false);
    // A click without a drag drops into text edit: no gesture at all.
    target.dispatchEvent(pointer('pointerdown', { button: 0, pointerId: 2, movementX: 0 }));
    target.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
    expect(appState.ui.gestureInProgress).toBe(false);
  });

  it('pix3-slider-number-editor: the range drag is a gesture', async () => {
    const editor = document.createElement('pix3-slider-number-editor') as SliderNumberEditor;
    document.body.appendChild(editor);
    await editor.updateComplete;
    const slider = editor.shadowRoot!.querySelector('.slider') as HTMLElement;
    slider.dispatchEvent(pointer('pointerdown', { button: 0, pointerId: 1 }));
    expect(appState.ui.gestureInProgress).toBe(true);
    slider.dispatchEvent(pointer('pointerup', { pointerId: 1 }));
    expect(appState.ui.gestureInProgress).toBe(false);
  });
});

describe('AnimationResourceEditor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clears the slot with an empty url and offers no Create (the agent writes .pix3anim files)', async () => {
    const editor = document.createElement(
      'pix3-animation-resource-editor'
    ) as AnimationResourceEditor;
    editor.resourceUrl = 'res://animations/hero.pix3anim';

    const onChange = new Promise<string>(resolve => {
      editor.addEventListener(
        'change',
        event => resolve((event as CustomEvent<{ url: string }>).detail.url),
        { once: true }
      );
    });

    document.body.appendChild(editor);
    await editor.updateComplete;

    const buttons = [...(editor.shadowRoot?.querySelectorAll('button') ?? [])];
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['Locate', 'Clear']);

    buttons[1].click();

    expect(await onChange).toBe('');
  });
});
