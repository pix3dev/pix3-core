import { sceneManifestSource } from './player-modules.ts';
import { readProjectManifest, wireToRes } from './project-manifest.ts';
import {
  discoverLocalization,
  isPlayableScenePath,
  listProjectFiles,
  resolveEntryScene,
} from './scan.ts';

/** Dev: `virtual:pix3/scene-manifest` from the disk as it is now (a build uses its scan). */
export const devSceneManifestSource = async (options: {
  readonly root: string;
  readonly resRoot: string;
  readonly entryScene: string | null;
  /** Vite's `base`, ending in `/`. */
  readonly base: string;
  /** Where an entry scene that does not exist is reported (as a build reports it). */
  readonly warn: (line: string) => void;
}): Promise<string> => {
  const { root, resRoot } = options;
  const manifest = readProjectManifest(root);
  const resPaths = (await listProjectFiles(root))
    .map(path => wireToRes(path, resRoot))
    .filter((path): path is string => path !== null);
  const scenePaths = resPaths.filter(isPlayableScenePath).sort();
  const warnings: string[] = [];
  const entryScenePath = resolveEntryScene(scenePaths, manifest, options.entryScene, warnings);
  for (const line of warnings) options.warn(line);
  return sceneManifestSource({
    scenePaths,
    entryScenePath,
    manifest,
    // As the build and the editor: the manifest's block, else the tables `locales/` has.
    localization: manifest.localization ?? discoverLocalization(new Set(resPaths)),
    netKindPrefabs: [],
    resourceBase: `${options.base}${resRoot === '.' ? '' : `${resRoot}/`}`,
  });
};
