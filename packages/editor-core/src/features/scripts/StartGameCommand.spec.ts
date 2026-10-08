import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import { appState } from '@/state';
import { OperationService } from '@/services/core/OperationService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

import { StartGameCommand } from './StartGameCommand';
import { SetPlayModeOperation } from './SetPlayModeOperation';
import { resolveGameplayScenePath } from './play-workspace';

// The real EditorTabService pulls in Golden Layout; the specs only need its class as a token.
vi.mock('@/services/editor/EditorTabService', () => ({
  EditorTabService: class EditorTabService {},
}));

/**
 * `game.start` is the prototyping play path (toolbar), so two promises are pinned here: it never
 * moves the active scene when there is one — that field is simultaneously what runs, what the
 * viewport shows and what the agent edits — and it never flips play mode on without one, which used
 * to be possible because its preconditions only checked `isPlaying`.
 */
const invoke = vi.fn(async () => ({ didMutate: true }));
const ensureReady = vi.fn(async () => {});
const focusOrOpenScene = vi.fn(async (_path: string) => {});
const openResourceTab = vi.fn(async () => {});

const createContext = (): CommandContext => {
  const services = new Map<unknown, unknown>([
    [OperationService, { invoke }],
    [ProjectScriptLoaderService, { ensureReady }],
    [EditorTabService, { focusOrOpenScene, openResourceTab }],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) {
        throw new Error(`Unexpected token: ${String(token)}`);
      }
      return services.get(token) as T;
    },
  };
  return {
    state: appState,
    snapshot: { ui: { isPlaying: false } } as unknown as CommandContext['snapshot'],
    container: container as unknown as CommandContext['container'],
    requestedAt: 0,
  };
};

const descriptor = (id: string, filePath: string) =>
  ({
    id,
    filePath,
    name: id,
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
  }) as unknown as (typeof appState.scenes.descriptors)[string];

const createCommand = (): StartGameCommand =>
  new StartGameCommand(
    // Accepted for call-site compatibility and unused (see the command's constructor doc).
    undefined as unknown as ConstructorParameters<typeof StartGameCommand>[0],
    { isPopoutOpen: () => false } as unknown as ConstructorParameters<typeof StartGameCommand>[1]
  );

describe('resolveGameplayScenePath', () => {
  it('prefers the gameplay scene over any other open scene', () => {
    const path = resolveGameplayScenePath({
      scenes: {
        descriptors: {
          'scenes-menu': { filePath: 'res://scenes/menu.pix3scene' },
          'scenes-main': { filePath: 'res://scenes/main.pix3scene' },
        },
      },
    });
    expect(path).toBe('res://scenes/main.pix3scene');
  });

  it('falls back to the first open scene when the project has no gameplay scene', () => {
    const path = resolveGameplayScenePath({
      scenes: { descriptors: { intro: { filePath: 'res://levels/intro.pix3scene' } } },
    });
    expect(path).toBe('res://levels/intro.pix3scene');
  });

  it('names the gameplay scene when nothing is open at all', () => {
    const path = resolveGameplayScenePath({ scenes: { descriptors: {} } });
    expect(path).toBe('res://scenes/main.pix3scene');
  });
});

describe('StartGameCommand', () => {
  beforeEach(() => {
    invoke.mockClear();
    ensureReady.mockClear();
    focusOrOpenScene.mockReset();
    openResourceTab.mockClear();
    appState.ui.isPlaying = false;
    appState.project.status = 'ready';
    appState.scenes.descriptors = {};
    appState.scenes.activeSceneId = null;
  });

  it('opens the gameplay scene when nothing is active, not the configured entry scene', async () => {
    // The entry scene is the menu on every recipe project; picking it here is what used to point the
    // whole prototyping session (stage AND agent edits) at the menu.
    appState.project.manifest = {
      defaultExportScenePath: 'scenes/menu.pix3scene',
    } as unknown as typeof appState.project.manifest;
    focusOrOpenScene.mockImplementation(async () => {
      appState.scenes.activeSceneId = 'scenes-main';
    });

    await createCommand().execute(createContext());

    expect(focusOrOpenScene).toHaveBeenCalledTimes(1);
    expect(focusOrOpenScene).toHaveBeenCalledWith('res://scenes/main.pix3scene');
    expect(invoke).toHaveBeenCalledWith(expect.any(SetPlayModeOperation));
  });

  it('leaves the active scene alone when there already is one', async () => {
    appState.scenes.descriptors = {
      'scenes-menu': descriptor('scenes-menu', 'res://scenes/menu.pix3scene'),
    };
    appState.scenes.activeSceneId = 'scenes-menu';

    await createCommand().execute(createContext());

    // No tab switch: whatever the user is looking at is what plays.
    expect(focusOrOpenScene).not.toHaveBeenCalled();
    expect(appState.scenes.activeSceneId).toBe('scenes-menu');
    expect(invoke).toHaveBeenCalledWith(expect.any(SetPlayModeOperation));
  });

  it('throws instead of flipping play mode on when no scene could be opened', async () => {
    // The tab opened, but no scene became active (the load was refused).
    await expect(createCommand().execute(createContext())).rejects.toThrow(
      /Could not open the scene|no scene could be opened/
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(appState.ui.isPlaying).toBe(false);
  });

  it('refuses to run without an open project', () => {
    appState.project.status = 'idle';

    const result = createCommand().preconditions(createContext());

    expect(result.canExecute).toBe(false);
  });
});
