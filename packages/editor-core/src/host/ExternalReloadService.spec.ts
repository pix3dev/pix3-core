import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader, getProjectTextureFiltering } from '@pix3/runtime';

import { ServiceContainer } from '@/fw/di';
import { ExternalReloadService } from '@/host/ExternalReloadService';
import { HostService } from '@/host/HostService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { resetAppState } from '@/state';

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;

afterEach(async () => {
  await handle?.dispose();
  handle = null;
  HostService.reset();
  resetAppState();
  vi.restoreAllMocks();
});

describe('ExternalReloadService', () => {
  // `reapply2DTextureFiltering` had no caller: an agent switching the project to pixel-art
  // filtering left every texture on screen smoothed until the editor reloaded.
  it('a changed pix3project.yaml re-filters the textures on screen', async () => {
    resetAppState();
    const manifest = (filtering: string) =>
      `version: 1.0.0\ntextureFiltering: ${filtering}\nmetadata:\n  projectId: p-1\n`;
    const host = new FakeHost({ files: { 'pix3project.yaml': manifest('linear') } });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
    const reapply = vi
      .spyOn(ViewportRendererService.prototype, 'reapply2DTextureFiltering')
      .mockImplementation(() => undefined);

    await host.externalWrite('pix3project.yaml', manifest('nearest'));
    await service(ExternalReloadService).apply(['pix3project.yaml']);

    expect(getProjectTextureFiltering()).toBe('nearest');
    expect(reapply).toHaveBeenCalledTimes(1);
  });

  // An agent regenerating a sprite: the viewport kept the decoded copy until the editor reloaded.
  it('a changed image evicts the decoded texture and repaints the nodes drawn from it', async () => {
    resetAppState();
    const host = new FakeHost({ files: { 'pix3project.yaml': 'version: 1.0.0\n' } });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
    const evict = vi.spyOn(AssetLoader.prototype, 'evictTexture');
    const invalidate = vi
      .spyOn(ViewportRendererService.prototype, 'invalidateTexture')
      .mockImplementation(() => undefined);

    await service(ExternalReloadService).apply(['sprites/hero.PNG', 'notes.txt', 'scripts/a.ts']);

    expect(evict.mock.calls).toEqual([['res://sprites/hero.PNG']]);
    expect(invalidate.mock.calls).toEqual([['res://sprites/hero.PNG']]);
  });
});
