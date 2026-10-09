import { inject, injectable } from '@/fw/di';
import type { HostHistory, HostHistoryEntry } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';

/**
 * The editor's side of the version journal (plan §C.4, `EditorHost.history`). A host without a
 * journal makes every call a no-op: nothing the editor does depends on the journal being there,
 * it is the safety net behind "nothing is lost" (§C.3 step 1) and History → "Restore version".
 */
@injectable()
export class SceneJournalService {
  @inject(HostService)
  private readonly hostService!: HostService;

  private get history(): HostHistory | null {
    return HostService.isInstalled() ? (this.hostService.host.history ?? null) : null;
  }

  get available(): boolean {
    return this.history !== null;
  }

  /** Keep an editor state that did not make it to disk (a merge rejected it, a stale draft). */
  async recordRejectedDraft(path: string, text: string, note: string): Promise<void> {
    const history = this.history;
    if (!history) return;
    try {
      await history.record(this.hostService.wirePath(path), text, 'rejected-draft', note);
    } catch (error) {
      console.warn('[SceneJournalService] could not journal a rejected draft', path, error);
    }
  }

  async list(path: string): Promise<HostHistoryEntry[]> {
    return (await this.history?.list(this.hostService.wirePath(path))) ?? [];
  }

  async read(path: string, id: string): Promise<string | null> {
    return (await this.history?.read(this.hostService.wirePath(path), id)) ?? null;
  }

  /**
   * Write a journaled version back to disk (History → "Restore version"). The plugin journals it
   * as `restore` and reports it like any external change, so the open scene follows the disk
   * through the usual path (§C.3) — and the version it replaced stays in the journal.
   * `ifMatch` is the scene's baseline: a disk that moved meanwhile refuses the restore.
   */
  async restore(path: string, id: string, ifMatch?: string): Promise<void> {
    const history = this.history;
    if (!history) throw new Error('This dev server keeps no version journal.');
    await history.restore(this.hostService.wirePath(path), id, ifMatch ? { ifMatch } : {});
  }
}
