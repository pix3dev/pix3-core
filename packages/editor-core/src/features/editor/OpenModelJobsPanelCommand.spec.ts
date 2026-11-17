import { describe, expect, it, vi } from 'vitest';

// golden-layout's CJS build needs `tslib`, which the workspace does not install.
vi.mock('golden-layout', () => ({ GoldenLayout: class {} }));

import { PANEL_DISPLAY_TITLES } from '@/core/LayoutManager';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { OpenGeneratePanelCommand } from './OpenGeneratePanelCommand';
import { OpenModelJobsPanelCommand } from './OpenModelJobsPanelCommand';

describe('Window → 3D Asset Generator', () => {
  it('sits right after Asset Generator in the Window menu and reads like its tab', () => {
    const registry = new CommandRegistry(new KeybindingService());
    registry.registerMany(new OpenGeneratePanelCommand(), new OpenModelJobsPanelCommand());
    const [section] = registry.buildMenuSections();
    expect(section.id).toBe('window');
    expect(section.items.map(item => [item.label, item.menuOrder])).toEqual([
      ['Asset Generator', 310],
      ['3D Asset Generator', 311],
    ]);
    expect(PANEL_DISPLAY_TITLES['model-jobs']).toBe('3D Asset Generator');
  });

  it('opens or focuses the model-jobs panel', async () => {
    const command = new OpenModelJobsPanelCommand();
    const showPanel = vi.fn();
    Object.defineProperty(command, 'layoutManager', { value: { showPanel } });
    await expect(command.execute()).resolves.toMatchObject({ didMutate: false });
    expect(showPanel).toHaveBeenCalledWith('model-jobs');
  });
});
