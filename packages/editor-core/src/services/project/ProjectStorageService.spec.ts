import { afterEach, describe, expect, it } from 'vitest';

import { HostService } from '@/host/HostService';
import { FakeHost, FakeHostError } from '@/host/testing/fake-host';
import { appState, resetAppState } from '@/state';

import { ProjectStorageService } from './ProjectStorageService';
import { ReadOnlyTabError, SceneWriteConflictError } from './write-errors';

const SCENE = 'version: 1.0.0\nroot: []\n';

const setup = async (options: ConstructorParameters<typeof FakeHost>[0] = {}) => {
  resetAppState();
  const host = new FakeHost(options);
  await host.whenReady();
  HostService.install(host);
  return { host, storage: new ProjectStorageService() };
};

afterEach(() => {
  HostService.reset();
});

describe('ProjectStorageService over EditorHost', () => {
  it('lists a directory from the host manifest, folders and files, with project paths', async () => {
    const { storage } = await setup({
      files: { 'scenes/a.pix3scene': SCENE, 'scenes/ui/hud.pix3scene': SCENE, 'b.png': 'x' },
    });
    const root = await storage.listDirectory('.');
    expect(root.map(entry => [entry.path, entry.kind])).toEqual([
      ['b.png', 'file'],
      ['scenes', 'directory'],
    ]);
    const scenes = await storage.listDirectory('res://scenes');
    expect(scenes.map(entry => entry.name)).toEqual(['a.pix3scene', 'ui']);
    expect(await storage.fileExists('res://scenes/a.pix3scene')).toBe(true);
    expect(await storage.fileExists('scenes')).toBe(false);
  });

  it('writes conditionally on the last bytes it read, and refuses an outside change', async () => {
    const { host, storage } = await setup({ files: { 'scenes/a.pix3scene': SCENE } });
    expect(await storage.readTextFile('res://scenes/a.pix3scene')).toBe(SCENE);
    await storage.writeTextFile('res://scenes/a.pix3scene', `${SCENE}# v2\n`);
    expect(host.text('scenes/a.pix3scene')).toBe(`${SCENE}# v2\n`);

    await host.externalWrite('scenes/a.pix3scene', `${SCENE}# agent\n`);
    await expect(
      storage.writeTextFile('scenes/a.pix3scene', `${SCENE}# mine\n`)
    ).rejects.toBeInstanceOf(SceneWriteConflictError);
    expect(host.text('scenes/a.pix3scene')).toBe(`${SCENE}# agent\n`);
  });

  it('maps res:// under resRoot, and keeps the manifest and scripts root-relative', async () => {
    const { host, storage } = await setup({
      resRoot: 'src/assets',
      files: {
        'pix3project.yaml': 'version: 1\n',
        'src/assets/scenes/main.pix3scene': SCENE,
        'src/scripts/Spin.ts': 'export {}',
      },
    });
    expect(await storage.readTextFile('res://scenes/main.pix3scene')).toBe(SCENE);
    expect(await storage.readTextFile('pix3project.yaml')).toBe('version: 1\n');
    expect((await storage.listDirectory('.')).map(entry => entry.path)).toEqual(['scenes']);
    await storage.writeTextFile('res://scenes/new.pix3scene', SCENE);
    expect(host.text('src/assets/scenes/new.pix3scene')).toBe(SCENE);
  });

  it('patches the listing from pix3:fs frames and signals the asset browser', async () => {
    const { host, storage } = await setup({ files: { 'scenes/a.pix3scene': SCENE } });
    await storage.listDirectory('.');
    const signal = appState.project.fileRefreshSignal;
    host.events.onFs(frame => storage.applyFrame(frame));
    await host.externalWrite('scenes/b.pix3scene', SCENE);
    expect((await storage.listDirectory('scenes')).map(entry => entry.name)).toEqual([
      'a.pix3scene',
      'b.pix3scene',
    ]);
    expect(appState.project.fileRefreshSignal).toBeGreaterThan(signal);
    expect(appState.project.lastModifiedDirectoryPath).toBe('scenes');
  });

  it('turns writer_superseded into ReadOnlyTabError', async () => {
    const { host, storage } = await setup();
    host.files.write = async () => {
      throw new FakeHostError('writer_superseded', 409, 'another tab writes');
    };
    await expect(storage.writeTextFile('a.txt', 'x')).rejects.toBeInstanceOf(ReadOnlyTabError);
  });

  it('moves a file and keeps its known hash under the new path', async () => {
    const { host, storage } = await setup({ files: { 'a/one.png': 'png' } });
    await storage.readBlob('a/one.png');
    const hash = storage.getKnownContentHash('a/one.png');
    await storage.moveEntry('a/one.png', 'b/one.png');
    expect(host.text('b/one.png')).toBe('png');
    expect(storage.getKnownContentHash('b/one.png')).toBe(hash);
    expect(storage.getKnownContentHash('a/one.png')).toBeNull();
  });
});
