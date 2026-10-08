/** One entry of a project directory listing (`ProjectStorageService.listDirectory`). */
export interface FileDescriptor {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  /** Project path (relative to `res://`). */
  readonly path: string;
  readonly size?: number | null;
}
