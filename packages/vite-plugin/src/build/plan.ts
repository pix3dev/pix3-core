import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fileOf, realFileOf, relativeInside } from '../module-paths.ts';
import type { CompressedHtml } from './compress.ts';
import { RUNTIME_SPECIFIER, scanDependencyImports } from './dependency-imports.ts';
import { EditorUnsyncedError, flushEditorBeforeBuild } from './editor-flush.ts';
import {
  EMBEDDED_ASSETS_ID,
  SCENE_LIKE_ASSET,
  sceneAsJson,
  type EmbeddedAssetsResult,
} from './player-modules.ts';
import { readProjectManifest, type ProjectManifestInfo } from './project-manifest.ts';
import type { ModuleClassifier, ModuleSize } from './report.ts';
import { scanProject, type ProjectScan } from './scan.ts';
import { decideStrip, runtimeDependents, type StripOption } from './strip-decision.ts';
import { resolveStrippableRuntimeModules, valueExportNames } from './strippable-runtime-modules.ts';

/** What `buildStart` learned about the project for this `vite build`, plus what the bundle told. */
export interface BuildState {
  readonly format: 'html' | 'zip';
  readonly manifest: ProjectManifestInfo;
  readonly scan: ProjectScan;
  /** Module paths (under the runtime's `src/`) replaced by stubs. */
  readonly stripped: ReadonlySet<string>;
  /** `name a dependency may import → the stripped module it keeps` (the transform net). */
  readonly stubbedNames: ReadonlyMap<string, string>;
  readonly stripReason: string | null;
  readonly stripEnabled: boolean;
  /** Whether `pix3({ strip })` was set at all (the net errors only when it was not). */
  readonly stripConfigured: boolean;
  readonly keep: readonly string[];
  /** N11: what the dependencies that declare the runtime import from it, and how many files. */
  readonly dependencyImports: ReadonlySet<string>;
  readonly dependencyParsed: Record<string, number>;
  /** Real path of the runtime's `src/`, or null when it did not resolve. */
  readonly runtimeSrc: string | null;
  /** How the report and the net name a module id. */
  readonly classifier: ModuleClassifier;
  readonly spineInstalled: boolean;
  readonly postprocessingInstalled: boolean;
  /** Scenes ship as JSON and the runtime's `yaml` is `JSON.parse`. */
  readonly stubYaml: boolean;
  /** No model in the project: `GLTFLoader` is a stub. */
  readonly stubGltf: boolean;
  /**
   * Filled by the bundle hooks, for the report: what the hooks actually replaced (a runtime that
   * resolves under another path than the one `buildStart` saw would leave these empty).
   */
  readonly applied: {
    readonly modules: Set<string>;
    yaml: boolean;
    gltf: boolean;
    postprocessing: boolean;
  };
  readonly moduleSizes: ModuleSize[];
  bundleBytes: number;
  assets: EmbeddedAssetsResult | null;
  compressed: CompressedHtml | null;
}

