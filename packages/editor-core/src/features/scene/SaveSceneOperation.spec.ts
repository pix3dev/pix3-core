import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { appState, resetAppState } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';
import { MemoryStorage } from '@/services/project/coauthoring/memory-storage.spec-helper';
import { SceneWriteConflictError } from '@/services/project/write-errors';
import { sha256 } from '@/services/project/external-merge/hash';
import { SaveSceneOperation } from './SaveSceneOperation';

const SCENE_ID = 'scene-1';
const PATH = 'scenes/main.pix3scene';

/** The plugin's write rule: `If-Match` must equal the disk's hash, else 412. */
class SaveStorage extends MemoryStorage {
  readonly bases: Array<string | undefined> = [];
  async getLastModified(): Promise<number | null> {
    return 1;
  }
  async writeTextFile(
    path: string,
    contents: string,
    options: { baseHash?: string } = {}
  ): Promise<void> {
    const key = path.replace(/^res:\/\//, '');
    this.bases.push(options.baseHash);
    const current = this.files.get(key);
    if (options.baseHash && current !== undefined && (await sha256(current)) !== options.baseHash) {
      throw new SceneWriteConflictError(key, {
        code: 'base_mismatch',
        status: 412,
        message: 'changed',
        currentHash: await sha256(current),
      });
    }
    await super.writeTextFile(path, contents);
  }
}

function createHarness() {
  let yaml = 'version: 1.0.0\nroot:\n  - id: n\n    name: Edited\n';
  const storage = new SaveStorage();
  const diskState = new SceneDiskStateService();
  const externalChanges = { report: vi.fn() };
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const graph = { rootNodes: [] };
  let onSerialize: () => void = () => undefined;
  const sceneManager = {
    getSceneGraph: () => graph,
    serializeScene: () => {
      onSerialize();
      return yaml;
    },
  };
  const services = new Map<unknown, unknown>([
    [SceneManager, sceneManager],
    [ProjectStorageService, storage],
    [LoggingService, logger],
    [SceneDiskStateService, diskState],
    [ExternalChangeService, externalChanges],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    hasService: (token: unknown) => services.has(token),
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) throw new Error(`Unexpected token ${String(token)}`);
      return services.get(token) as T;
    },
  };

  appState.project.id = 'p1';
  appState.scenes.activeSceneId = SCENE_ID;
  appState.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: `res://${PATH}`,
    name: 'Main',
    version: '1.0.0',
    isDirty: true,
    lastSavedAt: null,
    lastModifiedTime: null,
  };
  const save = (params: { overwriteExternalHash?: string } = {}) =>
    new SaveSceneOperation({ sceneId: SCENE_ID, quiet: true, ...params }).perform({
      state: appState,
      snapshot: structuredClone({ scenes: { descriptors: {} } }),
      container: container as unknown as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext);

  return {
    storage,
    diskState,
    externalChanges,
    save,
    setYaml: (next: string) => {
      yaml = next;
    },
    onSerialize: (fn: () => void) => {
      onSerialize = fn;
    },
  };
}

beforeEach(() => {
  resetAppState();
});

describe('SaveSceneOperation — conditional write', () => {
  it('writes when the disk still holds the version the editor read', async () => {
    const h = createHarness();
    const original = 'version: 1.0.0\nroot: []\n';
    h.storage.files.set(PATH, original);
    await h.diskState.recordRead(PATH, original);

    const result = await h.save();

    expect(result.outcome).toBe('saved');
    expect(h.storage.writes.map(w => w.path)).toEqual([PATH]);
    expect(h.storage.bases).toEqual([await sha256(original)]);
    const hash = await sha256(h.storage.files.get(PATH)!);
    expect(h.diskState.getKnown(PATH)).toMatchObject({ hash, source: 'write' });
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
  });

  it('does not write over an external version: refused, path pending, scene stays dirty', async () => {
    const h = createHarness();
    await h.diskState.recordRead(PATH, 'version: 1.0.0\nroot: []\n');
    h.storage.files.set(PATH, 'version: 1.0.0\nroot: [] # the agent wrote this\n');

    const result = await h.save();

    expect(result).toEqual({ didMutate: false, outcome: 'external-change' });
    expect(h.storage.writes).toEqual([]);
    expect(h.storage.files.get(PATH)).toContain('the agent wrote this');
    expect(h.externalChanges.report).toHaveBeenCalledWith(PATH);
    expect(h.diskState.isPendingExternal(PATH)).toBe(true);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
  });

  it('bases the write on the accepted version; "keep mine" writes over the chosen one', async () => {
    const h = createHarness();
    const accepted = 'version: 1.0.0\nroot: []\n';
    const agent = 'version: 1.0.0\nroot: [] # the agent wrote this\n';
    await h.diskState.recordRead(PATH, accepted);
    h.storage.files.set(PATH, agent);

    expect((await h.save()).outcome).toBe('external-change');
    expect(h.storage.bases).toEqual([await sha256(accepted)]);

    const kept = await h.save({ overwriteExternalHash: await sha256(agent) });
    expect(kept.outcome).toBe('saved');
    expect(h.storage.bases[1]).toBe(await sha256(agent));
  });

  it('skips the write when the bytes are what the editor last read', async () => {
    const h = createHarness();
    const same = 'version: 1.0.0\nroot:\n  - id: n\n    name: Edited\n';
    h.storage.files.set(PATH, same);
    await h.diskState.recordRead(PATH, same);

    const result = await h.save();
    expect(result.outcome).toBe('unchanged');
    expect(h.storage.writes).toEqual([]);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
  });

  it('keeps the scene dirty when an edit lands while the write is in flight', async () => {
    const h = createHarness();
    h.onSerialize(() => {
      queueMicrotask(() => {
        appState.scenes.nodeDataChangeSignal += 1; // an operation completed meanwhile
      });
    });
    const result = await h.save();
    expect(result.outcome).toBe('saved');
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
  });
});
