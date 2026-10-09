import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import { HostService } from '@/host/HostService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import type { HostWriteOptions, HostWriteResult } from '@/host/EditorHost';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { FlushService } from '@/services/project/FlushService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { appState, resetAppState } from '@/state';
import { SceneManager } from '@pix3/runtime';

/**
 * `FlushService` against a real editor boot (`mountEditorWith` + `FakeHost`) and real operations:
 * the write rules of plan §C.1 and the gate rows of §G.2 that do not need a browser.
 */

const PATH = 'scenes/main.pix3scene';
const SCENE = [
  '# The main scene — comments must survive every flush.',
  'version: 1.0.0',
  'root:',
  '  - id: box # the box',
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

async function boot(
  extra: Record<string, string> = {}
): Promise<{ flush: FlushService; sceneId: string }> {
  resetAppState();
  host = new FakeHost({
    files: {
      'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n',
      [PATH]: SCENE,
      ...extra,
    },
  });
  await host.whenReady();
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  await service(CommandDispatcher).execute(new LoadSceneCommand({ filePath: `res://${PATH}` }));
  return { flush: service(FlushService), sceneId: appState.scenes.activeSceneId! };
}

const setWidth = (value: number, nodeId = 'box') =>
  service(OperationService).invokeAndPush(
    new UpdateObjectPropertyOperation({ nodeId, propertyPath: 'width', value })
  );

const disk = (): string => host.text(PATH)!;

/** Fake timers cover setTimeout only: the host's WebCrypto hashing needs real time to finish. */
const realSleep = (ms: number) =>
  new Promise<void>(resolve => {
    const id = setInterval(() => {
      clearInterval(id);
      resolve();
    }, ms);
  });
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await realSleep(15);
};
const descriptor = () => appState.scenes.descriptors[appState.scenes.activeSceneId!]!;

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  await handle?.dispose();
  handle = null;
  HostService.reset();
  resetAppState();
  vi.restoreAllMocks();
});

describe('FlushService — a flush is one patch from the baseline', () => {
  it('writes only the changed line, keeps the comments, moves the baseline, cleans the scene', async () => {
    const { flush } = await boot();
    await setWidth(240);
    expect(descriptor().isDirty).toBe(true);

    expect(await flush.flushDirty(0)).toMatchObject({ ok: true, saved: [PATH] });
    expect(disk()).toBe(SCENE.replace('width: 100', 'width: 240'));
    expect(descriptor().isDirty).toBe(false);
    expect(service(SceneBaselineService).get(PATH)!.text).toBe(disk());
  });

  it('Ctrl+Z after a flush: undone in memory, dirty again, the next flush writes it', async () => {
    const { flush, sceneId } = await boot();
    await setWidth(240);
    await flush.flushDirty(0);

    await service(OperationService).undo();
    expect(descriptor().isDirty).toBe(true);
    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toBe(SCENE);
  });

  it('N8: perform → undo before any flush writes nothing and leaves the scene clean', async () => {
    const { flush, sceneId } = await boot();
    await setWidth(240);
    await service(OperationService).undo();
    const writes = host.frames.length;
    expect(await flush.saveScene(sceneId)).toBe('unchanged');
    expect(host.frames.length).toBe(writes);
    expect(descriptor().isDirty).toBe(false);
  });

  it('N8: an edit while the write is in flight keeps the scene dirty; the next flush writes it', async () => {
    const { flush, sceneId } = await boot();
    const write = host.files.write.bind(host.files);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let started: () => void = () => {};
    const writeStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    vi.spyOn(host.files, 'write').mockImplementation(
      async (
        path: string,
        data: Uint8Array | string,
        options?: HostWriteOptions
      ): Promise<HostWriteResult> => {
        started();
        await gate;
        return write(path, data, options);
      }
    );
    await setWidth(240);
    const first = flush.saveScene(sceneId);
    await writeStarted; // the snapshot is taken, its response is delayed
    await setWidth(300); // after the snapshot's cutoff
    release();
    expect(await first).toBe('saved');
    expect(disk()).toContain('width: 240');
    expect(descriptor().isDirty).toBe(true);

    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toContain('width: 300');
    expect(descriptor().isDirty).toBe(false);
    // Ctrl+Z still walks the in-memory history.
    await service(OperationService).undo();
    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toContain('width: 240');
  });

  it('N8: coalesced input on both sides of a flush — the final value is written, Ctrl+Z works in memory', async () => {
    const { flush, sceneId } = await boot();
    // An inspector number drag: every step coalesces into one history entry whose undo goes
    // back to the value before the drag (`previousValue`).
    const step = (value: number) =>
      service(OperationService).invokeAndPush(
        new UpdateObjectPropertyOperation({
          nodeId: 'box',
          propertyPath: 'width',
          value,
          previousValue: 100,
        }),
        { coalesceKey: 'box.width' }
      );
    const entriesBefore = service(OperationService).history.snapshot().undoEntries.length;
    await step(150);
    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toContain('width: 150');
    await step(200);
    await step(260);
    // Three steps, one entry (the singleton history may hold other specs' entries of this scene).
    expect(service(OperationService).history.snapshot().undoEntries.length).toBe(entriesBefore + 1);
    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toContain('width: 260');

    await service(OperationService).undo();
    expect(descriptor().isDirty).toBe(true);
    expect(disk()).toContain('width: 260'); // undo is in memory until the next flush
    expect(await flush.saveScene(sceneId)).toBe('saved');
    expect(disk()).toBe(SCENE);
  });

  it('never writes over an external version: 412 → nothing written, path pending', async () => {
    const { flush, sceneId } = await boot();
    await setWidth(240);
    const agent = SCENE.replace('name: Other', 'name: Agent');
    // Written behind the editor's back, before its frame is processed.
    vi.spyOn(host, 'externalWrite');
    await host.externalWrite(PATH, agent);
    service(SceneBaselineService).clearPendingExternal(PATH);
    expect(await flush.saveScene(sceneId)).toBe('external-change');
    expect(disk()).toBe(agent);
    expect(service(SceneBaselineService).isPendingExternal(PATH)).toBe(true);
    expect(descriptor().isDirty).toBe(true);
  });

  it('an answer lost after the bytes landed (dev server stopped) is this write, not an agent’s', async () => {
    const { flush, sceneId } = await boot();
    const write = host.files.write.bind(host.files);
    // The plugin renames the file into place, then the connection dies before the answer.
    const lost = vi
      .spyOn(host.files, 'write')
      .mockImplementationOnce(async (path, data, options) => {
        await write(path, data, options);
        throw new TypeError('Failed to fetch');
      });
    await setWidth(240);
    expect(await flush.saveScene(sceneId)).toBe('failed');
    expect(disk()).toContain('width: 240');
    lost.mockRestore();

    await setWidth(300);
    const baselines = service(SceneBaselineService);
    expect(await flush.saveScene(sceneId)).toBe('saved');
    // The 412 named exactly the unanswered write's bytes: adopted, and the rest written on top —
    // no merge, no "changed on disk" for the editor's own version.
    expect(disk()).toBe(SCENE.replace('width: 100', 'width: 300'));
    expect(baselines.isPendingExternal(PATH)).toBe(false);
    expect(baselines.get(PATH)!.text).toBe(disk());
    expect(descriptor().isDirty).toBe(false);
  });

  it('an unanswered write that did NOT land changes nothing: a real external version still merges', async () => {
    const { flush, sceneId } = await boot();
    vi.spyOn(host.files, 'write').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await setWidth(240);
    expect(await flush.saveScene(sceneId)).toBe('failed');
    expect(disk()).toBe(SCENE);
    const agent = SCENE.replace('name: Other', 'name: Agent');
    await host.externalWrite(PATH, agent);
    service(SceneBaselineService).clearPendingExternal(PATH);
    expect(await flush.saveScene(sceneId)).toBe('external-change');
    expect(disk()).toBe(agent);
  });

  it('a read-only tab does not write', async () => {
    const { flush, sceneId } = await boot();
    await setWidth(240);
    appState.project.host.writer = 'other';
    expect(await flush.saveScene(sceneId)).toBe('read-only');
    expect(disk()).toBe(SCENE);
  });
});

