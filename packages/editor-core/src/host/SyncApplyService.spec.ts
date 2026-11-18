import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { MemoryStorage, wire } from '@/services/project/disk/memory-storage.spec-helper';
import { resetAppState } from '@/state';

import type { SyncInfo } from './EditorHost';
import { SyncApplyService } from './SyncApplyService';

function createSync() {
  const storage = new MemoryStorage();
  const diskState = new SceneBaselineService();
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const externalChanges = wire(new ExternalChangeService(), {
    storage,
    diskState,
    logger,
    hostService: { projectPath: (path: string) => path, info: { tabId: 'me' } },
  });
  // Timers never fire on their own: nothing settles unless the spec ticks.
  externalChanges.configureForTests({ stabilityIntervalMs: 1e9 });
  const reloaded: string[][] = [];
  const scripts = {
    registerRoots: vi.fn(),
    componentsSettled: async () => undefined,
  };
  const sync = wire(new SyncApplyService(), {
    scripts,
    reloads: {
      apply: async (paths: readonly string[]) => {
        reloaded.push([...paths]);
        return { failed: [] };
      },
    },
    externalChanges,
  });
  const roots = { revision: 1 } as unknown as SyncInfo['roots'];
  return { storage, externalChanges, sync, scripts, reloaded, roots };
}

describe('SyncApplyService', () => {
  beforeEach(() => resetAppState());

  it("applies what a frame reported before the sync, though the sync's rescan found nothing", async () => {
    const h = createSync();
    // The agent edited a script; the plugin's watcher settled it and broadcast a pix3:fs frame
    // before the agent's sync, so the sync's own rescan finds nothing changed.
    h.storage.files.set('scripts/Mover.ts', 'v3');
    h.externalChanges.reportFrame({
      seq: 4,
      revision: '4',
      events: [{ op: 'modify', path: 'scripts/Mover.ts', kind: 'file', author: 'external' }],
    });
    expect(await h.sync.apply({ rev: 5, changed: {}, roots: h.roots })).toMatchObject({ ok: true });
    expect(h.reloaded).toEqual([['scripts/Mover.ts']]);
    expect(h.externalChanges.getPendingPaths()).toEqual([]);
    h.externalChanges.dispose();
  });

  it('applies a sync whatever game page is open: registers the roots, reloads what changed', async () => {
    const h = createSync();
    const roots = { revision: 2 } as unknown as SyncInfo['roots'];
    const answer = await h.sync.apply({
      rev: 2,
      changed: { 'scripts/Jumper.ts': 'a'.repeat(64), 'scenes/main.pix3scene': 'b'.repeat(64) },
      roots,
    });
    expect(answer).toMatchObject({ ok: true });
    expect(h.scripts.registerRoots).toHaveBeenCalledWith(roots);
    expect(h.reloaded).toEqual([['scripts/Jumper.ts', 'scenes/main.pix3scene']]);
    h.externalChanges.dispose();
  });

  it('keeps a path reported after the plugin asked, and a version that does not parse', async () => {
    const h = createSync();
    h.storage.files.set('scenes/broken.pix3scene', 'root: [');
    h.externalChanges.report('scenes/broken.pix3scene');
    await h.externalChanges.tick();
    await h.externalChanges.tick(); // settled, does not parse: failing
    h.storage.files.set('scripts/A.ts', 'a');
    const apply = h.sync.apply({ rev: 2, changed: {}, roots: h.roots });
    h.externalChanges.report('scripts/A.ts'); // a newer write, after the request
    await apply;
    expect(h.reloaded).toEqual([[]]);
    expect(h.externalChanges.getPendingPaths().sort()).toEqual([
      'scenes/broken.pix3scene',
      'scripts/A.ts',
    ]);
    h.externalChanges.dispose();
  });
});
