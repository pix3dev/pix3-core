import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appState, resetAppState } from '@/state';
import { isBlockedForNonOwner } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from '@/features/viewport/ToggleUIFlagOperation';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';
import { SetPlayPausedOperation } from '@/features/scripts/SetPlayPausedOperation';
import { SetGamePopoutWindowOpenOperation } from '@/features/scripts/SetGamePopoutWindowOpenOperation';

/**
 * A tab that is not the writer keeps navigation, view toggles, panels and play. The allowlists
 * once named 1.x ids (`viewport.toggle-grid`, `scripts.set-play-mode`) that no command or
 * operation carries, so such a tab could not toggle the grid, open a panel or start play.
 */
describe('read-only tab', () => {
  let service: OperationService;

  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    appState.project.host.writer = 'other';
    service = new OperationService();
  });

  afterEach(() => {
    service.dispose();
    resetAppState();
  });

  it('runs view, window and play commands, refuses edits', () => {
    for (const id of ['view.toggle-grid', 'view.zoom-in', 'window.show-logs', 'game.start']) {
      expect(isBlockedForNonOwner(id), id).toBe(false);
    }
    for (const id of ['scene.delete-objects', 'history.undo', 'editor.save-active-resource']) {
      expect(isBlockedForNonOwner(id), id).toBe(true);
    }
  });

  it('performs view-flag and play-mode operations', async () => {
    const before = appState.ui.showGrid;
    await service.invoke(new ToggleUIFlagOperation('showGrid', 'Toggle Grid'));
    expect(appState.ui.showGrid).toBe(!before);

    for (const operation of [
      new SetPlayModeOperation({ isPlaying: true, status: 'playing' }),
      new SetPlayPausedOperation({ paused: true }),
      new SetGamePopoutWindowOpenOperation({ isOpen: true }),
    ]) {
      await expect(service.invoke(operation), operation.metadata.id).resolves.toBeDefined();
    }
  });

  it('refuses a document operation', async () => {
    await expect(
      service.invoke({
        metadata: { id: 'scene.update-object-property', title: 'Edit' },
        perform: () => ({ didMutate: true }),
      })
    ).rejects.toThrow(/read-only/);
  });
});
