import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import type { HostService } from '@/host/HostService';
import type { FlushService } from '@/services/project/FlushService';
import { appState, getAppStateSnapshot } from '@/state';

import { DEBUG_WINDOW_NAME, OpenDebugWindowCommand } from './OpenDebugWindowCommand';

const context = (): CommandContext =>
  ({
    state: appState,
    snapshot: getAppStateSnapshot(),
    container: {} as CommandContext['container'],
    requestedAt: 0,
  }) as CommandContext;

const make = (base = '/') => {
  const order: string[] = [];
  const flushDirty = vi.fn(async () => {
    order.push('flush');
    return { ok: true };
  });
  const openWindow = vi.fn((_url: string, _target: string): Window | null => {
    order.push('open');
    return {} as Window;
  });
  const command = new OpenDebugWindowCommand(
    { info: { base } } as unknown as HostService,
    { flushDirty } as unknown as FlushService,
    openWindow
  );
  return { command, flushDirty, openWindow, order };
};

afterEach(() => {
  appState.project.status = 'idle';
});

describe('OpenDebugWindowCommand', () => {
  it('needs an open project', () => {
    appState.project.status = 'idle';
    expect(make().command.preconditions(context()).canExecute).toBe(false);
    appState.project.status = 'ready';
    expect(make().command.preconditions(context()).canExecute).toBe(true);
  });

  it('flushes the dirty scenes, then opens the game page with ?debug in its one window', async () => {
    const { command, openWindow, order } = make('/game/');
    await command.execute();
    expect(order).toEqual(['flush', 'open']);
    expect(openWindow).toHaveBeenCalledWith(
      `${window.location.origin}/game/?debug`,
      DEBUG_WINDOW_NAME
    );
  });

  it('still opens the page when the flush fails', async () => {
    const { command, flushDirty, openWindow } = make();
    flushDirty.mockRejectedValueOnce(new Error('offline'));
    await command.execute();
    expect(openWindow).toHaveBeenCalledTimes(1);
  });
});
