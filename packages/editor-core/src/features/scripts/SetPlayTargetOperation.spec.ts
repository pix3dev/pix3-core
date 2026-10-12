import { afterEach, describe, expect, it } from 'vitest';

import { appState, getAppStateSnapshot } from '@/state';

import {
  loadPlayTarget,
  PLAY_TARGET_STORAGE_KEY,
  SetPlayTargetOperation,
} from './SetPlayTargetOperation';

const perform = (operation: SetPlayTargetOperation) =>
  operation.perform({ state: appState, snapshot: getAppStateSnapshot() } as Parameters<
    SetPlayTargetOperation['perform']
  >[0]);

afterEach(() => {
  appState.ui.playTarget = 'tab';
  localStorage.removeItem(PLAY_TARGET_STORAGE_KEY);
});

describe('SetPlayTargetOperation', () => {
  it('sets and persists the mode without an undo entry', async () => {
    const result = await perform(new SetPlayTargetOperation({ target: 'window' }));
    expect(result).toEqual({ didMutate: true });
    expect(appState.ui.playTarget).toBe('window');
    expect(loadPlayTarget()).toBe('window');
    expect(await perform(new SetPlayTargetOperation({ target: 'window' }))).toEqual({
      didMutate: false,
    });
  });

  it('ignores a stored value that is not a mode', () => {
    localStorage.setItem(PLAY_TARGET_STORAGE_KEY, 'remote');
    expect(loadPlayTarget()).toBeNull();
  });
});
