import { afterEach, describe, expect, it, vi } from 'vitest';

import { Node2D } from '../nodes/Node2D';
import { AppApi } from './AppApi';
import type { AppLifecycleChange } from './AppLifecycle';
import { Script } from './ScriptComponent';

const background: AppLifecycleChange = { state: 'background', stateChanged: true, awayMs: 0 };
const foreground: AppLifecycleChange = { state: 'active', stateChanged: true, awayMs: 1200 };

class Listener extends Script {
  readonly heard: string[] = [];
  constructor() {
    super('listener', 'Listener');
  }
}

describe('scene.app (AppApi)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onBackground / onForeground with awayMs, and only on a state change', () => {
    const app = new AppApi();
    const heard: string[] = [];
    const owner = {};
    app.onBackground(owner, ({ awayMs }) => heard.push(`bg ${awayMs}`));
    app.onForeground(owner, ({ awayMs }) => heard.push(`fg ${awayMs}`));

    app.notify(background);
    app.notify({ state: 'background', stateChanged: false, awayMs: 0 });
    app.notify(foreground);

    expect(heard).toEqual(['bg 0', 'fg 1200']);
  });

  it('a subscription dies with its script (removeComponent), or by its returned function', () => {
    const app = new AppApi();
    const node = new Node2D({ id: 'n' });
    const script = new Listener();
    node.addComponent(script);
    app.onForeground(script, () => script.heard.push('fg'));
    const other = { heard: [] as string[] };
    const off = app.onForeground(other, () => other.heard.push('fg'));

    node.removeComponent(script);
    off();
    app.notify(foreground);

    expect(script.heard).toEqual([]);
    expect(other.heard).toEqual([]);
  });

  it('clear() (session end) drops every subscription and back handler', () => {
    const app = new AppApi();
    const heard: string[] = [];
    app.onForeground({}, () => heard.push('fg'));
    app.pushBack({}, () => true);

    app.clear();
    app.notify(foreground);

    expect(heard).toEqual([]);
    expect(app.handleBack()).toBe(false);
  });

  it('back goes to the top handler first, down until one handles it; an empty stack is false', () => {
    const app = new AppApi();
    const owner = {};
    const calls: string[] = [];
    app.pushBack(owner, () => {
      calls.push('screen');
      return true;
    });
    const popPopup = app.pushBack(owner, () => {
      calls.push('popup');
      return false;
    });

    expect(app.handleBack()).toBe(true);
    expect(calls).toEqual(['popup', 'screen']);

    popPopup();
    popPopup();
    expect(app.handleBack()).toBe(true);
    expect(calls).toEqual(['popup', 'screen', 'screen']);

    const empty = new AppApi();
    expect(empty.handleBack()).toBe(false);
  });

  it('a back handler dies with its owner', () => {
    const app = new AppApi();
    const node = new Node2D({ id: 'n' });
    const script = new Listener();
    node.addComponent(script);
    app.pushBack(script, () => true);

    node.removeComponent(script);

    expect(app.handleBack()).toBe(false);
  });

  it('the history guard: off by default, armed lazily, an unhandled back is ordinary navigation', () => {
    const pushState = vi.spyOn(history, 'pushState');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    const app = new AppApi();
    const owner = {};
    app.pushBack(owner, () => true);
    expect(pushState).not.toHaveBeenCalled();

    app.setHistoryGuard(true);
    expect(pushState).not.toHaveBeenCalled();
    const pop = app.pushBack(owner, () => true);
    expect(pushState).toHaveBeenCalledTimes(1);

    // Handled: the guard entry is put back.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(back).not.toHaveBeenCalled();

    // Nobody handles it: the step back goes through and the guard is gone.
    app.clear();
    app.setHistoryGuard(true);
    const nobody = app.pushBack(owner, () => false);
    pushState.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(back).toHaveBeenCalledTimes(1);

    pop();
    nobody();
    app.setHistoryGuard(false);
  });
});
