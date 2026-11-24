import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlushService } from '@/services/project/FlushService';
import type { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';

import type { HostSync } from './EditorHost';
import { installUnsavedReport } from './unsaved-report';

const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('installUnsavedReport (PipeBlast lab B4)', () => {
  afterEach(() => setVisibility('visible'));

  it('reports changes of "unsaved" and writes the edits when the tab is hidden', async () => {
    let dirty: string[] = [];
    let flushed: (() => void) | null = null;
    const flush = {
      dirtySceneIds: () => dirty,
      isFlushing: () => false,
      onFlushed: (listener: () => void) => {
        flushed = listener;
        return () => (flushed = null);
      },
      flushDirty: vi.fn(async () => {
        dirty = [];
        return { ok: true };
      }),
    } as unknown as FlushService;
    const locales = { hasUnwrittenTables: () => false } as unknown as LocalizationEditorService;
    const reports: boolean[] = [];
    const sync = {
      reportUnsaved: (unsaved: boolean) => void reports.push(unsaved),
    } as unknown as HostSync;

    const dispose = installUnsavedReport(sync, flush, locales);
    expect(reports).toEqual([false]);
    dirty = ['scene-a'];
    flushed!();
    flushed!();
    expect(reports).toEqual([false, true]);

    setVisibility('hidden');
    expect(flush.flushDirty).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(reports).toEqual([false, true, false]));

    dispose();
    expect(flushed).toBeNull();
  });

  it('does nothing against a plugin that takes no reports', () => {
    const dispose = installUnsavedReport({} as HostSync, {} as FlushService, {} as never);
    expect(() => dispose()).not.toThrow();
  });
});
