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
 * Spec support: the template scenes of `packages/create-pix3/templates/` as a corpus, and a Node
 * harness that loads, saves and normalises them the way the editor does (`.plans/write-model.md`).
 * Not exported from `@pix3/runtime/node`'s index; specs import it by path
 * (`@pix3/runtime/node/scene-corpus`). Callers install the canvas shim
 * (`installCanvasOnlyDocument`) and silence the loader's console themselves.
 */

export const TEMPLATES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../create-pix3/templates'
);

export interface CorpusScene {
  /** `<template>:<project-relative path>`, e.g. `recipe-tapper-2d:scenes/main.pix3scene`. */
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

export function templateCorpus(): CorpusScene[] {
  return readdirSync(TEMPLATES_ROOT)
    .filter(entry => existsSync(join(TEMPLATES_ROOT, entry, 'files')))
    .sort()
    .flatMap(templateId => {
      const projectDir = join(TEMPLATES_ROOT, templateId, 'files');
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
