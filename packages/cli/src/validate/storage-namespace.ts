import { isProjectScriptPath } from '@pix3/runtime';

import { createStorageNamespace, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { diagnostic, type Diagnostic } from './diagnostics.ts';
import type { ProjectFiles } from './project.ts';
import { isRecord, parseYamlWithLines } from './yaml-doc.ts';

/** The plugin's rule (`STORAGE_NAMESPACE_PATTERN` in `@pix3/vite-plugin`'s `project-manifest.ts`). */
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * `pix3project.yaml` `storage.namespace` — the key of the game's save (`pix3:<namespace>:save`).
 * Without a valid one the player falls back to the project name as a slug, and two games of the
 * same name on one origin (a portal) share a save. `pix3 new` writes one; an older project hears
 * about it once a script uses `scene.storage` (or when the value it wrote is not a namespace).
 */
export const checkStorageNamespace = (project: ProjectFiles): Diagnostic[] => {
  if (!project.has(PROJECT_MANIFEST_FILE)) return [];
  const parsed = parseYamlWithLines(project.readText(PROJECT_MANIFEST_FILE));
  if ('errors' in parsed || !isRecord(parsed.data)) return [];
  const storage = parsed.data.storage;
  const written = isRecord(storage) ? storage.namespace : undefined;
  if (typeof written === 'string' && NAMESPACE.test(written)) return [];
  if (
    written === undefined &&
    !project.files.some(
      file =>
        isProjectScriptPath(file) &&
        SCRIPT_SOURCE.test(file) &&
        /\bstorage\b/.test(project.readText(file))
    )
  ) {
    return [];
  }
  const metadata = isRecord(parsed.data.metadata) ? parsed.data.metadata : {};
  const name = typeof metadata.projectName === 'string' ? metadata.projectName : 'game';
  return [
    diagnostic({
      code: 'W_STORAGE_NAMESPACE',
      file: PROJECT_MANIFEST_FILE,
      path: written === undefined ? 'storage' : 'storage.namespace',
      line: parsed.lineOf(written === undefined ? ['storage'] : ['storage', 'namespace']),
      message:
        written === undefined
          ? 'no storage.namespace: scene.storage keys the save by the project name, which another game on the same origin can share.'
          : 'storage.namespace is not letters, digits, ".", "_" or "-" (starting with a letter or digit); the save is keyed by the project name instead.',
      fix: `storage:\n  namespace: ${createStorageNamespace(name)}`,
    }),
  ];
};
