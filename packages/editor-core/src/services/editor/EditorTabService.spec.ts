import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { deriveSceneIdFromResourcePath } from '@/core/scene-id';

// golden-layout's CJS build (what Node resolves in specs) requires `tslib`, which it does not
// declare and the workspace does not install; nothing here needs a real layout.
vi.mock('golden-layout', () => ({ GoldenLayout: class {} }));

const SCENE = 'res://scenes/main.pix3scene';
const OTHER_SCENE = 'res://scenes/level.pix3scene';

describe('EditorTabService', () => {
  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    vi.restoreAllMocks();
    appState.project.status = 'ready';
  });

  const createService = () => {
    const service = new EditorTabService();
    const sceneWrite = { saveScene: vi.fn(async () => 'saved' as const) };

    Object.defineProperty(service, 'layoutManager', {
      value: {
        subscribeEditorTabFocused: vi.fn().mockReturnValue(() => undefined),
        subscribeEditorTabCloseRequested: vi.fn(),
        ensureEditorTab: vi.fn(),
        focusEditorTab: vi.fn(),
        removeEditorTab: vi.fn(),
        updateEditorTabTitle: vi.fn(),
      },
    });
    Object.defineProperty(service, 'dialogService', {
      value: { showChoice: vi.fn().mockResolvedValue('confirm') },
    });
    Object.defineProperty(service, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(undefined), executeById: vi.fn() },
    });
    Object.defineProperty(service, 'viewportRenderer', {
      value: { captureCameraState: vi.fn(), applyCameraState: vi.fn() },
    });
    Object.defineProperty(service, 'sceneManager', {
      value: { removeSceneGraph: vi.fn(), setActiveScene: vi.fn() },
    });
    Object.defineProperty(service, 'operationService', {
      value: { invoke: vi.fn() },
    });
    Object.defineProperty(service, 'animationEditorService', {
      value: { setActiveAssetPath: vi.fn(), getActiveAssetPath: vi.fn().mockReturnValue(null) },
    });
    Object.defineProperty(service, 'projectScriptLoader', {
      value: { ensureReady: vi.fn(async () => undefined) },
    });
    Object.defineProperty(service, 'sceneWrite', { value: sceneWrite });
    Object.defineProperty(service, 'storage', {
      value: { getLastModified: vi.fn(async () => 1) },
      configurable: true,
    });

    return { service, sceneWrite };
  };

  const describeScene = (resourcePath: string, isDirty: boolean) => {
    const id = deriveSceneIdFromResourcePath(resourcePath);
    appState.scenes.descriptors[id] = {
      id,
      filePath: resourcePath,
      name: resourcePath,
      version: '1',
      isDirty,
      lastSavedAt: null,
    };
    return id;
  };

  it('opens a scene tab, mirrors its dirty state, and saves through SceneWriteService', async () => {
    const { service, sceneWrite } = createService();

    await service.openResourceTab('scene', SCENE);
    expect(appState.tabs.activeTabId).toBe(`scene:${SCENE}`);

    const sceneId = describeScene(SCENE, true);
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(appState.tabs.tabs[0]?.isDirty).toBe(true);
    // Dirty state is shown by a tab dot, not a `*` title prefix — the title stays clean.
    expect(appState.tabs.tabs[0]?.title).toBe('main.pix3scene');

    await service.saveActiveTab();
    expect(sceneWrite.saveScene).toHaveBeenCalledWith(sceneId);
  });

  it('reports every dirty tab as dirty', () => {
    const { service } = createService();
    appState.tabs.tabs = [
      { id: `scene:${SCENE}`, resourceId: SCENE, type: 'scene', title: 'main', isDirty: true },
      {
        id: `scene:${OTHER_SCENE}`,
        resourceId: OTHER_SCENE,
        type: 'scene',
        title: 'level',
        isDirty: false,
      },
    ];

    expect(service.getDirtyTabs().map(tab => tab.id)).toEqual([`scene:${SCENE}`]);
  });

  // Valtio batches subscription callbacks into a microtask.
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('discards tabs on a project switch instead of persisting them under the new project', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';

    await service.openResourceTab('scene', SCENE);
    await flush();
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toContain(SCENE);

    appState.project.id = 'project-b';
    await flush();

    expect(appState.tabs.tabs).toHaveLength(0);
    expect(appState.tabs.activeTabId).toBeNull();
    // project-a keeps its session; project-b never inherits the foreign tab.
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toContain(SCENE);
    expect(localStorage.getItem('pix3.projectTabs:project-b')).toBeNull();
  });

  it('skips restored tabs whose project resource no longer exists', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';
    Object.defineProperty(service, 'storage', {
      value: {
        getLastModified: vi.fn(async (path: string) => (path === SCENE ? 1 : null)),
      },
    });

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [
          { resourceId: SCENE, type: 'scene', title: 'main.pix3scene' },
          { resourceId: 'res://scenes/gone.pix3scene', type: 'scene', title: 'gone.pix3scene' },
        ],
        activeTabId: `scene:${SCENE}`,
      })
    );

    await service.restoreProjectSession('project-a');

    expect(appState.tabs.tabs.map(tab => tab.resourceId)).toEqual([SCENE]);
  });

  it('drops a stored session whose resources have all disappeared', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';
    Object.defineProperty(service, 'storage', {
      value: { getLastModified: vi.fn(async () => null) },
    });

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [{ resourceId: 'res://scenes/castle.pix3scene', type: 'scene', title: 'castle' }],
        activeTabId: 'scene:res://scenes/castle.pix3scene',
      })
    );

    await expect(service.restoreProjectSession('project-a')).resolves.toBe(false);
    expect(appState.tabs.tabs).toHaveLength(0);
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toBeNull();
  });

  it('keeps a stored session when the existence check could not be made', async () => {
    // Storage that is not pointed at the freshly opened project directory yet THROWS. Reading that
    // as "the file is gone" used to erase the saved session permanently — one transient failure on
    // the welcome → open path and the user's tabs were unrecoverable.
    const { service } = createService();
    appState.project.id = 'project-a';
    Object.defineProperty(service, 'storage', {
      value: {
        getLastModified: vi.fn(async () => {
          throw new Error('project directory not ready');
        }),
      },
    });

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [{ resourceId: 'res://scenes/castle.pix3scene', type: 'scene', title: 'castle' }],
        activeTabId: 'scene:res://scenes/castle.pix3scene',
      })
    );

    await service.restoreProjectSession('project-a');

    // The tab is restored rather than dropped, and the session survives either way.
    expect(appState.tabs.tabs.map(tab => tab.resourceId)).toEqual([
      'res://scenes/castle.pix3scene',
    ]);
    // Re-persisted after the restore, but never removed — the scene is still named in it.
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toContain(
      'res://scenes/castle.pix3scene'
    );
  });

  it('does not restore tab types 2.x dropped from a stored 1.x session', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [
          { resourceId: 'res://scripts/player.ts', type: 'code', title: 'player.ts' },
          { resourceId: 'res://sprites/a.png', type: 'sprite-editor', title: 'a.png' },
          { resourceId: SCENE, type: 'scene', title: 'main.pix3scene' },
        ],
        activeTabId: 'code:res://scripts/player.ts',
      })
    );

    await service.restoreProjectSession('project-a');

    expect(appState.tabs.tabs.map(tab => tab.id)).toEqual([`scene:${SCENE}`]);
  });
});
