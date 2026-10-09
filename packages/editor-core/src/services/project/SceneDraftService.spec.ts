import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import { HostNoticeService } from '@/host/HostNoticeService';
import { HostService } from '@/host/HostService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { FlushService } from '@/services/project/FlushService';
import { MemoryDraftStore, SceneDraftService } from '@/services/project/SceneDraftService';
import { appState, resetAppState } from '@/state';

/**
 * Plan §C.1 draft and gate row N9: a confirmed checkpoint survives the tab; on the next open it is
 * offered only if the disk is still the version it was made from, and "Restore" writes it.
 */

const PATH = 'scenes/main.pix3scene';
const SCENE =
  'version: 1.0.0\nroot:\n  - id: box\n    type: Group2D\n    name: Box\n    properties:\n      width: 100\n';

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;
let store: MemoryDraftStore;

async function session(host: FakeHost): Promise<string> {
  resetAppState();
  service(SceneDraftService).useStore(store);
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  await service(CommandDispatcher).execute(new LoadSceneCommand({ filePath: `res://${PATH}` }));
  await vi.waitFor(() => expect(appState.project.id).toBe('p-1'));
  return appState.scenes.activeSceneId!;
}

async function closeTab(): Promise<void> {
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
  HostService.reset();
}

const newHost = async (scene = SCENE): Promise<FakeHost> => {
  const host = new FakeHost({
    files: { 'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n', [PATH]: scene },
  });
  await host.whenReady();
  return host;
};

const setWidth = (value: number) =>
  service(OperationService).invokeAndPush(
    new UpdateObjectPropertyOperation({ nodeId: 'box', propertyPath: 'width', value })
  );

beforeEach(() => {
  store = new MemoryDraftStore();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await closeTab();
  resetAppState();
  vi.restoreAllMocks();
});

describe('SceneDraftService', () => {
  it('N9: a checkpoint outlives the tab; the next open offers it and "Restore" writes it', async () => {
    const host = await newHost();
    await session(host);
    await setWidth(240);
    expect(service(SceneDraftService).isCovered()).toBe(false);
    await service(SceneDraftService).checkpointAll();
    expect(service(SceneDraftService).isCovered()).toBe(true);
    expect([...store.records.values()][0]).toMatchObject({ path: PATH });
    await closeTab(); // gone before any flush
    expect(host.text(PATH)).toBe(SCENE);

    await session(host);
    await vi.waitFor(() => expect(appState.project.host.notices).toHaveLength(1));
    const notice = appState.project.host.notices[0];
    expect(notice.actions.map(a => a.label)).toEqual(['Restore', 'Discard']);
    await service(HostNoticeService).runAction(notice.actions[0].id);
    expect(host.text(PATH)).toBe(SCENE.replace('width: 100', 'width: 240'));
    expect(store.records.size).toBe(0);
  });

  it('a draft made against an older disk goes to the journal as rejected-draft, not offered', async () => {
    const host = await newHost();
    await session(host);
    await setWidth(240);
    await service(SceneDraftService).checkpointAll();
    await closeTab();
    await host.externalWrite(PATH, SCENE.replace('name: Box', 'name: Agent'));

    await session(host);
    await vi.waitFor(() => expect(appState.project.host.notices).toHaveLength(1));
    expect(appState.project.host.notices[0].actions).toEqual([]);
    expect(host.journal).toHaveLength(1);
    expect(host.journal[0]).toMatchObject({ author: 'rejected-draft', path: PATH });
    expect(host.journal[0].text).toContain('width: 240');
    expect(store.records.size).toBe(0);
  });

  it('a flush that cleans the scene drops its draft', async () => {
    const host = await newHost();
    const sceneId = await session(host);
    await setWidth(240);
    await service(SceneDraftService).checkpointAll();
    expect(store.records.size).toBe(1);
    await service(FlushService).saveScene(sceneId);
    await vi.waitFor(() => expect(store.records.size).toBe(0));
    expect(service(SceneDraftService).isCovered()).toBe(true);
  });
});
