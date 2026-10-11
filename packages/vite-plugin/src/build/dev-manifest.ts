import { sceneManifestSource } from './player-modules.ts';
import { readProjectManifest, stripRes, wireToRes } from './project-manifest.ts';
import { discoverLocalization, isPrefabPath, listProjectFiles } from './scan.ts';

/** Dev: `virtual:pix3/scene-manifest` from the disk as it is now (a build uses its scan). */
export const devSceneManifestSource = async (options: {
  readonly root: string;
  readonly resRoot: string;
  readonly entryScene: string | null;
  /** Vite's `base`, ending in `/`. */
  readonly base: string;
}): Promise<string> => {
  const { root, resRoot } = options;
  const manifest = readProjectManifest(root);
  const resPaths = (await listProjectFiles(root))
    .map(path => wireToRes(path, resRoot))
    .filter((path): path is string => path !== null);
  const scenePaths = resPaths
    .filter(path => path.endsWith('.pix3scene') && !isPrefabPath(path))
    .sort();
  const configured = options.entryScene
    ? stripRes(options.entryScene)
    : (manifest.defaultScenePath ?? '');
  const entryScenePath =
    configured && scenePaths.includes(configured)
      ? configured
      : scenePaths.includes('scenes/main.pix3scene')
        ? 'scenes/main.pix3scene'
        : (scenePaths[0] ?? '');
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
