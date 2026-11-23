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

  it('records every call with its frame and result, whether or not anything buzzed', () => {
    let frame = 3;
    const haptics = new HapticsApi(() => frame);
    expect(haptics.play('medium')).toBe(true);
    now += 10;
    frame = 4;
    expect(haptics.play('light')).toBe(false);
    now += 100;
    haptics.play('selection');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    haptics.vibrate(30);
    visibility.mockRestore();
    haptics.setEnabled(false);
    frame = 5;
    haptics.play('heavy');
    haptics.setEnabled(true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
    expect(haptics.play('heavy')).toBe(false);
    expect(haptics.runReport()).toEqual({
      calls: 6,
      byKind: { medium: 1, light: 1, selection: 1, vibrate: 1, heavy: 2 },
      byResult: { played: 1, throttled: 1, unavailable: 2, hidden: 1, off: 1 },
      eventsDropped: 0,
      events: [
        { kind: 'medium', result: 'played', frame: 3 },
        { kind: 'light', result: 'throttled', frame: 4 },
        { kind: 'selection', result: 'unavailable', frame: 4 },
        { kind: 'vibrate', result: 'hidden', frame: 4 },
        { kind: 'heavy', result: 'off', frame: 5 },
        { kind: 'heavy', result: 'unavailable', frame: 5 },
      ],
    });
  });

  it('a throwing adapter is unavailable; stop() is not a call; the event list is bounded', () => {
    setHapticsAdapter({
      play: () => {
        throw new Error('no engine');
      },
      vibrate: () => undefined,
    });
    const haptics = new HapticsApi();
    haptics.play('heavy');
    haptics.stop();
    expect(haptics.runReport().byResult).toEqual({ unavailable: 1 });
    for (let i = 0; i < 600; i += 1) haptics.vibrate(5);
    const report = haptics.runReport();
    expect(report.calls).toBe(601);
    expect(report.byResult).toEqual({ unavailable: 1, played: 600 });
    expect(report.events).toHaveLength(500);
    expect(report.eventsDropped).toBe(101);
    expect(report.events[0]).toEqual({ kind: 'vibrate', result: 'played', frame: 0 });
  });
});
