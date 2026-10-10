import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { MemoryStorage, wire } from '@/services/project/disk/memory-storage.spec-helper';
import { appState, resetAppState } from '@/state';

import type { SyncInfo } from './EditorHost';
import { pendingDuringPlay, SyncApplyService } from './SyncApplyService';

describe('pendingDuringPlay', () => {
  it('holds game files for play to stop, but not bot policies (the next run reads them)', () => {
    expect(
      pendingDuringPlay(
        ['scripts/Player.ts', 'design/tests/bots/dodge.ts', 'design/tests/bots/lib/aim.ts'],
        ['scenes/main.pix3scene', 'scripts/Player.ts']
      )
    ).toEqual(['scripts/Player.ts', 'scenes/main.pix3scene']);
    // The page's own frame queue holds the policy too (a pix3:fs frame arrived during play).
    expect(
      pendingDuringPlay(['design/tests/bots/dodge.ts'], ['design/tests/bots/dodge.ts'])
    ).toEqual([]);
    // A helper outside the policy folder may be the game's too: it waits…
    expect(pendingDuringPlay(['design/tests/lib/aim.ts'], [])).toEqual(['design/tests/lib/aim.ts']);
    // …unless the plugin's graph says only policies import it (S11), whichever queue holds it.
    expect(
      pendingDuringPlay(
        ['design/tests/lib/aim.ts', 'src/game/rules.ts'],
        ['design/tests/lib/aim.ts'],
        ['design/tests/bots/dodge.ts', 'design/tests/lib/aim.ts']
      )
    ).toEqual(['src/game/rules.ts']);
  });
});

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
  const sync = wire(new SyncApplyService(), {
    scripts: { registerRoots: vi.fn(), componentsSettled: async () => undefined },
    reloads: {
      apply: async (paths: readonly string[]) => {
        reloaded.push([...paths]);
        return { failed: [] };
      },
    },
    externalChanges,
  });
  const roots = { revision: 1 } as unknown as SyncInfo['roots'];
  return { storage, externalChanges, sync, reloaded, roots };
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

    // Play starts at once (before the frame's entry would have settled), then a bot policy is
    // added: the sync applies it without a restart — the script was applied by the sync above.
    appState.ui.isPlaying = true;
    appState.ui.playOwner = 'agent';
    await h.externalChanges.tick();
    await h.externalChanges.tick();
    const during = await h.sync.apply({
      rev: 6,
      changed: { 'design/tests/bots/rush.ts': 'a'.repeat(64) },
      roots: h.roots,
    });
    expect(during).toMatchObject({ ok: true, playing: 'agent' });
    h.externalChanges.dispose();
  });

  it('during play, a helper only policies import is applied; a game module still waits (S11)', async () => {
    const h = createSync();
    appState.ui.isPlaying = true;
    appState.ui.playOwner = 'agent';
    // The watcher's frame got there first: the helper sits in the page's queue as well.
    h.storage.files.set('design/tests/lib/aim.ts', 'v2');
    h.externalChanges.reportFrame({
      seq: 2,
      revision: '2',
      events: [{ op: 'modify', path: 'design/tests/lib/aim.ts', kind: 'file', author: 'external' }],
    });
    const helper = { 'design/tests/lib/aim.ts': 'b'.repeat(64) };
    const policyOnly = ['design/tests/bots/dodge.ts', 'design/tests/lib/aim.ts'];
    expect(
      await h.sync.apply({ rev: 3, changed: helper, roots: h.roots, policyOnly })
    ).toMatchObject({ ok: true, playing: 'agent' });
    // An older plugin sends no list: the helper waits for play to stop, as before.
    expect(await h.sync.apply({ rev: 3, changed: helper, roots: h.roots })).toMatchObject({
      ok: false,
      reason: 'stale',
      pending: ['design/tests/lib/aim.ts'],
    });
    expect(
      await h.sync.apply({
        rev: 4,
        changed: { 'src/game/rules.ts': 'c'.repeat(64) },
        roots: h.roots,
        policyOnly,
      })
    ).toMatchObject({ ok: false, reason: 'stale', pending: ['src/game/rules.ts'] });
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
