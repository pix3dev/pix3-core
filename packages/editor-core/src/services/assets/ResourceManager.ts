import { inject, injectable } from '@/fw/di';
import { ResourceManager as RuntimeResourceManager } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { toProjectPath } from '@/services/project/disk/project-paths';

const RES_SCHEME = 'res';

const missingResource = (resource: string, cause: unknown): Error =>
  new Error(`Resource not found: ${resource}`, { cause });

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('File not found');

/**
 * `res://` reads go to the project through the dev server's file API (`ProjectStorageService`
 * over `EditorHost.files`). There is deliberately no fallback to the page's own origin: the editor
 * is served from `/__pix3/`, and nothing it loads may come from the project's `public/` by
 * accident (plan D11). Other schemes (http(s), data:, blob:) are the runtime's.
 */
@injectable()
class EditorResourceManager extends RuntimeResourceManager {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  constructor() {
    super();
  }

  override async readText(resource: string): Promise<string> {
    if (this.getScheme(resource) !== RES_SCHEME) {
      return super.readText(resource);
    }
    try {
      return await this.storage.readTextFile(toProjectPath(resource));
    } catch (error) {
      throw isNotFound(error) ? missingResource(resource, error) : error;
    }
  }

  override async readBlob(resource: string): Promise<Blob> {
    if (this.getScheme(resource) !== RES_SCHEME) {
      return super.readBlob(resource);
    }
    try {
      return await this.storage.readBlob(toProjectPath(resource));
    } catch (error) {
      throw isNotFound(error) ? missingResource(resource, error) : error;
    }
  }

  override normalize(resource: string): string {
    if (this.getScheme(resource) === RES_SCHEME) {
      return this.storage.normalizeResourcePath(resource);
    }
    return super.normalize(resource);
  }
}

// Re-export as ResourceManager for the rest of the app
export { EditorResourceManager as ResourceManager };
