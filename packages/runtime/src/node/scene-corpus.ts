import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerBuiltInScripts } from '../behaviors/register-behaviors';
import { SceneLoader } from '../core/SceneLoader';
import type { SceneGraph } from '../core/SceneManager';
import { SceneSaver, type SavedSceneDocument } from '../core/SceneSaver';
import { ScriptRegistry } from '../core/ScriptRegistry';
import { DiskResourceManager, NodeAssetLoader } from './disk-resources';

/**
 * Spec support: a scene corpus — the starters' scenes (`packages/create-pix3/templates/`) plus the
 * fixture projects in `packages/runtime/fixtures/scene-corpus/` (the 1.x recipe and playable
 * templates, kept as test inputs when `create-pix3` went down to blank starters:
 * `.plans/templates.md`) — and a Node harness that loads, saves and normalises them the way the editor does (`.plans/write-model.md`).
 * Not exported from `@pix3/runtime/node`'s index; specs import it by path
 * (`@pix3/runtime/node/scene-corpus`). Callers install the canvas shim
 * (`installCanvasOnlyDocument`) and silence the loader's console themselves.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `packages/create-pix3/templates`: what `npm create pix3` ships. */
export const TEMPLATES_ROOT = join(HERE, '../../../create-pix3/templates');

/**
 * `packages/runtime/fixtures/scene-corpus`: fixture projects in the template layout
 * (`<id>/template.yaml` + `<id>/files/`), so `pix3 new`'s `createProject` can instantiate them too.
 */
export const CORPUS_ROOT = join(HERE, '../../fixtures/scene-corpus');

export interface CorpusScene {
  /** `<project>:<project-relative path>`, e.g. `recipe-tapper-2d:scenes/main.pix3scene`. */
  readonly name: string;
  readonly projectDir: string;
  /** Project-relative path. */
  readonly path: string;
  readonly text: string;
}

const substitutePlaceholders = (text: string): string =>
  text.split('{{PROJECT_NAME}}').join('Corpus');

const listScenes = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listScenes(full, out);
    else if (entry.endsWith('.pix3scene')) out.push(full);
  }
  return out;
};

/** `<id>/files` project folders under `root`, sorted by id. */
const projectsUnder = (root: string): { id: string; projectDir: string }[] =>
  readdirSync(root)
    .filter(entry => existsSync(join(root, entry, 'files')))
    .sort()
    .map(id => ({ id, projectDir: join(root, id, 'files') }));

/** The starters' scenes and the fixture corpus (ids do not collide: `2d`/`3d` vs the 1.x ids). */
export function templateCorpus(): CorpusScene[] {
  return [...projectsUnder(TEMPLATES_ROOT), ...projectsUnder(CORPUS_ROOT)].flatMap(
    ({ id: templateId, projectDir }) => {
      return listScenes(projectDir)
        .sort()
        .map(full => {
          const path = relative(projectDir, full).replace(/\\/g, '/');
          return {
            name: `${templateId}:${path}`,
            projectDir,
            path,
            text: substitutePlaceholders(readFileSync(full, 'utf8')),
          };
        });
    }
  );
}

/**
 * Scenes of another project, from `PIX3_EXTRA_CORPUS` (a project directory; `res://` = that
 * directory). Not in CI: a local check of a real game before its migration (DeepCore, plan §A.4).
 */
export function extraCorpus(): CorpusScene[] {
  const projectDir = process.env.PIX3_EXTRA_CORPUS;
  if (!projectDir || !existsSync(projectDir)) return [];
  return listScenes(projectDir)
    .filter(full => !/[\\/](node_modules|dist|\.pix3)[\\/]/.test(full))
    .sort()
    .map(full => {
      const path = relative(projectDir, full).replace(/\\/g, '/');
      return { name: `extra:${path}`, projectDir, path, text: readFileSync(full, 'utf8') };
    });
}

export interface SceneHarness {
  parse(text: string, path: string): Promise<SceneGraph>;
  /** `SceneSaver.serializeSceneDocument`, with `undefined` dropped as YAML drops it. */
  normOf(graph: SceneGraph): SavedSceneDocument;
  norm(text: string, path: string): Promise<SavedSceneDocument>;
  /** The saver's YAML (the full-serialization path). */
  save(graph: SceneGraph): string;
}

export function createSceneHarness(projectDir: string): SceneHarness {
  const disk = new DiskResourceManager(projectDir, { transformText: substitutePlaceholders });
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  const loader = new SceneLoader(new NodeAssetLoader(disk), registry, disk);
  const saver = new SceneSaver();
  const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const parse = (text: string, path: string): Promise<SceneGraph> =>
    loader.parseScene(text, { filePath: `res://${path}` });
  return {
    parse,
    normOf: graph => clean(saver.serializeSceneDocument(graph)),
    norm: async (text, path) => clean(saver.serializeSceneDocument(await parse(text, path))),
    save: graph => saver.serializeScene(graph),
  };
}
