import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANALYTICS_BUFFER_SIZE, AnalyticsApi, type AnalyticsEvent } from './AnalyticsApi';
import { appLifecycle } from './AppLifecycle';

let frame = 0;
const apis: AnalyticsApi[] = [];
const make = (): AnalyticsApi => {
  const api = new AnalyticsApi(() => frame);
  apis.push(api);
  return api;
};

afterEach(() => {
  for (const api of apis.splice(0)) api.dispose();
  vi.restoreAllMocks();
  frame = 0;
});

const names = (events: readonly AnalyticsEvent[]): string[] => events.map(e => e.name);

describe('scene.analytics', () => {
  it('buffers events until the first sink, then hands them over in order', () => {
    const api = make();
    frame = 4;
    api.track('boot');
    api.track('level_start', { level: 1 });
    const seen: AnalyticsEvent[] = [];
    api.addSink({ track: e => seen.push(e) });
    api.track('level_end');
    expect(names(seen)).toEqual(['boot', 'level_start', 'level_end']);
    expect(seen[1]).toEqual({ name: 'level_start', props: { level: 1 }, frame: 4 });

    // A later sink gets only what comes after it.
    const late: AnalyticsEvent[] = [];
    api.addSink({ track: e => late.push(e) });
    api.track('tap');
    expect(names(late)).toEqual(['tap']);
  });

  it('the pre-sink buffer drops the oldest past its size and counts them', () => {
    const api = make();
    for (let i = 0; i < ANALYTICS_BUFFER_SIZE + 3; i += 1) api.track(`e${i}`);
    expect(api.dropped).toBe(3);
    const seen: AnalyticsEvent[] = [];
    api.addSink({ track: e => seen.push(e) });
    expect(seen).toHaveLength(ANALYTICS_BUFFER_SIZE);
    expect(seen[0].name).toBe('e3');
    expect(api.runReport()).toMatchObject({ total: ANALYTICS_BUFFER_SIZE + 3, dropped: 3 });
  });

  it('copies props, so a later mutation by the game does not rewrite a sent event', () => {
    const api = make();
    const props = { coins: 1 };
    api.track('buy', props);
    props.coins = 99;
    expect(api.runReport().events[0].props).toEqual({ coins: 1 });
  });

  it('a throwing sink is reported once and neither the game nor the other sinks notice', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = make();
    const seen: string[] = [];
    api.addSink({
      track: () => {
        throw new Error('vendor down');
      },
      setUserProps: () => {
        throw new Error('vendor down');
      },
    });
    api.addSink({ track: e => seen.push(e.name) });
    expect(() => {
      api.track('a');
      api.track('b');
      api.setUserProps({ cohort: 'x' });
    }).not.toThrow();
    expect(seen).toEqual(['a', 'b']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('merges user props and gives every sink the merged set, a new one on add', () => {
    const api = make();
    const first = vi.fn();
    api.addSink({ track: () => {}, setUserProps: first });
    api.setUserProps({ level: 1 });
    api.setUserProps({ cohort: 'b' });
    expect(first).toHaveBeenLastCalledWith({ level: 1, cohort: 'b' });
    const second = vi.fn();
    api.addSink({ track: () => {}, setUserProps: second });
    expect(second).toHaveBeenCalledWith({ level: 1, cohort: 'b' });
  });

  it('defineEvents warns once per unknown name and still tracks it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = make();
    api.defineEvents(['level_start']);
    api.track('level_start');
    api.track('levle_start');
    api.track('levle_start');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('levle_start');
    expect(api.runReport().total).toBe(3);
  });

  it('flushes the sinks when the app goes to the background, and a failed flush is isolated', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = make();
    const flush = vi.fn();
    api.addSink({ track: () => {}, flush });
    api.addSink({ track: () => {}, flush: () => Promise.reject(new Error('offline')) });
    appLifecycle.simulateBackground(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a removed sink hears nothing more', () => {
    const api = make();
    const track = vi.fn();
    const remove = api.addSink({ track });
    remove();
    api.track('a');
    expect(track).not.toHaveBeenCalled();
  });
});
