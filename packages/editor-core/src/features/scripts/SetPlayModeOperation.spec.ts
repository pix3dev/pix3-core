import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@/core/Operation';
import { appState, resetAppState } from '@/state';

import { SetPlayModeOperation } from './SetPlayModeOperation';

const perform = (operation: SetPlayModeOperation) => operation.perform(createOperationContext());

/** `playOwner`/`playStartedAt` are what the debug bridge's owner rules (plan §B.3) read. */
describe('SetPlayModeOperation — play owner', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAppState();
  });

  it('records the designer as owner, with the start time, when play starts from the UI', async () => {
    vi.useFakeTimers({ now: 1_000 });
    await perform(new SetPlayModeOperation({ isPlaying: true, status: 'playing' }));
    expect(appState.ui.playOwner).toBe('designer');
    expect(appState.ui.playStartedAt).toBe(1_000);
  });

  it('records the agent when the caller says so', async () => {
    await perform(new SetPlayModeOperation({ isPlaying: true, status: 'playing', owner: 'agent' }));
    expect(appState.ui.playOwner).toBe('agent');
  });

  it('keeps owner and start time across a pause, clears both on stop, and undo restores them', async () => {
    vi.useFakeTimers({ now: 5 });
    await perform(new SetPlayModeOperation({ isPlaying: true, status: 'playing', owner: 'agent' }));
    vi.setSystemTime(50);
    await perform(new SetPlayModeOperation({ isPlaying: true, status: 'paused' }));
    expect(appState.ui.playOwner).toBe('agent');
    expect(appState.ui.playStartedAt).toBe(5);

    const stop = await perform(new SetPlayModeOperation({ isPlaying: false, status: 'stopped' }));
    expect(appState.ui.playOwner).toBeNull();
    expect(appState.ui.playStartedAt).toBeNull();

    await stop.commit?.undo();
    expect(appState.ui.playOwner).toBe('agent');
    expect(appState.ui.playStartedAt).toBe(5);
  });
});
