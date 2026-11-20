import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHeadlessGame } from '../testing';
import type { PropertySchema } from '../fw/property-schema';
import { appLifecycle } from './AppLifecycle';
import { GameStorage, setStorageAdapter, type StorageAdapter } from './GameStorage';
import { Script } from './ScriptComponent';

const KEY = 'pix3:test-ns:save';

/** An adapter that records writes and can hold one in flight. */
class FakeAdapter implements StorageAdapter {
  readonly writes: string[] = [];
  private gate: Promise<void> | null = null;
  private opener: (() => void) | null = null;
  constructor(private stored: string | null = null) {}
  read = async (): Promise<string | null> => this.stored;
  write = async (_key: string, snapshot: string): Promise<void> => {
    if (this.gate) await this.gate;
    this.writes.push(snapshot);
    this.stored = snapshot;
  };
  hold(): void {
    this.gate = new Promise(resolve => (this.opener = resolve));
  }
  release(): void {
    this.opener?.();
    this.gate = null;
  }
}

describe('GameStorage (scene.storage)', () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setStorageAdapter(null);
  });

  it('cold start: empty, persistent, at the newest migration version', async () => {
    const storage = new GameStorage();
    storage.migrate(0, 1, data => data);
    storage.migrate(1, 2, data => data);
    await storage.open({ namespace: 'test-ns' });
    expect(storage.persistent).toBe(true);
    expect(storage.get('best', 0)).toBe(0);
    expect(storage.version).toBe(2);
    await storage.close();
  });

  it('reads the namespace key, and get returns a copy', async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 0, data: { inv: { coins: 3 } } }));
    localStorage.setItem('pix3:other:save', 'untouched');
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    const inv = storage.get('inv', { coins: 0 });
    inv.coins = 99;
    expect(storage.get('inv', { coins: 0 }).coins).toBe(3);
    storage.clear();
    await storage.flush();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '')).toEqual({ version: 0, data: {} });
    expect(localStorage.getItem('pix3:other:save')).toBe('untouched');
    await storage.close();
  });

  it('writes a burst of changes once, after the delay', async () => {
    vi.useFakeTimers();
    const adapter = new FakeAdapter();
    setStorageAdapter(adapter);
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    storage.set('a', 1);
    storage.set('b', 2);
    expect(adapter.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(adapter.writes).toEqual(['{"version":0,"data":{"a":1,"b":2}}']);
    await storage.close();
  });

  it('a change made during a write is written by the next one', async () => {
    const adapter = new FakeAdapter();
    setStorageAdapter(adapter);
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    storage.set('n', 1);
    adapter.hold();
    const first = storage.flush();
    await Promise.resolve();
    storage.set('n', 2);
    const second = storage.flush();
    adapter.release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(adapter.writes.map(w => JSON.parse(w).data.n)).toEqual([1, 2]);
    await storage.close();
  });

  it('a refused write (quota) keeps the change pending for the next flush', async () => {
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    storage.set('big', 'x');
    expect(await storage.flush()).toEqual({ ok: false, error: 'QuotaExceededError' });
    setItem.mockRestore();
    expect(await storage.flush()).toEqual({ ok: true });
    expect(JSON.parse(localStorage.getItem(KEY) ?? '').data).toEqual({ big: 'x' });
    await storage.close();
  });

  it('migrates an old save on first access and writes it back', async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, data: { score: 5 } }));
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    storage.migrate(0, 1, () => ({ wrong: true }));
    storage.migrate(1, 2, data => ({ best: data.score }));
    expect(storage.get('best', 0)).toBe(5);
    expect(storage.version).toBe(2);
    await storage.flush();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '')).toEqual({ version: 2, data: { best: 5 } });
    storage.migrate(2, 3, data => data);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('came after the save was read'));
    await storage.close();
  });

  it('a failing migration keeps the save and plays unsaved', async () => {
    const saved = JSON.stringify({ version: 0, data: { score: 5 } });
    localStorage.setItem(KEY, saved);
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    storage.migrate(0, 1, () => {
      throw new Error('boom');
    });
    expect(storage.get('score', 0)).toBe(0);
    expect(storage.persistent).toBe(false);
    storage.set('score', 1);
    await storage.flush();
    expect(localStorage.getItem(KEY)).toBe(saved);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('migration 0 → 1 threw: boom'));
  });

  it('a corrupt save starts empty and is overwritten by the next write', async () => {
    localStorage.setItem(KEY, '{not json');
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    expect(storage.has('x')).toBe(false);
    storage.set('x', 1);
    await storage.flush();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '').data).toEqual({ x: 1 });
    await storage.close();
  });

  it('export / import round-trip; a damaged import changes nothing', async () => {
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns', mode: 'memory' });
    storage.set('a', [1, 2]);
    const snapshot = storage.export();
    expect(storage.import('{"version":0,"data":')).toMatchObject({ ok: false });
    expect(storage.import({ version: 0, data: [] })).toMatchObject({ ok: false });
    expect(storage.import({ version: -1, data: {} })).toMatchObject({ ok: false });
    expect(storage.export()).toBe(snapshot);
    expect(storage.import({ version: 0, data: { b: true } })).toEqual({ ok: true });
    expect(storage.get('b', false)).toBe(true);
    expect(storage.has('a')).toBe(false);
  });

  it('an import from an old version is migrated, and rejected whole when that fails', async () => {
    const storage = new GameStorage();
    storage.migrate(0, 1, data => {
      if (data.bad) throw new Error('bad');
      return { v1: data.v0 };
    });
    await storage.open({ namespace: 'test-ns', mode: 'memory' });
    expect(storage.import({ version: 0, data: { v0: 7 } })).toEqual({ ok: true });
    expect(storage.get('v1', 0)).toBe(7);
    expect(storage.import({ version: 0, data: { bad: 1 } })).toMatchObject({ ok: false });
    expect(storage.get('v1', 0)).toBe(7);
  });

  it('test modes never read or write the real save', async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 0, data: { real: 1 } }));
    const memory = new GameStorage();
    await memory.open({ namespace: 'test-ns', mode: 'memory' });
    expect(memory.persistent).toBe(false);
    expect(memory.has('real')).toBe(false);
    memory.set('real', 2);
    expect(await memory.flush()).toEqual({ ok: true });

    const seeded = new GameStorage();
    await seeded.open({ namespace: 'test-ns', mode: { snapshot: { data: { level: 4 } } } });
    expect(seeded.get('level', 0)).toBe(4);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '').data).toEqual({ real: 1 });
  });

  it('flushes at once when the app goes to the background', async () => {
    vi.useFakeTimers();
    const adapter = new FakeAdapter(JSON.stringify({ version: 0, data: {} }));
    setStorageAdapter(adapter);
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    storage.set('k', 1);
    appLifecycle.simulateBackground(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.writes).toEqual(['{"version":0,"data":{"k":1}}']);
    await storage.close();
  });

  it('an adapter that cannot read plays unsaved', async () => {
    setStorageAdapter({
      read: () => Promise.reject(new Error('offline')),
      write: () => Promise.resolve(),
    });
    const storage = new GameStorage();
    await storage.open({ namespace: 'test-ns' });
    expect(storage.persistent).toBe(false);
    storage.set('x', 1);
    expect(storage.get('x', 0)).toBe(1);
  });

  it('without a namespace or a store it is memory only', () => {
    const storage = new GameStorage();
    storage.set('x', { y: 1 });
    expect(storage.get('x', null)).toEqual({ y: 1 });
    expect(storage.persistent).toBe(false);
  });
});

class SaveOwner extends Script {
  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'SaveOwner', properties: [] };
  }
  seenAtStart: unknown = null;
  override onAttach(): void {
    this.scene?.storage.migrate(0, 1, data => ({ best: data.score }));
  }
  override onStart(): void {
    this.seenAtStart = this.scene?.storage.get('best', -1);
  }
}

describe('scene.storage in a run', () => {
  it('is read and migrated before the first onStart (HeadlessGameOptions.storage)', async () => {
    const game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': "version: '1.0.0'\nroot:\n  - id: r\n    type: Group2D\n" },
      scripts: { SaveOwner },
      autoloads: [{ singleton: 'SaveOwner', scriptPath: 'scripts/SaveOwner.ts', enabled: true }],
      storage: { snapshot: { version: 0, data: { score: 42 } } },
    });
    await game.start('scenes/main.pix3scene');
    expect(game.scene.getAutoload(SaveOwner)?.seenAtStart).toBe(42);
    expect(game.scene.storage.persistent).toBe(false);
    expect(JSON.parse(game.scene.storage.export())).toEqual({ version: 1, data: { best: 42 } });
    await game.disposeAsync();
  });
});