export interface PlanBuildOptions {
  readonly root: string;
  readonly format: 'html' | 'zip';
  readonly resRoot: string;
  readonly entryScene: string | null;
  readonly strip: StripOption | undefined;
  readonly compress: boolean;
  /** This package's directory (the player's modules are grouped as `player`). */
  readonly packageDir: string;
  /** The bundler's resolver from the project's `index.html`: the resolved id, or null. */
  readonly resolve: (specifier: string) => Promise<string | null>;
  /** The bundler's `this.parse`. */
  readonly parse: (code: string) => unknown;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

/** A `.glb`/`.gltf` (any case) or the loader by name. */
const MODEL_MENTION = /^(?:glb|gltf|GLTFLoader)$/i;

/** Step 0: flush the editor that `.pix3/dev.json` points at; an unsynced editor fails the build. */
export const flushEditor = async (
  root: string,
  log: (line: string) => void,
  fail: (message: string) => never
): Promise<void> => {
  try {
    const flushed = await flushEditorBeforeBuild(root);
    if (flushed.status === 'flushed') log(`editor at ${flushed.url} flushed its unsaved scenes`);
    else if (flushed.status === 'no-editor')
      log(`dev server at ${flushed.url}: no editor tab open`);
    else if (flushed.status === 'no-server' && flushed.url)
      log(`no dev server at ${flushed.url} (${flushed.reason}): .pix3/dev.json is stale`);
  } catch (error) {
    if (error instanceof EditorUnsyncedError) fail(`${error.code}: ${error.message}`);
    throw error;
  }
};

/**
 * Plan §B.6 items 1–2: one scan of every text source (the project's and, N11, every dependency
 * that declares the runtime) decides what ships and what the stubs replace.
 */
export const planBuild = async (options: PlanBuildOptions): Promise<BuildState> => {
  const { root, format, log, warn } = options;
  const manifest = readProjectManifest(root);
  const runtime = await options.resolve(RUNTIME_SPECIFIER);
  const runtimeSrc = runtime ? dirname(realFileOf(runtime)) : null;
  if (!runtimeSrc) warn('@pix3/runtime did not resolve from the project; nothing is stripped');
  const spineInstalled = (await options.resolve('@esotericsoftware/spine-threejs')) !== null;
  const postprocessingInstalled = (await options.resolve('postprocessing')) !== null;

  const dependencyScan = await scanDependencyImports({
    root,
    packages: options.strip === false ? [] : runtimeDependents(root),
    parse: options.parse,
  });
  const scan = await scanProject({
    root,
    resRoot: options.resRoot,
    manifest,
    entryScene: options.entryScene,
    dependencies: dependencyScan,
  });
  for (const warning of scan.warnings) warn(warning);
  if (!scan.entryScenePath) warn('no .pix3scene found: the player will have nothing to boot');
  if (scan.usesSpine && !spineInstalled)
    warn('a scene places a SpineSkeleton2D but @esotericsoftware/spine-threejs is not installed');

  const decision = decideStrip(options.strip, dependencyScan);
  const nameSets: readonly ReadonlySet<string>[] = [
    scan.mentionedNames,
    dependencyScan.names,
    dependencyScan.mentionedNames,
    new Set(decision.keep),
  ];
  const mentions = (name: string): boolean => nameSets.some(names => names.has(name));
  const stripped = new Set<string>();
  const stubbedNames = new Map<string, string>();
  if (decision.enabled && runtimeSrc) {
    // Every value export keeps its module too (the barrel re-exports them all): a mention of
    // `pointInPolygon` keeps `collision-shapes-2d`, and the net knows every stubbed name.
    const exportsOf = new Map<string, string[]>();
    const readExports = (modulePath: string): string[] => {
      let names = exportsOf.get(modulePath);
      if (!names) {
        try {
          names = valueExportNames(readFileSync(join(runtimeSrc, `${modulePath}.ts`), 'utf8'));
        } catch {
          names = [];
        }
        exportsOf.set(modulePath, names);
      }
      return names;
    };
    for (const entry of resolveStrippableRuntimeModules(mentions, readExports)) {
      stripped.add(entry.modulePath);
      for (const name of [...entry.keepWhenMentioned, ...readExports(entry.modulePath)])
        stubbedNames.set(name, entry.modulePath);
    }
  }
  // Case-insensitive, like the asset test: `crate.GLB` names a model as well.
  const stubGltf =
    decision.enabled &&
    runtimeSrc !== null &&
    !nameSets.some(names => [...names].some(name => MODEL_MENTION.test(name))) &&
    !scan.assetPaths.some(path => /\.(glb|gltf)$/i.test(path));

  for (const [name, files] of Object.entries(dependencyScan.parsed)) {
    log(
      `${name} depends on ${RUNTIME_SPECIFIER}: ${files} file(s) parsed` +
        (dependencyScan.names.size > 0
          ? `, keeping ${[...dependencyScan.names].sort().join(', ')}`
          : '')
    );
  }
  log(
    `build ${format}${options.compress && format === 'html' ? ' (compressed)' : ''}: ` +
      `entry ${scan.entryScenePath || '(none)'}, ${scan.scenePaths.length} scene(s), ` +
      `${scan.assetPaths.length} asset(s), ${scan.textSourceCount} text source(s) scanned; ` +
      (decision.enabled
        ? `strip on (${stripped.size} module(s)${stubGltf ? ', GLTFLoader' : ''}, scenes as JSON)` +
          (decision.reason ? ` — ${decision.reason}` : '')
        : `strip off — ${decision.reason}`)
  );
  if (options.compress && format === 'zip')
    warn('compress applies to build: "html" only; the zip is written as is');

  return {
    format,
    manifest,
    scan,
    stripped,
    stubbedNames,
    stripReason: decision.reason,
    stripEnabled: decision.enabled,
    stripConfigured: options.strip !== undefined,
    keep: decision.keep,
    dependencyImports: dependencyScan.names,
    dependencyParsed: dependencyScan.parsed,
    runtimeSrc,
    classifier: {
      root,
      runtimeSrc,
      playerDir: options.packageDir,
      embeddedAssetsId: EMBEDDED_ASSETS_ID,
    },
    spineInstalled,
    postprocessingInstalled,
    stubYaml: decision.enabled,
    stubGltf,
    applied: { modules: new Set(), yaml: false, gltf: false, postprocessing: false },
    moduleSizes: [],
    bundleBytes: 0,
    assets: null,
    compressed: null,
  };
};

/** The module path under the runtime's `src/` of a `.ts` module id (`core/Foo`), or null. */
export const runtimeModulePath = (build: BuildState | null, id: string): string | null => {
  if (!build?.runtimeSrc || !fileOf(id).endsWith('.ts')) return null;
  return relativeInside(build.runtimeSrc, realFileOf(id))?.replace(/\.ts$/, '') ?? null;
};

/** The bytes an asset ships as: a scene or prefab as JSON when the runtime's `yaml` is a stub. */
export const shippedBytes = (
  build: BuildState,
  resPath: string,
  bytes: Buffer,
  warn: (line: string) => void
): Buffer => {
  if (!build.stubYaml || !SCENE_LIKE_ASSET.test(resPath)) return bytes;
  try {
    return Buffer.from(sceneAsJson(bytes.toString('utf8')), 'utf8');
  } catch (error) {
    // Not YAML the build can read: ship it as is; the runtime reports it when it loads.
    warn(`${resPath} did not parse as YAML (${String(error)}); shipped as written`);
    return bytes;
  }
};
