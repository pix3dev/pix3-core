import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { contentTypeFor } from '../files/content-type.ts';
import { SCRIPT_DIRS } from '../sync/script-graph.ts';
import type { LocalizationSettings, ProjectManifestInfo } from './project-manifest.ts';

/**
 * The `virtual:pix3/*` modules the player (`@pix3/vite-plugin/player`) imports (plan §B.5). Each
 * is generated here from the project, in dev from `pix3project.yaml` and the scene list, in a
 * build from the scan (`scan.ts`). The seams for the optional libraries are **static** imports
 * inside the generated module — a dynamic import would become a chunk a single-file HTML can never
 * fetch, and a bare specifier left unaliased is silently externalised (the 1.x `postprocessing`
 * bug, CLAUDE.md «Playable export size»).
 */

export const SCENE_MANIFEST_ID = 'virtual:pix3/scene-manifest';
export const EMBEDDED_ASSETS_ID = 'virtual:pix3/embedded-assets';
export const PROJECT_SCRIPTS_ID = 'virtual:pix3/project-scripts';
export const SPINE_ID = 'virtual:pix3/spine';
export const POSTPROCESSING_ID = 'virtual:pix3/postprocessing';
export const NETWORK_ID = 'virtual:pix3/network';
/** What `postprocessing` resolves to in a single-file build whose scenes place no `PostProcess`. */
export const POSTPROCESSING_STUB_ID = 'virtual:pix3/postprocessing-stub';

export const PLAYER_VIRTUAL_IDS: readonly string[] = [
  SCENE_MANIFEST_ID,
  EMBEDDED_ASSETS_ID,
  PROJECT_SCRIPTS_ID,
  SPINE_ID,
  POSTPROCESSING_ID,
  NETWORK_ID,
  POSTPROCESSING_STUB_ID,
];

