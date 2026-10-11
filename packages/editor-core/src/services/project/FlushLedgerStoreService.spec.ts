import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { CreateGroup2DOperation } from '@/features/scene/CreateGroup2DOperation';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import { HostNoticeService } from '@/host/HostNoticeService';
import { HostService } from '@/host/HostService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import {
  FlushLedgerStoreService,
  MemoryLedgerStore,
} from '@/services/project/FlushLedgerStoreService';
import { FlushService } from '@/services/project/FlushService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { appState, resetAppState } from '@/state';

/**
 * The flush ledger outlives the tab (W26): an agent that writes a stale read while no tab has the
 * scene open — or after the tab was reloaded — is caught on the next open.
 */

const PATH = 'scenes/main.pix3scene';
const SCENE = [
  '# Main scene.',
  'version: 1.0.0',
  'root:',
  '  - id: box',
  '    type: Group2D',
  '    name: Box',
  '    properties:',
  '      width: 100',
  '  - id: other',
  '    type: Group2D',
  '    name: Other',
  '',
].join('\n');

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;
let store: MemoryLedgerStore;
let host: FakeHost;

async function session(options: { readOnly?: boolean } = {}): Promise<string> {
  resetAppState();
  service(FlushLedgerStoreService).useStore(store);
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  service(ExternalChangeService).configureForTests({ stabilityIntervalMs: 5 });
  if (options.readOnly) appState.project.host.writer = 'other';
  await service(CommandDispatcher).execute(new LoadSceneCommand({ filePath: `res://${PATH}` }));
  await vi.waitFor(() => expect(appState.project.id).toBe('p-1'));
  await service(FlushLedgerStoreService).idle();
  return appState.scenes.activeSceneId!;
}

async function closeTab(): Promise<void> {
  await service(FlushLedgerStoreService).idle();
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
  HostService.reset();
}

/** An agent writes the file while the scene is open; resolves when the editor applied it. */
async function agentWrites(text: string): Promise<void> {
  await host.externalWrite(PATH, text);
  await vi.waitFor(() => {
    expect(service(ExternalChangeService).isPending(PATH)).toBe(false);
    expect(service(SceneBaselineService).get(PATH)?.text).toBe(text);
  });
}

const setWidth = (value: number) =>
  service(OperationService).invokeAndPush(
    new UpdateObjectPropertyOperation({ nodeId: 'box', propertyPath: 'width', value })
  );
const overwrote = () => appState.project.host.notices.filter(n => n.message.includes('overwrote'));

beforeEach(async () => {
  store = new MemoryLedgerStore();
  host = new FakeHost({
    files: { 'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n', [PATH]: SCENE },
  });
  await host.whenReady();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await closeTab();
  resetAppState();
  vi.restoreAllMocks();
});

describe('FlushLedgerStoreService', () => {
  it('a stale write made while the tab was closed → notice on the next open; Restore writes it', async () => {
    const sceneId = await session();
    await setWidth(240);
    await service(FlushService).saveScene(sceneId);
    await closeTab();
    expect([...store.records.values()][0]).toMatchObject({ path: PATH });
    const stale = SCENE.replace('name: Other', 'name: Agent'); // read before the flush
    await host.externalWrite(PATH, stale);

    await session();
    await vi.waitFor(() => expect(overwrote()).toHaveLength(1));
    expect(overwrote()[0].detail).toContain('Box › properties.width');
    expect(store.records.size).toBe(0);
    await service(HostNoticeService).runAction(overwrote()[0].actions[0].id);
    expect(host.text(PATH)).toBe(stale.replace('width: 100', 'width: 240'));
  });

  it('a node added before the tab closed and dropped by a stale write is offered back', async () => {
    const sceneId = await session();
    await service(OperationService).invokeAndPush(
      new CreateGroup2DOperation({ groupName: 'Added' })
    );
    await service(FlushService).saveScene(sceneId);
    await closeTab();
    await host.externalWrite(PATH, SCENE.replace('name: Other', 'name: Agent'));

    await session();
    await vi.waitFor(() => expect(overwrote()).toHaveLength(1));
    expect(overwrote()[0].detail).toContain('Added (added)');
    await service(HostNoticeService).runAction(overwrote()[0].actions[0].id);
    expect(host.text(PATH)).toContain('name: Agent');
    expect(host.text(PATH)).toContain('name: Added');
  });

  it('a reopened tab on its own last write adopts the ledger: a later stale write is caught', async () => {
    let sceneId = await session();
    await setWidth(240);
    await service(FlushService).saveScene(sceneId);
    await closeTab();

    sceneId = await session(); // a reload: the disk is the editor's write
    expect(overwrote()).toEqual([]);
    expect(service(SceneBaselineService).flushLedger(PATH).keys.size).toBe(1);
    await agentWrites(SCENE.replace('name: Other', 'name: Agent'));
    expect(overwrote()).toHaveLength(1);
    expect(overwrote()[0].detail).toContain('Box › properties.width');
    await service(FlushLedgerStoreService).idle();
    expect(store.records.size).toBe(0);
  });

  it('flushes of the reopened tab extend the adopted ledger', async () => {
    let sceneId = await session();
    await setWidth(240);
    await service(FlushService).saveScene(sceneId);
    await closeTab();

    sceneId = await session();
    await setWidth(300);
    await service(FlushService).saveScene(sceneId);
    await closeTab();
    await host.externalWrite(PATH, SCENE); // read before both sessions' flushes

    await session();
    await vi.waitFor(() => expect(overwrote()).toHaveLength(1));
    await service(HostNoticeService).runAction(overwrote()[0].actions[0].id);
    expect(host.text(PATH)).toBe(SCENE.replace('width: 100', 'width: 300'));
  });

  it('an agent that read after the flush, writing while the tab was closed: no notice, ledger spent', async () => {
    const sceneId = await session();
    await setWidth(240);
    await service(FlushService).saveScene(sceneId);
    await closeTab();
    await host.externalWrite(PATH, host.text(PATH)!.replace('name: Other', 'name: Agent'));

    await session();
    expect(overwrote()).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it('a read-only tab neither adopts nor spends the stored ledger', async () => {
    const sceneId = await session();
    await setWidth(240);
    await service(FlushService).saveScene(sceneId);
    await closeTab();
    await host.externalWrite(PATH, SCENE);

    await session({ readOnly: true });
    expect(overwrote()).toEqual([]);
    expect(store.records.size).toBe(1);
  });
});
