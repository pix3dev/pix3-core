import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppLifecycle, type AppLifecycleChange } from './AppLifecycle';

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

const setVisibility = (state: DocumentVisibilityState): void => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('AppLifecycle', () => {
  let lifecycle: AppLifecycle;
  let changes: AppLifecycleChange[];
  let unsubscribe: () => void;

  beforeEach(() => {
    visibility = 'visible';
    focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    lifecycle = new AppLifecycle();
    changes = [];
    unsubscribe = lifecycle.subscribe(change => changes.push(change));
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it('collapses visibilitychange + pagehide into one background transition', () => {
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));

    expect(changes).toEqual([{ state: 'background', stateChanged: true, awayMs: 0 }]);
    expect(lifecycle.visible).toBe(false);
  });

  it('a bfcache return (pageshow) is a foreground with the time away', () => {
    window.dispatchEvent(new Event('pagehide'));
    vi.mocked(performance.now).mockReturnValue(5000);
    window.dispatchEvent(new Event('pageshow'));

    expect(changes.map(change => [change.state, change.awayMs])).toEqual([
      ['background', 0],
      ['active', 4000],
    ]);
  });

  it('freeze / resume count as hidden / visible', () => {
    document.dispatchEvent(new Event('freeze'));
    document.dispatchEvent(new Event('resume'));
    expect(changes.map(change => change.state)).toEqual(['background', 'active']);
  });

  it('focus is separate from the state: a blur of a visible page is not a background', () => {
    focused = false;
    window.dispatchEvent(new Event('blur'));

    expect(changes).toEqual([{ state: 'active', stateChanged: false, awayMs: 0 }]);
    expect(lifecycle.focused).toBe(false);
    expect(lifecycle.state).toBe('active');
  });

  it('a held page stays active and says nothing about the state while hidden', () => {
    lifecycle.setHeld(true);
    setVisibility('hidden');

    expect(lifecycle.state).toBe('active');
    expect(changes.every(change => !change.stateChanged)).toBe(true);

    lifecycle.setHeld(false);
    expect(changes.at(-1)).toMatchObject({ state: 'background', stateChanged: true });
  });

  it('simulateBackground is a round trip with the asked awayMs, even while held', () => {
    lifecycle.setHeld(true);
    const seenFocused: boolean[] = [];
    lifecycle.subscribe(() => seenFocused.push(lifecycle.focused));

    lifecycle.simulateBackground(2500);

    expect(changes.map(change => [change.state, change.awayMs])).toEqual([
      ['background', 0],
      ['active', 2500],
    ]);
    expect(seenFocused).toEqual([false, true]);
  });

  it('removes its DOM listeners with the last subscriber', () => {
    unsubscribe();
    setVisibility('hidden');
    expect(changes).toEqual([]);
    // Read live while nobody listens.
    expect(lifecycle.state).toBe('background');
  });
});
