import { diagnostic, type Diagnostic } from './diagnostics.ts';
import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import type { ProjectFiles } from './project.ts';
import { isRecord, parseYamlWithLines } from './yaml-doc.ts';

/**
 * `pix3project.yaml` `export:` — the 1.x build's asset selection (`pruneUnusedAssets`,
 * `extraRootScenePaths`, `includeGlobs`, `excludeGlobs`). No 2.x build reads it and the editor's
 * manifest model no longer carries it (`.plans/player-build.md` P26): what ships is decided by
 * the scan, and build options are `pix3({ … })` in `vite.config.ts`. A warning, so an author who
 * relied on it learns that it does nothing rather than finding out from a missing asset.
 */
export const checkManifestExport = (project: ProjectFiles): Diagnostic[] => {
  if (!project.has(PROJECT_MANIFEST_FILE)) return [];
  const parsed = parseYamlWithLines(project.readText(PROJECT_MANIFEST_FILE));
  if ('errors' in parsed || !isRecord(parsed.data) || !('export' in parsed.data)) return [];
  return [
    diagnostic({
      code: 'W_MANIFEST_EXPORT',
      file: PROJECT_MANIFEST_FILE,
      path: 'export',
      line: parsed.lineOf(['export']),
      message:
        'export: is the asset selection of the 1.x build; the 2.x build ignores it (every scene, ' +
        'prefab and whatever the project references by res:// ships — see dist/<name>.report.json).',
      fix:
        'Delete the export: block. Build options (format, entry scene, compress, strip) are ' +
        'pix3({ … }) in vite.config.ts.',
    }),
  ];
};
