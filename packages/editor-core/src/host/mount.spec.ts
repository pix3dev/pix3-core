import { SceneManager, ScriptRegistry } from '@pix3/runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { FlushService } from '@/services/project/FlushService';
import { appState, resetAppState } from '@/state';

import { HostService } from './HostService';
import { mountEditorWith, type EditorHandle } from './mount';
import { FakeHost } from './testing/fake-host';

/**
 * Plan §F.2 guard: `optionalService`/`hasService` degrade silently when a registration is missing,
 * so the boot path is pinned here — after `mountEditor` the services the editor relies on exist,
 * the project is open, this tab writes, and the sync handlers are wired.
 */
describe('mountEditor', () => {
  let handle: EditorHandle | null = null;

  afterEach(async () => {
    await handle?.dispose();
    handle = null;
    HostService.reset();
    resetAppState();
  });

  it('boots against a host: services registered, project ready, writer claimed', async () => {
    resetAppState();
    const host = new FakeHost({
      files: {
        'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n',
        'scenes/main.pix3scene': 'version: 1.0.0\nroot: []\n',
      },
    });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });

    const container = ServiceContainer.getInstance();
    for (const service of [
      SceneManager,
      ScriptRegistry,
      ProjectStorageService,
      ProjectScriptLoaderService,
      FlushService,
    ]) {
      expect(container.hasService(container.getOrCreateToken(service)), service.name).toBe(true);
    }
    expect(appState.project).toMatchObject({ status: 'ready', id: 'p-1', backend: 'host' });
    expect(appState.project.host).toMatchObject({ writer: 'self', connection: 'open' });
    expect(appState.project.scriptsStatus).toBe('ready');
    expect(typeof host.handlers.flush).toBe('function');
    expect(typeof host.handlers.applySync).toBe('function');
    expect((window as { __PIX3_DEBUG__?: { version: number } }).__PIX3_DEBUG__?.version).toBe(2);
  });

  it('answers a sync during play as stale, naming the owner', async () => {
    resetAppState();
    const host = new FakeHost({ files: { 'scenes/main.pix3scene': 'version: 1.0.0\nroot: []\n' } });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
    appState.ui.isPlaying = true;
    appState.ui.playOwner = 'designer';
    const reply = await host.handlers.applySync?.({
      rev: 1,
      changed: { 'scripts/A.ts': null },
      roots: host.scripts.current(),
    });
    expect(reply).toMatchObject({ ok: false, reason: 'stale', playing: 'designer' });
  });
});
