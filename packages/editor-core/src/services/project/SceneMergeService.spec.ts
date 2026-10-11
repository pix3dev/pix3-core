import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { CreateGroup2DOperation } from '@/features/scene/CreateGroup2DOperation';
import { DeleteObjectOperation } from '@/features/scene/DeleteObjectOperation';
import { ReparentNodeOperation } from '@/features/scene/ReparentNodeOperation';
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
import { SceneManager } from '@pix3/runtime';
import { appState, resetAppState } from '@/state';

/**
 * Plan §C.3 against a real editor boot: an external version E of an open scene — clean reload,
 * key-level merge of a dirty one, the gate rows "external write: same key / deleted node /
 * structural delta", N2, N8 "perform → undo before flush → external write", and the
 * "agent overwrote your edit" notice with its restore.
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
  '      height: 50',
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
let host: FakeHost;

async function boot(): Promise<string> {
  resetAppState();
  // A fresh browser per case: a ledger kept by the previous case's flushes is not this one's.
  service(FlushLedgerStoreService).useStore(new MemoryLedgerStore());
  host = new FakeHost({
    files: { 'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n', [PATH]: SCENE },
  });
  await host.whenReady();
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  service(ExternalChangeService).configureForTests({ stabilityIntervalMs: 5 });
  await service(CommandDispatcher).execute(new LoadSceneCommand({ filePath: `res://${PATH}` }));
  return appState.scenes.activeSceneId!;
}

const setProp = (nodeId: string, propertyPath: string, value: unknown) =>
  service(OperationService).invokeAndPush(
    new UpdateObjectPropertyOperation({ nodeId, propertyPath, value })
  );

/** An agent writes the file; resolves when the editor has applied it. */
async function agentWrites(text: string): Promise<void> {
  await host.externalWrite(PATH, text);
  const changes = service(ExternalChangeService);
  for (let i = 0; i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (!changes.isPending(PATH) && service(SceneBaselineService).get(PATH)?.text === text) return;
  }
  throw new Error('the external version was not applied');
}

const disk = (): string => host.text(PATH)!;
const node = (id: string) =>
  service(SceneManager).getSceneGraph(appState.scenes.activeSceneId!)!.nodeMap.get(id) as
    | (Record<string, unknown> & { name: string })
    | undefined;
const notices = () => appState.project.host.notices;

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
  HostService.reset();
  resetAppState();
  vi.restoreAllMocks();
});

