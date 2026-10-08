import { injectable } from '@/fw/di';

import type { EditorHost, HostInfo } from './EditorHost';

let installed: EditorHost | null = null;

/**
 * Root-relative wire paths that stay root-relative whatever `resRoot` is: the project manifest,
 * the script and bot-policy roots of `virtual:pix3/editor-scripts` / `bot-policies`. Everything
 * else the editor names is a `res://` path under `resRoot`.
 */
const ROOT_RELATIVE = ['pix3project.yaml', 'scripts/', 'src/scripts/', 'design/', '.pix3/'];

/**
 * The mounted {@link EditorHost}, for services (`mountEditor` installs it before anything resolves).
 * Also owns the one mapping between the editor's project paths (`res://x`, or `x`) and the host's
 * wire paths (relative to the Vite root).
 */
@injectable()
export class HostService {
  static install(host: EditorHost): void {
    installed = host;
  }

  /** For specs: forget the installed host. */
  static reset(): void {
    installed = null;
  }

  static isInstalled(): boolean {
    return installed !== null;
  }

  get host(): EditorHost {
    if (!installed) throw new Error('No EditorHost installed: mountEditor() has not run.');
    return installed;
  }

  get info(): HostInfo {
    return this.host.info;
  }

  /** `res://scenes/a.pix3scene`, `./scenes/a.pix3scene`, `scenes/a.pix3scene` → `scenes/a.pix3scene`. */
  static normalize(path: string): string {
    if (!path || path === '.') return '.';
    return (
      path
        .replace(/\\+/g, '/')
        .replace(/^res:\/\//i, '')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '') || '.'
    );
  }

  /** Project path → wire path (prefixed with `resRoot` unless root-relative). */
  wirePath(path: string): string {
    const normalized = HostService.normalize(path);
    const resRoot = HostService.normalize(this.info.resRoot);
    if (
      resRoot === '.' ||
      ROOT_RELATIVE.some(prefix => normalized === prefix || normalized.startsWith(prefix))
    ) {
      return normalized;
    }
    return normalized === '.' ? resRoot : `${resRoot}/${normalized}`;
  }

  /** Wire path → project path; null when it lies outside `resRoot` (and is not root-relative). */
  projectPath(wirePath: string): string | null {
    const resRoot = HostService.normalize(this.info.resRoot);
    if (
      resRoot === '.' ||
      ROOT_RELATIVE.some(prefix => wirePath === prefix || wirePath.startsWith(prefix))
    ) {
      return wirePath;
    }
    if (wirePath === resRoot) return '.';
    return wirePath.startsWith(`${resRoot}/`) ? wirePath.slice(resRoot.length + 1) : null;
  }
}
