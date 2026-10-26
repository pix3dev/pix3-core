import { describe, expect, it } from 'vitest';
import {
  configBoolean,
  configColor,
  configNumber,
  configSelect,
  configString,
} from './property-schema';

const script = () => ({ config: {} as Record<string, unknown> });

describe('config* schema helpers', () => {
  it('configNumber clamps, coerces numeric strings and falls back on junk', () => {
    const def = configNumber('speed', 'Speed', 5, { min: 0, max: 10, group: 'Move' });
    const s = script();
    expect(def).toMatchObject({
      name: 'speed',
      type: 'number',
      ui: { label: 'Speed', min: 0, max: 10, group: 'Move' },
    });
    def.setValue(s, 42);
    expect(def.getValue(s)).toBe(10);
    def.setValue(s, '2.5');
    expect(s.config.speed).toBe(2.5);
    def.setValue(s, 'fast');
    expect(s.config.speed).toBe(5);
    def.setValue(s, '');
    expect(s.config.speed).toBe(5);
  });

  it('string, colour, boolean and select coerce to their type', () => {
    const s = script();
    configString('target', 'Target', 'root', undefined, 'node').setValue(s, 7);
    expect(s.config.target).toBe('7');
    configColor('tint', 'Tint', '#ff0000').setValue(s, '');
    expect(s.config.tint).toBe('#ff0000');
    configBoolean('loop', 'Loop').setValue(s, 'true');
    expect(s.config.loop).toBe(true);
    const mode = configSelect('mode', 'Mode', ['easy', 'hard'], 'easy');
    expect(mode.ui?.options).toEqual(['easy', 'hard']);
    mode.setValue(s, 'insane');
    expect(s.config.mode).toBe('easy');
  });
});