export interface SceneManifestModel {
  readonly scenePaths: readonly string[];
  readonly entryScenePath: string;
  readonly manifest: ProjectManifestInfo;
  readonly localization: LocalizationSettings | null;
  readonly netKindPrefabs: readonly string[];
  /** `ResourceManager` base: `/<resRoot>/` in dev, `./` for a build. */
  readonly resourceBase: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const sceneManifestSource = (model: SceneManifestModel): string =>
  [
    `export const scenePaths = ${json(model.scenePaths)};`,
    `export const activeScenePath = ${json(model.entryScenePath)};`,
    `export const resourceBase = ${json(model.resourceBase)};`,
    `export const projectName = ${json(model.manifest.projectName)};`,
    `export const runtimeViewportBaseSize = ${json(model.manifest.viewportBaseSize)};`,
    `export const runtimeQuality = ${json(model.manifest.quality)};`,
    `export const runtimeFonts = ${json(model.manifest.fonts)};`,
    `export const runtimeLocalization = ${json(model.localization)};`,
    // Multiplayer kind table (D6): the wire Kind is the index into `prefabs`; sorted by code
    // point so every build of this project agrees with the room allowlist.
    `export const netKindTable = ${json({ prefabs: model.netKindPrefabs, authored: [] })};`,
    '',
  ].join('\n');

/** The eager glob root of the project's scripts — the player's `register-project-scripts`. */
export const projectScriptsSource = (): string => {
  const patterns: string[] = [];
  for (const dir of SCRIPT_DIRS) {
    patterns.push(
      `/${dir}/**/*.ts`,
      `!/${dir}/**/*.spec.ts`,
      `!/${dir}/**/*.test.ts`,
      `!/${dir}/**/*.d.ts`
    );
  }
  return `export const modules = import.meta.glob(${JSON.stringify(patterns)}, { eager: true });\n`;
};

export interface EmbeddedAssetsSourceOptions {
  readonly root: string;
  readonly resRoot: string;
  /** `res://`-relative paths to embed. */
  readonly assetPaths: readonly string[];
}

export interface EmbeddedAssetsResult {
  readonly source: string;
  readonly rawBytes: number;
  readonly count: number;
}

/** `{ [resPath]: { base64, mimeType } }` of every shipped asset (single-file build). */
export const embeddedAssetsSource = async (
  options: EmbeddedAssetsSourceOptions
): Promise<EmbeddedAssetsResult> => {
  const entries: string[] = [];
  let rawBytes = 0;
  for (const resPath of options.assetPaths) {
    const absolute =
      options.resRoot === '.'
        ? join(options.root, ...resPath.split('/'))
        : join(options.root, options.resRoot, ...resPath.split('/'));
    const bytes = await readFile(absolute);
    rawBytes += bytes.byteLength;
    entries.push(
      `${JSON.stringify(resPath)}: { base64: ${JSON.stringify(bytes.toString('base64'))}, mimeType: ${JSON.stringify(contentTypeFor(resPath).split(';')[0])} }`
    );
  }
  return {
    source: `export const embeddedAssets = {\n${entries.join(',\n')}\n};\n`,
    rawBytes,
    count: options.assetPaths.length,
  };
};

export const noEmbeddedAssetsSource = (): string => `export const embeddedAssets = {};\n`;

/**
 * `virtual:pix3/spine`. Dev: the lazy loader (`virtual:pix3/spine-loader` decides whether the
 * package is installed). Build: a static import when a scene places a `SpineSkeleton2D` and the
 * package is installed, nothing otherwise.
 */
export const spineSource = (mode: 'dev' | 'static' | 'none'): string => {
  if (mode === 'none') {
    return '// No SpineSkeleton2D in this project: Spine is not bundled.\nexport {};\n';
  }
  if (mode === 'static') {
    return [
      `import * as spine from '@esotericsoftware/spine-threejs';`,
      `import { setSpineModuleLoader } from '@pix3/runtime';`,
      `setSpineModuleLoader(() => Promise.resolve(spine));`,
      '',
    ].join('\n');
  }
  return [
    `import { loadSpine } from 'virtual:pix3/spine-loader';`,
    `import { setSpineModuleLoader } from '@pix3/runtime';`,
    `setSpineModuleLoader(async () => {`,
    `  const spine = await loadSpine();`,
    `  if (!spine) throw new Error('This scene uses Spine, but @esotericsoftware/spine-threejs is not installed in the project.');`,
    `  return spine;`,
    `});`,
    '',
  ].join('\n');
};

/**
 * `virtual:pix3/postprocessing`. The runtime's default is `import('postprocessing')`, which is
 * right in dev and in a zip (a chunk can be fetched). A single-file build registers the module
 * statically when a scene places a `PostProcess`; otherwise `postprocessing` itself resolves to
 * {@link postprocessingStubSource}, so the inlined dynamic import costs nothing.
 */
export const postprocessingSource = (mode: 'default' | 'static'): string =>
  mode === 'static'
    ? [
        `import * as postprocessing from 'postprocessing';`,
        `import { setPostprocessingModuleLoader } from '@pix3/runtime';`,
        `setPostprocessingModuleLoader(() => Promise.resolve(postprocessing));`,
        '',
      ].join('\n')
    : '// No PostProcess node in this project: the effect stack is not registered.\nexport {};\n';

export const postprocessingStubSource = (): string =>
  [
    '// Stripped from this build: no scene places a PostProcess node.',
    `const stripped = () => { throw new Error('[Pix3] postprocessing was stripped from this build because no scene places a PostProcess node.'); };`,
    'export const EffectComposer = stripped;',
    'export const RenderPass = stripped;',
    'export const EffectPass = stripped;',
    'export const ClearPass = stripped;',
    'export const NormalPass = stripped;',
    'export const DepthDownsamplingPass = stripped;',
    'export const BloomEffect = stripped;',
    'export const VignetteEffect = stripped;',
    'export const ChromaticAberrationEffect = stripped;',
    'export const SSAOEffect = stripped;',
    'export const BlendFunction = {};',
    'export const KernelSize = {};',
    '',
  ].join('\n');

/** `virtual:pix3/network`: the real installer, or a no-op that keeps `net/**` out of the bundle. */
export const networkSource = (usesNetwork: boolean): string =>
  usesNetwork
    ? [
        `import { NetworkService, setNetworkPrefabTable } from '@pix3/runtime';`,
        `import { netKindTable } from 'virtual:pix3/scene-manifest';`,
        `export function installNetworkService(runner) {`,
        `  setNetworkPrefabTable(netKindTable);`,
        `  runner.setNetworkService(new NetworkService());`,
        `}`,
        '',
      ].join('\n')
    : [
        '// Nothing in this project mentions multiplayer: `net/**` is not bundled.',
        'export function installNetworkService() {}',
        '',
      ].join('\n');
