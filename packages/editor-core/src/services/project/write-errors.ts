import type { HostFileFailure } from '@/host/EditorHost';

/**
 * A conditional write was refused: the file on disk is no longer the version the editor based its
 * edit on (`If-Match` → 412). Never a silent overwrite of someone else's change.
 */
export class SceneWriteConflictError extends Error {
  readonly path: string;
  /** The disk's sha256 now (`null` = the file is gone). */
  readonly currentHash: string | null;

  constructor(path: string, failure: HostFileFailure) {
    super(`${path} changed on disk since the editor loaded it.`);
    this.name = 'SceneWriteConflictError';
    this.path = path;
    this.currentHash = failure.currentHash ?? null;
  }
}

/** This tab is not the writer (another tab took over, or none was granted). */
export class ReadOnlyTabError extends Error {
  constructor(message = 'This tab is read-only: another editor tab is writing to this project.') {
    super(message);
    this.name = 'ReadOnlyTabError';
  }
}
