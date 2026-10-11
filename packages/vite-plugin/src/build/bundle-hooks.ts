import { readFileSync } from 'node:fs';

import type { Rollup } from 'vite';

import { isUnder, realFileOf } from '../module-paths.ts';
import { collectRuntimeImports, RUNTIME_SPECIFIER } from './dependency-imports.ts';
import { shippedBytes, type BuildState } from './plan.ts';
import { largestFirst, type EmbeddedAssetEntry } from './player-modules.ts';
import { resToAbsolute } from './project-manifest.ts';
import { classifyModule, displayId } from './report.ts';
import { KEEP_HINT } from './strip-decision.ts';

/** Every chunk's per-module rendered sizes, for the report. */
export const recordModuleSizes = (build: BuildState, bundle: Rollup.OutputBundle): void => {
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    build.bundleBytes += Buffer.byteLength(output.code, 'utf8');
    for (const [id, rendered] of Object.entries(output.modules)) {
      const { group, package: pkg } = classifyModule(id, build.classifier);
      build.moduleSizes.push({
        id: displayId(id, build.classifier),
        group,
        package: pkg,
        renderedBytes: rendered.renderedLength,
      });
    }
  }
};

/** `build: 'zip'`: every asset beside `index.html`, under its `res://` path. */
export const emitZipAssets = (
  build: BuildState,
  options: {
    readonly root: string;
    readonly resRoot: string;
    readonly emit: (fileName: string, source: Buffer) => void;
    readonly warn: (line: string) => void;
  }
): void => {
  const entries: EmbeddedAssetEntry[] = [];
  for (const resPath of build.scan.assetPaths) {
    const file = readFileSync(resToAbsolute(options.root, options.resRoot, resPath));
    const source = shippedBytes(build, resPath, file, options.warn);
    entries.push({ path: resPath, rawBytes: source.byteLength, base64Bytes: 0 });
    options.emit(resPath, source);
  }
  build.assets = {
    source: '',
    count: entries.length,
    rawBytes: entries.reduce((sum, entry) => sum + entry.rawBytes, 0),
    base64Bytes: 0,
    entries: entries.sort(largestFirst),
  };
};

/**
 * The N11 safety net (`transform`): a `node_modules` module the bundle pulls in (a transitive
 * dependency, one that does not declare the runtime) or a file outside the project importing
 * something this build stripped. Returns the error to raise, or null; a forced strip only warns.
 */
export const strippedImportError = (
  build: BuildState,
  code: string,
  id: string,
  options: {
    readonly root: string;
    readonly packageDir: string;
    readonly forced: boolean;
    readonly parse: (code: string) => unknown;
    readonly warn: (line: string) => void;
  }
): string | null => {
  if (!build.stripEnabled || id.startsWith('\0') || !code.includes(RUNTIME_SPECIFIER)) return null;
  const file = realFileOf(id);
  if (isUnder(file, build.runtimeSrc) || isUnder(file, realFileOf(options.packageDir))) return null;
  if (!id.includes('/node_modules/') && isUnder(file, realFileOf(options.root))) return null;
  const label = displayId(id, build.classifier);
  let findings;
  try {
    findings = collectRuntimeImports(options.parse(code), label);
  } catch {
    return null; // not JS the bundler can parse here (it will say so itself)
  }
  const hits = [...findings.names].filter(name => build.stubbedNames.has(name)).sort();
  if (hits.length > 0) {
    const message =
      `${label} imports ${hits.join(', ')} from ${RUNTIME_SPECIFIER}, which this build ` +
      `stripped (nothing in the project mentions ${hits.length > 1 ? 'them' : 'it'}). ` +
      `Add ${hits.map(name => `'${name}'`).join(', ')} to pix3({ strip: { keep } })` +
      (options.forced ? '' : ', or pass strip: false');
    if (!options.forced) return message;
    options.warn(message);
  }
  if (findings.opaque.length > 0 && !build.stripConfigured) {
    return (
      `${findings.opaque[0]} — the build cannot see which runtime modules it reaches. ` +
      `Name them with ${KEEP_HINT}, or pass strip: false`
    );
  }
  return null;
};
