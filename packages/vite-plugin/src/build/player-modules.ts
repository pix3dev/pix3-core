import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

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

/** What `yaml` resolves to for the runtime when the scenes ship as JSON. */
export const YAML_STUB_ID = 'virtual:pix3/yaml-stub';
/** What `three/examples/jsm/loaders/GLTFLoader.js` resolves to when no model is shipped. */
export const GLTF_LOADER_STUB_ID = 'virtual:pix3/gltf-loader-stub';

export const PLAYER_VIRTUAL_IDS: readonly string[] = [
  SCENE_MANIFEST_ID,
  EMBEDDED_ASSETS_ID,
  PROJECT_SCRIPTS_ID,
  SPINE_ID,
  POSTPROCESSING_ID,
  NETWORK_ID,
  POSTPROCESSING_STUB_ID,
  YAML_STUB_ID,
  GLTF_LOADER_STUB_ID,
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
  /** The bytes that ship for a path (a scene as JSON, say); the file's own bytes by default. */
  readonly shippedBytes?: (resPath: string, bytes: Buffer) => Buffer;
}

export interface EmbeddedAssetEntry {
  readonly path: string;
  readonly rawBytes: number;
  readonly base64Bytes: number;
}

export interface EmbeddedAssetsResult {
  readonly source: string;
  readonly rawBytes: number;
  readonly base64Bytes: number;
  readonly count: number;
  /** Largest first. */
  readonly entries: readonly EmbeddedAssetEntry[];
}

/** `{ [resPath]: { base64, mimeType } }` of every shipped asset (single-file build). */
export const embeddedAssetsSource = async (
  options: EmbeddedAssetsSourceOptions
): Promise<EmbeddedAssetsResult> => {
  const lines: string[] = [];
  const entries: EmbeddedAssetEntry[] = [];
  let rawBytes = 0;
  let base64Bytes = 0;
  for (const resPath of options.assetPaths) {
    const absolute =
      options.resRoot === '.'
        ? join(options.root, ...resPath.split('/'))
        : join(options.root, options.resRoot, ...resPath.split('/'));
    const file = await readFile(absolute);
    const bytes = options.shippedBytes ? options.shippedBytes(resPath, file) : file;
    const base64 = bytes.toString('base64');
    rawBytes += bytes.byteLength;
    base64Bytes += base64.length;
    entries.push({ path: resPath, rawBytes: bytes.byteLength, base64Bytes: base64.length });
    lines.push(
      `${JSON.stringify(resPath)}: { base64: ${JSON.stringify(base64)}, mimeType: ${JSON.stringify(contentTypeFor(resPath).split(';')[0])} }`
    );
  }
  entries.sort((a, b) => b.rawBytes - a.rawBytes || (a.path < b.path ? -1 : 1));
  return {
    source: `export const embeddedAssets = {\n${lines.join(',\n')}\n};\n`,
    rawBytes,
    base64Bytes,
    count: options.assetPaths.length,
    entries,
  };
};

/** Scene-shaped resources (`.pix3scene`, `.prefab`): the ones the runtime parses as YAML. */
export const SCENE_LIKE_ASSET = /\.(pix3scene|prefab)$/i;

/**
 * A scene's bytes for a build that stubs `yaml` ({@link yamlStubSource}): the same document as
 * JSON. JSON is YAML, so a project script that reads the text with its own `yaml` import still
 * parses it; the runtime's `parse` becomes `JSON.parse`. The 1.x export did the same.
 */
export const sceneAsJson = (text: string): string => JSON.stringify(parseYaml(text));

/**
 * What `yaml` resolves to **for the runtime's own importers** (`SceneLoader`, `SceneSaver`) when
 * every scene ships as JSON: `parse` is `JSON.parse`, `stringify` throws (a player never writes a
 * scene — `SceneSaver` is not even constructed, so this tree-shakes out). A project module that
 * imports `yaml` itself keeps the real parser; this stub is decided per importer.
 */
export const yamlStubSource = (): string =>
  [
    '// Scenes and prefabs ship as JSON in this build: the YAML parser is not bundled.',
    'export const parse = text => JSON.parse(text);',
    "export const stringify = () => { throw new Error('[Pix3] yaml.stringify was stripped from this build: a player never writes scenes.'); };",
    'export default { parse, stringify };',
    '',
  ].join('\n');

/** The specifier `AssetLoader` imports the loader by. */
export const GLTF_LOADER_SPECIFIER = 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * `GLTFLoader` (three addons, ~100 KiB rendered) is value-imported by `AssetLoader` for every
 * build; a project with no `.glb`/`.gltf` asset and no script naming `GLTFLoader` gets a loader
 * that fails the way a missing file would (the 1.x `gltf-loader-stub`).
 */
export const gltfLoaderStubSource = (): string =>
  [
    '// Stripped from this build: no scene or script names a .glb/.gltf model.',
    "const stripped = () => new Error('[Pix3] GLTFLoader was stripped from this build because no scene or script names a .glb/.gltf model.');",
    'export class GLTFLoader {',
    '  setPath() { return this; }',
    '  setResourcePath() { return this; }',
    '  setDRACOLoader() { return this; }',
    '  setKTX2Loader() { return this; }',
    '  setMeshoptDecoder() { return this; }',
    '  register() { return this; }',
    '  unregister() { return this; }',
    '  load(_url, _onLoad, _onProgress, onError) { const error = stripped(); if (onError) onError(error); else throw error; }',
    '  loadAsync() { return Promise.reject(stripped()); }',
    '  parse(_data, _path, _onLoad, onError) { const error = stripped(); if (onError) onError(error); else throw error; }',
    '  parseAsync() { return Promise.reject(stripped()); }',
    '}',
    '',
  ].join('\n');

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
