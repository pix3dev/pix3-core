import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HapticsApi, setHapticsAdapter, type HapticKind } from './HapticsApi';

describe('HapticsApi (scene.haptics)', () => {
  let calls: unknown[];
  let now: number;
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    calls = [];
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    saved = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        calls.push(pattern);
        return true;
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setHapticsAdapter(null);
    if (saved) Object.defineProperty(navigator, 'vibrate', saved);
    else delete (navigator as { vibrate?: unknown }).vibrate;
  });

  it('plays a kind as its navigator.vibrate pattern; selection is too short for a motor', () => {
    const haptics = new HapticsApi();
    expect(haptics.available).toBe(true);
    expect(haptics.play('selection')).toBe(false);
    expect(haptics.play('light')).toBe(true);
    now += 100;
    expect(haptics.play('success')).toBe(true);
    expect(calls).toEqual([10, [20, 50, 20, 50, 60]]);
  });

  it('drops a pulse no heavier than one under 60 ms ago, lets a heavier one through', () => {
    const haptics = new HapticsApi();
    expect(haptics.play('medium')).toBe(true);
    now += 30;
    expect(haptics.play('medium')).toBe(false);
    expect(haptics.play('light')).toBe(false);
    expect(haptics.play('heavy')).toBe(true);
    now += 59;
    expect(haptics.play('heavy')).toBe(false);
    now += 1;
    expect(haptics.play('light')).toBe(true);
    expect(calls).toEqual([20, 35, 10]);
  });

  it('setEnabled(false) silences play and vibrate and stops what is playing', () => {
    const haptics = new HapticsApi();
    haptics.setEnabled(false);
    expect(haptics.isEnabled).toBe(false);
    expect(haptics.play('heavy')).toBe(false);
    expect(haptics.vibrate(30)).toBe(false);
    expect(calls).toEqual([0]);
    haptics.setEnabled(true);
    expect(haptics.vibrate(30)).toBe(true);
  });

  it('an adapter gets every kind (selection too) and the raw patterns; a throwing one is false', () => {
    const played: Array<HapticKind | number | readonly number[]> = [];
    setHapticsAdapter({
      play: kind => played.push(kind),
      vibrate: pattern => played.push(pattern),
    });
    const haptics = new HapticsApi();
    expect(haptics.play('selection')).toBe(true);
    now += 100;
    expect(haptics.play('error')).toBe(true);
    expect(haptics.vibrate([5, 5])).toBe(true);
    expect(played).toEqual(['selection', 'error', [5, 5]]);
    expect(calls).toEqual([]);
    setHapticsAdapter({
      play: () => {
        throw new Error('no engine');
      },
      vibrate: () => undefined,
    });
    now += 100;
    expect(haptics.play('heavy')).toBe(false);
  });

  it('nothing to buzz on: unavailable and a quiet false; a hidden tab plays nothing', () => {
    const haptics = new HapticsApi();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(haptics.play('heavy')).toBe(false);
    visibility.mockRestore();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
    expect(haptics.available).toBe(false);
    expect(haptics.play('heavy')).toBe(false);
    expect(calls).toEqual([]);
  });
});