describe('FlushService — when the disk is written (§C.1 table)', () => {
  it('idle: 1.5 s after the last operation; never during a gesture; the gesture waits', async () => {
    const { flush } = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    void flush;

    appState.ui.gestureInProgress = true;
    await setWidth(240);
    await advance(12_000);
    expect(disk()).toBe(SCENE); // not during the drag, not even past the upper bound

    appState.ui.gestureInProgress = false;
    await advance(300);
    await vi.waitFor(() => expect(disk()).toContain('width: 240'));
  });

  it('upper bound: continuous edits are written within 10 s of the first one', async () => {
    await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let i = 0; i < 15; i++) {
      await setWidth(200 + i);
      await advance(1_000); // never 1.5 s idle
      if (i === 8) expect(disk()).toBe(SCENE);
      if (disk() !== SCENE) {
        expect(i).toBeGreaterThanOrEqual(9);
        expect(i).toBeLessThanOrEqual(10);
        return;
      }
    }
    throw new Error('no write within 15 s of continuous edits');
  });

  it('flushDirty answers gesture_in_progress when the drag outlasts the timeout', async () => {
    const { flush } = await boot();
    await setWidth(240);
    appState.ui.gestureInProgress = true;
    expect(await flush.flushDirty(10)).toEqual({ ok: false, reason: 'gesture_in_progress' });
    expect(disk()).toBe(SCENE);
  });
});

describe('FlushService — several dirty scenes are one changeset (§C.2, §C.4)', () => {
  it('writes both files in one transaction and one frame', async () => {
    const OTHER = 'scenes/other.pix3scene';
    const { flush, sceneId: mainId } = await boot({
      [OTHER]: SCENE.replace('name: Box', 'name: Other Box'),
    });
    await service(CommandDispatcher).execute(
      new LoadSceneCommand({ filePath: `res://${OTHER}`, sceneId: 'other-scene' })
    );
    await setWidth(111); // active: the other scene
    appState.scenes.activeSceneId = mainId;
    service(SceneManager).setActiveScene(mainId);
    await setWidth(222);
    const frames = host.frames.length;

    expect(flush.dirtySceneIds().sort()).toEqual([mainId, 'other-scene'].sort());
    expect(await flush.flushDirty(0)).toMatchObject({ ok: true });
    expect(host.changesets).toBe(1);
    expect(host.frames.length).toBe(frames + 1);
    expect(
      host.frames
        .at(-1)!
        .events.map(e => e.path)
        .sort()
    ).toEqual([OTHER, PATH].sort());
    expect(host.text(OTHER)).toContain('width: 111');
    expect(disk()).toContain('width: 222');
    expect(flush.dirtySceneIds()).toEqual([]);
  });
});