describe('SceneMergeService — §C.3', () => {
  it('a clean scene reloads the external version as is', async () => {
    await boot();
    await agentWrites(SCENE.replace('name: Other', 'name: Agent'));
    expect(node('other')?.name).toBe('Agent');
    expect(appState.scenes.descriptors[appState.scenes.activeSceneId!]!.isDirty).toBe(false);
    expect(notices()).toEqual([]);
    // The changed node lights up in the scene tree for a moment (§C.3).
    expect(appState.project.host.recentlyChanged[appState.scenes.activeSceneId!]).toEqual([
      'other',
    ]);
  });

  it('a read-only tab follows the disk too (reloading is not an edit)', async () => {
    await boot();
    appState.project.host.writer = 'other';
    await agentWrites(SCENE.replace('name: Other', 'name: Writer Tab'));
    expect(node('other')?.name).toBe('Writer Tab');
  });

  it('dirty: the designer edit and an agent rename of another key both live, no notice', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    const agent = SCENE.replace('name: Other', 'name: Agent');
    await agentWrites(agent);

    expect(node('other')?.name).toBe('Agent');
    expect(node('box')?.width).toBe(240);
    expect(appState.scenes.descriptors[sceneId]!.isDirty).toBe(true);
    expect(notices()).toEqual([]);
    expect(await service(FlushService).saveScene(sceneId)).toBe('saved');
    expect(disk()).toBe(agent.replace('width: 100', 'width: 240'));
    expect(host.journal.map(e => e.author)).toEqual(['rejected-draft']);
  });

  it('dirty: the same key changed by the agent → the designer key is dropped, notice, rejected-draft', async () => {
    await boot();
    await setProp('box', 'width', 240);
    const agent = SCENE.replace('width: 100', 'width: 999');
    await agentWrites(agent);

    expect(node('box')?.width).toBe(999);
    expect(disk()).toBe(agent);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ tone: 'warn' });
    expect(notices()[0].detail).toContain('Box › properties.width');
    expect(host.journal[0]).toMatchObject({ author: 'rejected-draft', path: PATH });
    expect(host.journal[0].text).toContain('width: 240');
  });

  it('dirty: an edit of a node the agent deleted is dropped', async () => {
    await boot();
    await setProp('other', 'name', 'Mine');
    await agentWrites(SCENE.slice(0, SCENE.indexOf('  - id: other')));
    expect(node('other')).toBeUndefined();
    expect(notices()[0].detail).toContain('node deleted on disk');
  });

  it('dirty: a structural delta is dropped against any external version (N5)', async () => {
    await boot();
    await service(OperationService).invokeAndPush(
      new CreateGroup2DOperation({ groupName: 'Added' })
    );
    await agentWrites(SCENE.replace('name: Other', 'name: Agent'));
    expect(node('other')?.name).toBe('Agent');
    expect(notices()[0].detail).toMatch(/\(added\)/);
  });

  it('N2: an omitted default on one side and an agent rename → both edits, no notice', async () => {
    const text = SCENE.replace('      width: 100\n      height: 50\n', '').replace(
      '    properties:\n',
      ''
    );
    await boot();
    await host.externalWrite(PATH, text);
    await service(CommandDispatcher).execute(new LoadSceneCommand({ filePath: `res://${PATH}` }));
    await setProp('box', 'width', 240);
    await agentWrites(
      text
        .replace('name: Other', 'name: Agent')
        .replace('name: Box', 'name: Box\n    properties:\n      width: 100')
    );
    expect(node('box')?.width).toBe(240);
    expect(node('other')?.name).toBe('Agent');
    expect(notices()).toEqual([]);
  });

  it('N8: perform → undo before a flush → external write: nothing resurrects, the agent edit stays', async () => {
    await boot();
    await setProp('box', 'width', 240);
    await service(OperationService).undo();
    const agent = SCENE.replace('name: Other', 'name: Agent');
    await agentWrites(agent);
    expect(node('box')?.width).toBe(100);
    expect(node('other')?.name).toBe('Agent');
    expect(await service(FlushService).flushDirty(0)).toMatchObject({ ok: true });
    expect(disk()).toBe(agent);
  });

  it('an agent writing a stale read of the last flush → notice; "Restore my edit" writes it back', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    await service(FlushService).saveScene(sceneId);
    const stale = SCENE.replace('name: Other', 'name: Agent'); // read before the flush
    await agentWrites(stale);
    expect(node('box')?.width).toBe(100);
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Box › properties.width');

    await service(HostNoticeService).runAction(notice!.actions[0].id);
    expect(node('box')?.width).toBe(240);
    expect(disk()).toBe(stale.replace('width: 100', 'width: 240'));
  });

  it('a stale read from before SEVERAL flushes: every overwritten key is offered back', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    await service(FlushService).saveScene(sceneId);
    await setProp('box', 'height', 70);
    await service(FlushService).saveScene(sceneId);
    await setProp('other', 'name', 'Renamed');
    await service(FlushService).saveScene(sceneId);
    // Read before the first flush; the agent only meant to add a node.
    const stale = SCENE.replace(
      '    name: Other\n',
      '    name: Other\n  - id: added\n    type: Group2D\n    name: Added\n'
    );
    await agentWrites(stale);
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Box › properties.width');
    expect(notice?.detail).toContain('Box › properties.height');
    expect(notice?.detail).toContain('Other › name');

    await service(HostNoticeService).runAction(notice!.actions[0].id);
    expect(disk()).toBe(
      stale
        .replace('width: 100', 'width: 240')
        .replace('height: 50', 'height: 70')
        .replace('name: Other', 'name: Renamed')
    );
    expect(node('added')).toBeTruthy();
  });

  it('"Restore my edit" on a version the patch writer refuses (an alias): a notice, no throw', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    await service(FlushService).saveScene(sceneId);
    // Read before the flush, and rewritten with a YAML anchor/alias the splice writer refuses.
    const stale = SCENE.replace('    properties:\n', '    properties: &p\n').replace(
      '    name: Other\n',
      '    name: Other\n    properties: *p\n'
    );
    await agentWrites(stale);
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Box › properties.width');
    await expect(
      service(HostNoticeService).runAction(notice!.actions[0].id)
    ).resolves.toBeUndefined();
    expect(disk()).toBe(stale);
    expect(notices().some(n => n.message.includes('Could not restore'))).toBe(true);
  });

  it('the flush ledger survives an install the loader rejected: the retry still sees the overwrite', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    await service(FlushService).saveScene(sceneId);
    const stale = SCENE.replace('name: Other', 'name: Agent');
    // The first delivery fails inside the merge, at the install (after the ledger was read); the
    // path stays pending and is retried — with the ledger intact, the retry detects the overwrite.
    vi.spyOn(service(CommandDispatcher), 'execute').mockRejectedValueOnce(
      new Error('reload hiccup')
    );
    await agentWrites(stale);
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Box › properties.width');
  });

  it('a stale write that drops a node the editor added → notice; "Restore my edit" adds it back', async () => {
    const sceneId = await boot();
    await service(OperationService).invokeAndPush(
      new CreateGroup2DOperation({ groupName: 'Added' })
    );
    await service(FlushService).saveScene(sceneId);
    expect(disk()).toContain('name: Added');
    const stale = SCENE.replace('name: Other', 'name: Agent'); // read before the flush
    await agentWrites(stale);
    expect(disk()).not.toContain('name: Added');
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Added (added)');

    await service(HostNoticeService).runAction(notice!.actions[0].id);
    expect(disk()).toContain('name: Agent');
    expect(disk()).toContain('name: Added');
    expect(disk().startsWith('# Main scene.\n')).toBe(true);
  });

  it('a stale write that brings back a node the editor deleted → "Restore my edit" deletes it again', async () => {
    const sceneId = await boot();
    await service(OperationService).invokeAndPush(
      new DeleteObjectOperation({ nodeIds: ['other'] })
    );
    await service(FlushService).saveScene(sceneId);
    expect(disk()).not.toContain('id: other');
    const stale = SCENE.replace('width: 100', 'width: 101');
    await agentWrites(stale);
    expect(node('other')).toBeTruthy();
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Other (deleted)');

    await service(HostNoticeService).runAction(notice!.actions[0].id);
    expect(node('other')).toBeUndefined();
    expect(disk()).toBe(stale.slice(0, stale.indexOf('  - id: other')));
  });

  it('a stale write that undoes a move → "Restore my edit" moves it again', async () => {
    const sceneId = await boot();
    await service(OperationService).invokeAndPush(
      new ReparentNodeOperation({ nodeId: 'other', newParentId: 'box' })
    );
    await service(FlushService).saveScene(sceneId);
    await agentWrites(SCENE.replace('name: Box', 'name: Agent Box'));
    expect(appState.scenes.descriptors[sceneId]).toBeTruthy();
    const notice = notices().find(n => n.message.includes('overwrote'));
    expect(notice?.detail).toContain('Other (moved)');

    await service(HostNoticeService).runAction(notice!.actions[0].id);
    const graph = service(SceneManager).getSceneGraph(sceneId)!;
    expect(graph.nodeMap.get('other')?.parentNode?.nodeId).toBe('box');
    expect(disk()).toContain('name: Agent Box');
    expect(disk()).toMatch(/children:\n\s+- id: other/);
  });

  it('structural flushes an agent saw are not "overwritten"', async () => {
    const sceneId = await boot();
    await service(OperationService).invokeAndPush(
      new DeleteObjectOperation({ nodeIds: ['other'] })
    );
    await service(FlushService).saveScene(sceneId);
    await agentWrites(disk().replace('name: Box', 'name: Agent Box'));
    expect(notices().filter(n => n.message.includes('overwrote'))).toEqual([]);
  });

  it('an agent that read after the flushes: nothing is "overwritten"', async () => {
    const sceneId = await boot();
    await setProp('box', 'width', 240);
    await service(FlushService).saveScene(sceneId);
    await setProp('box', 'height', 70);
    await service(FlushService).saveScene(sceneId);
    await agentWrites(disk().replace('name: Other', 'name: Agent'));
    expect(notices().filter(n => n.message.includes('overwrote'))).toEqual([]);
    // The ledger was spent by that version: a later stale write is judged on later flushes only.
    await agentWrites(disk().replace('name: Agent', 'name: Agent 2'));
    expect(notices().filter(n => n.message.includes('overwrote'))).toEqual([]);
  });
});
