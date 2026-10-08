import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AssetFileActivationService,
  type AssetActivation,
} from '@/services/assets/AssetFileActivationService';

// golden-layout's CJS build (what Node resolves in specs) requires `tslib`, which it does not
// declare and the workspace does not install; nothing here needs a real layout.
vi.mock('golden-layout', () => ({ GoldenLayout: class {} }));

const activation = (path: string): AssetActivation => {
  const name = path.split('/').pop() ?? path;
  return {
    name,
    path,
    kind: 'file',
    resourcePath: `res://${path}`,
    extension: name.split('.').pop()?.toLowerCase() ?? '',
  };
};

const createService = (options: { ideAvailable?: boolean } = {}) => {
  const service = new AssetFileActivationService();
  const editorTabService = { focusOrOpenScene: vi.fn().mockResolvedValue(undefined) };
  const ideLauncher = {
    available: options.ideAvailable ?? true,
    open: vi.fn().mockResolvedValue(options.ideAvailable ?? true),
  };
  const lightbox = { open: vi.fn() };
  Object.defineProperty(service, 'editorTabService', { value: editorTabService });
  Object.defineProperty(service, 'ideLauncher', { value: ideLauncher });
  Object.defineProperty(service, 'lightbox', { value: lightbox });
  return { service, editorTabService, ideLauncher, lightbox };
};

describe('AssetFileActivationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens scenes in an editor tab', async () => {
    const { service, editorTabService } = createService();
    await service.handleActivation(activation('scenes/main.pix3scene'));
    expect(editorTabService.focusOrOpenScene).toHaveBeenCalledWith('res://scenes/main.pix3scene');
  });

  it('opens scripts, config and text files in the IDE', async () => {
    const { service, ideLauncher } = createService();
    for (const path of ['scripts/player.ts', 'config.json', 'README.md', 'settings.yaml']) {
      await service.handleActivation(activation(path));
    }
    expect(ideLauncher.open.mock.calls.map(call => call[0])).toEqual([
      'res://scripts/player.ts',
      'res://config.json',
      'res://README.md',
      'res://settings.yaml',
    ]);
  });

  it('opens .pix3anim documents in the IDE (no in-browser animation editor in 2.x)', async () => {
    const { service, ideLauncher } = createService();
    await service.handleActivation(activation('assets/walk.pix3anim'));
    expect(ideLauncher.open).toHaveBeenCalledWith('res://assets/walk.pix3anim');
  });

  it('does nothing for a text file when the host has no IDE hook', async () => {
    const { service, ideLauncher } = createService({ ideAvailable: false });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await service.handleActivation(activation('scripts/player.ts'));
    expect(ideLauncher.open).toHaveBeenCalledTimes(1);
  });

  it('does not route binary assets to the IDE', async () => {
    const { service, ideLauncher, lightbox } = createService();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await service.handleActivation(activation('audio/sound.wav'));
    expect(ideLauncher.open).not.toHaveBeenCalled();
    expect(lightbox.open).not.toHaveBeenCalled();
  });
});
