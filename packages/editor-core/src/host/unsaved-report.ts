import { subscribe } from 'valtio/vanilla';

import type { FlushService } from '@/services/project/FlushService';
import type { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { appState } from '@/state';

import type { HostSync } from './EditorHost';

/** How long the flush on hiding may wait for a gesture to end. */
const FLUSH_ON_HIDE_MS = 5_000;

/**
 * Tell the plugin whether this tab holds unsaved edits, and write them when the tab is hidden
 * (PipeBlast lab B4). Chrome freezes a background tab: it answers no flush, and `pix3 check`,
 * `pix3 smoke` and `vite build` failed with `E_EDITOR_UNSYNCED` although nothing was unsaved. The
 * plugin now takes a frozen writer's last "nothing unsaved" for an answer; a tab that goes hidden
 * with edits writes them first, so it usually freezes clean.
 */
export function installUnsavedReport(
  sync: HostSync,
  flush: FlushService,
  locales: LocalizationEditorService
): () => void {
  const report = sync.reportUnsaved?.bind(sync);
  if (!report) return () => {};
  let last: boolean | null = null;
  const update = (): void => {
    const unsaved =
      flush.dirtySceneIds().length > 0 || flush.isFlushing() || locales.hasUnwrittenTables();
    if (unsaved === last) return;
    last = unsaved;
    report(unsaved);
  };
  const onVisibility = (): void => {
    update();
    if (document.visibilityState !== 'hidden' || !last) return;
    if (appState.project.host.writer === 'other') return;
    void flush.flushDirty(FLUSH_ON_HIDE_MS).finally(update);
  };
  const disposers = [
    subscribe(appState.scenes, update),
    flush.onFlushed(update),
    () => document.removeEventListener('visibilitychange', onVisibility),
    () => document.removeEventListener('freeze', update),
  ];
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('freeze', update);
  update();
  return () => {
    for (const dispose of disposers) dispose();
  };
}
