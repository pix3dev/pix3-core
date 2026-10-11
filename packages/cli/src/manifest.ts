import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';

import type { TargetPlatform, TemplateInfo } from './templates.ts';

export const PROJECT_MANIFEST_FILE = 'pix3project.yaml';

/**
 * Where the stable project id lives: `metadata.projectId`.
 *
 * Not a top-level `id` — the editor's `normalizeProjectManifest` keeps only the fields it knows and
 * `ProjectService.saveProjectManifest` rewrites the file from that, so a top-level key would be
 * erased the first time the editor rewrote the manifest. `metadata` is round-tripped verbatim.
 * The editor uses the same key (`PROJECT_ID_METADATA_KEY` in editor-core's
 * `src/core/ProjectManifest.ts`) and backfills it once when it opens a project without one.
 */
const PROJECT_ID_METADATA_KEY = 'projectId';

const MANIFEST_VERSION = '1.0.0';

const qualityFor = (platform: TargetPlatform) => {
  switch (platform) {
    case 'mobile':
      return { antialias: false, shadows: false, maxPixelRatio: 2 };
    case 'desktop':
      return { antialias: true, shadows: true, maxPixelRatio: 3 };
    case 'universal':
      return { antialias: true, shadows: true, maxPixelRatio: 2 };
  }
};

export const createProjectId = (): string => randomUUID();

/**
 * The manifest of a new project from `template`, in the key order and format the editor's
 * `ProjectService.saveProjectManifest` writes (`stringify(..., { indent: 2 })`), so the editor's
 * one rewrite of it (the `projectId` backfill, never needed here) would not reorder a line.
 */
export const buildManifestPayload = (
  template: TemplateInfo,
  options: { readonly projectName: string; readonly projectId: string }
): Record<string, unknown> => ({
  version: MANIFEST_VERSION,
  // `undefined` is dropped by the YAML stringifier, as it is in the editor.
  defaultExportScenePath: template.entryScenePath,
  viewportBaseSize: {
    width: Math.max(64, template.viewport.width),
    height: Math.max(64, template.viewport.height),
  },
  ambientOcclusion: 'baked',
  textureFiltering: 'linear',
  projectType: template.projectType,
  targetPlatform: template.targetPlatform,
  quality: qualityFor(template.targetPlatform),
  metadata: {
    projectName: options.projectName,
    templateId: template.id,
    [PROJECT_ID_METADATA_KEY]: options.projectId,
  },
  autoloads: [],
});

export const renderManifest = (payload: Record<string, unknown>): string =>
  stringify(payload, { indent: 2 });

/** Nearest ancestor (inclusive) of `start` that holds a `pix3project.yaml`, or null. */
export const findProjectRoot = (start: string): string | null => {
  let current = resolve(start);
  for (;;) {
    try {
      readFileSync(join(current, PROJECT_MANIFEST_FILE));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};
