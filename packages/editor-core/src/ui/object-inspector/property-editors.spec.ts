import { afterEach, describe, expect, it } from 'vitest';

import './property-editors';

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
