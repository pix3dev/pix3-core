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
