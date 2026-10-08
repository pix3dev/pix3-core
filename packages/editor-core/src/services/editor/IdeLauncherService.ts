import { inject, injectable } from '@/fw/di';
import { HostService } from '@/host/HostService';

/**
 * Opens project files in the developer's IDE through the dev server (`EditorHost.openInEditor`,
 * Vite's `/__open-in-editor`). 2.x has no in-browser code editor: a script or a text file is
 * edited where the rest of the game's code is. Callers hide the action when {@link available}
 * is false (a host without the hook, or no host mounted in a spec).
 */
@injectable()
export class IdeLauncherService {
  @inject(HostService)
  private readonly hostService!: HostService;

  get available(): boolean {
    return HostService.isInstalled() && typeof this.hostService.host.openInEditor === 'function';
  }

  /** Open a project path (`res://…` or project-relative) at an optional 1-based line. */
  async open(resourcePath: string, line?: number): Promise<boolean> {
    if (!this.available) {
      return false;
    }
    const host = this.hostService.host;
    try {
      await host.openInEditor?.(this.hostService.wirePath(resourcePath), line);
      return true;
    } catch (error) {
      console.error('[IdeLauncherService] Failed to open in IDE', { resourcePath, error });
      return false;
    }
  }
}
