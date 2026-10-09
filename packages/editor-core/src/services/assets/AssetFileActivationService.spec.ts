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

const createService = () => {
  const service = new AssetFileActivationService();
  const editorTabService = { focusOrOpenScene: vi.fn().mockResolvedValue(undefined) };
  const lightbox = { open: vi.fn() };
  Object.defineProperty(service, 'editorTabService', { value: editorTabService });
  Object.defineProperty(service, 'lightbox', { value: lightbox });
  return { service, editorTabService, lightbox };
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

  it('does nothing for scripts, text, animation and audio files', async () => {
    const { service, editorTabService, lightbox } = createService();
    for (const path of [
      'scripts/player.ts',
      'config.json',
      'README.md',
      'assets/walk.pix3anim',
      'audio/sound.wav',
    ]) {
      await service.handleActivation(activation(path));
    }
    expect(editorTabService.focusOrOpenScene).not.toHaveBeenCalled();
    expect(lightbox.open).not.toHaveBeenCalled();
  });
});
