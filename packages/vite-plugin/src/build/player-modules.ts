import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { contentTypeFor } from '../files/content-type.ts';
import { globPatterns, SCRIPT_DIRS } from '../sync/script-graph.ts';
import {
  resToAbsolute,
  type LocalizationSettings,
  type ProjectManifestInfo,
} from './project-manifest.ts';

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
export const DEV_ID = 'virtual:pix3/dev';
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
  DEV_ID,
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
    // Autoloads (`pix3project.yaml` `autoloads:`): the player hands them to the runner, which
    // builds them from the project-scripts registry once per session.
    `export const runtimeAutoloads = ${json(model.manifest.autoloads)};`,
    // Multiplayer kind table (D6): the wire Kind is the index into `prefabs`; sorted by code
    // point so every build of this project agrees with the room allowlist.
    `export const netKindTable = ${json({ prefabs: model.netKindPrefabs, authored: [] })};`,
    '',
  ].join('\n');

/** The eager glob root of the project's scripts — the player's `register-project-scripts`. */
export const projectScriptsSource = (): string =>
  `export const modules = import.meta.glob(${JSON.stringify(globPatterns(SCRIPT_DIRS))}, { eager: true });\n`;

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

/** Asset entries largest first, then by path. */
export const largestFirst = (a: EmbeddedAssetEntry, b: EmbeddedAssetEntry): number =>
  b.rawBytes - a.rawBytes || (a.path < b.path ? -1 : 1);

/** Assets that are text and ship as text (`embeddedAssetsSource`). */
const TEXT_ASSET = /\.(svg|pix3scene|prefab|pix3anim|json|atlas|txt|xml|csv)$/i;

/** The bytes as a string when they are valid UTF-8, else null (then they ship as base64). */
const utf8OrNull = (bytes: Buffer): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** `{ [resPath]: { base64 | text, mimeType } }` of every shipped asset (single-file build). */
export const embeddedAssetsSource = async (
  options: EmbeddedAssetsSourceOptions
): Promise<EmbeddedAssetsResult> => {
  const lines: string[] = [];
  const entries: EmbeddedAssetEntry[] = [];
  let rawBytes = 0;
  let base64Bytes = 0;
  for (const resPath of options.assetPaths) {
    const file = await readFile(resToAbsolute(options.root, options.resRoot, resPath));
    const bytes = options.shippedBytes ? options.shippedBytes(resPath, file) : file;
    const mimeType = JSON.stringify(contentTypeFor(resPath).split(';')[0]);
    // A text file ships as its text (an SVG sprite, a scene as JSON, an atlas): a quarter smaller
    // than base64, and the page's gzip packs text far better than base64.
    const text = TEXT_ASSET.test(resPath) ? utf8OrNull(bytes) : null;
    const literal = text === null ? JSON.stringify(bytes.toString('base64')) : JSON.stringify(text);
    rawBytes += bytes.byteLength;
    base64Bytes += literal.length;
    entries.push({ path: resPath, rawBytes: bytes.byteLength, base64Bytes: literal.length });
    lines.push(
      `${JSON.stringify(resPath)}: { ${text === null ? 'base64' : 'text'}: ${literal}, mimeType: ${mimeType} }`
    );
  }
  entries.sort(largestFirst);
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

export interface DevSourceOptions {
  /** This package's `player/debug/index` (the debug overlay), as a file path. */
  readonly overlayPath: string;
  /** This package's `player/dev/editor-link` (the "Pix3 editor" link), as a file path. */
  readonly editorLinkPath: string;
  /** `<base>__pix3/` when the plugin serves the editor, else null (no link). */
  readonly editorUrl: string | null;
}

/**
 * `virtual:pix3/dev`: the player's dev-only hooks. In dev:
 *
 * - `devSceneOverride()` is the URL's `?scene=` (`res://` stripped), the scene the editor's
 *   "Play in Browser Tab / with Profiler" asks for; the player checks it against its scene list;
 * - `installDevTools(context)` imports the debug overlay when the URL has `debug`, otherwise the
 *   "Pix3 editor" link (top-level page, editor on, no `?clean`), so a plain `/` costs one small
 *   module and `/?clean` none.
 *
 * In a build both are no-ops and nothing of the overlay or the link is bundled (a single-file
 * HTML cannot fetch a chunk anyway). The modules are imported by file path, not by a package
 * subpath: Vite's resolver answers bare specifiers from `exports` before any plugin's
 * `resolveId` runs.
 */
export const devSource = (mode: 'dev' | 'none', options?: DevSourceOptions): string => {
  if (mode === 'none' || !options) {
    return [
      '// A build has no dev tools: the debug overlay, the editor link, ?scene= and ?run= are dev-only.',
      'export function devSceneOverride() { return null; }',
      'export function devRunOverrides() { return null; }',
      'export function installDevTools() {}',
      '',
    ].join('\n');
  }
  return [
    `const editorUrl = ${JSON.stringify(options.editorUrl)};`,
    `const params = new URLSearchParams(location.search);`,
    `const failed = what => error => console.error('[pix3] The ' + what + ' failed to load:', error);`,
    `export function devSceneOverride() {`,
    `  const scene = params.get('scene');`,
    `  return scene ? scene.replace(/^res:\\/\\//i, '').replace(/^\\/+/, '') : null;`,
    `}`,
    // \`?run=<json>\` — a test run's seed and component config (\`pix3 play --seed/--config\`).
    `export function devRunOverrides() {`,
    `  const run = params.get('run');`,
    `  if (!run) return null;`,
    `  try { return JSON.parse(run); }`,
    `  catch (error) { console.error('[pix3] ?run= is not JSON:', error); return null; }`,
    `}`,
    `export function installDevTools(context) {`,
    `  if (params.has('debug')) {`,
    `    import(${JSON.stringify(options.overlayPath)}).then(`,
    `      overlay => overlay.mountDebugOverlay(context, { editorUrl }),`,
    `      failed('debug overlay')`,
    `    );`,
    `    return;`,
    `  }`,
    `  if (!editorUrl || window.top !== window || params.has('clean')) return;`,
    `  import(${JSON.stringify(options.editorLinkPath)}).then(`,
    `    link => link.mountEditorLink(editorUrl),`,
    `    failed('editor link')`,
    `  );`,
    `}`,
    '',
  ].join('\n');
};
