import { describe, expect, it, beforeEach } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import {
  EDITOR_SETTINGS_STORAGE_KEY,
  UpdateEditorSettingsOperation,
  loadEditorSettings,
} from './UpdateEditorSettingsOperation';

const createStorageStub = (): Storage => {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
};

const operationWith = (
  context: OperationContext,
  params: ConstructorParameters<typeof UpdateEditorSettingsOperation>[0]
) => new UpdateEditorSettingsOperation(params).perform(context);

describe('UpdateEditorSettingsOperation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorageStub(),
      configurable: true,
      writable: true,
    });
  });

  it('ignores settings an older editor stored (gameAspectRatio, playHost — plan play-in-page S6)', () => {
    localStorage.setItem(
      EDITOR_SETTINGS_STORAGE_KEY,
      JSON.stringify({ pauseRenderingOnUnfocus: false, gameAspectRatio: '4:3', playHost: 'editor' })
    );
    expect(loadEditorSettings()).toEqual({ pauseRenderingOnUnfocus: false });
  });

  it('persists the agent keepalive switch (default on) and supports undo', async () => {
    const state = createInitialAppState();
    expect(state.ui.keepEditorRunningForAgent).toBe(true);
    const context = {
      state,
      snapshot: structuredClone(state),
      container: {} as OperationContext['container'],
      requestedAt: Date.now(),
    } as OperationContext;

    const result = await operationWith(context, { keepEditorRunningForAgent: false });
    expect(state.ui.keepEditorRunningForAgent).toBe(false);
    expect(loadEditorSettings()?.keepEditorRunningForAgent).toBe(false);
    expect(localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY)).toContain(
      '"keepEditorRunningForAgent":false'
    );

    if (!result.didMutate || !result.commit) throw new Error('expected a mutation');
    await result.commit.undo();
    expect(state.ui.keepEditorRunningForAgent).toBe(true);
  });
});
