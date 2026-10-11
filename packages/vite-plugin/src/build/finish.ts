import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { BuildState } from './plan.ts';
import { fileDigest, writeBuildRecord } from './record.ts';
import {
  buildReportPath,
  gzipBytesOf,
  summarizeCode,
  writeBuildReport,
  type BuildReport,
} from './report.ts';
import { zipDirectory } from './zip.ts';

const kib = (bytes: number): string => (bytes / 1024).toFixed(1);

/** Strip as it happened: off when the runtime did not resolve or nothing planned was replaced. */
const stripOutcome = (
  build: BuildState,
  stripped: readonly string[]
): { enabled: boolean; reason: string | null } => {
  if (!build.stripEnabled) return { enabled: false, reason: build.stripReason };
  if (build.runtimeSrc === null)
    return { enabled: false, reason: '@pix3/runtime did not resolve from the project' };
  if (build.stripped.size > 0 && stripped.length === 0)
    return {
      enabled: false,
      reason: `no runtime module loaded from ${build.runtimeSrc}: nothing was replaced`,
    };
  return { enabled: true, reason: build.stripReason };
};

/** How each optional library resolved, for the report. */
const librariesOf = (build: BuildState): BuildReport['libraries'] => {
  const { applied, scan } = build;
  return {
    yaml: applied.yaml
      ? 'stub: scenes and prefabs ship as JSON'
      : build.stubYaml
        ? 'bundled (scenes ship as JSON)'
        : 'bundled',
    GLTFLoader: applied.gltf ? 'stub: no .glb/.gltf in the project' : 'bundled',
    postprocessing: !build.postprocessingInstalled
      ? 'not installed'
      : applied.postprocessing
        ? 'stub: no PostProcess node'
        : scan.usesPostProcessing
          ? 'bundled (static import)'
          : build.format !== 'html'
            ? 'lazy chunk (the runtime import())'
            : 'bundled (the runtime import(), inlined)',
    spine: !scan.usesSpine
      ? 'not bundled: no SpineSkeleton2D'
      : build.spineInstalled
        ? 'bundled (static import)'
        : 'not installed',
    network: scan.usesNetwork ? 'bundled (NetworkService installed)' : 'no-op',
  };
};

/**
 * The last build hook: the artifact is final, so the zip is written here, then
 * `dist/<name>.report.json` and `.pix3/build.json`.
 */
export const finishBuild = (
  build: BuildState,
  options: {
    readonly root: string;
    readonly outDir: string;
    readonly log: (line: string) => void;
    readonly warn: (line: string) => void;
  }
): void => {
  const { root, outDir, log, warn } = options;
  const htmlPath = join(outDir, 'index.html');
  let artifact = htmlPath;
  if (build.format === 'zip') {
    artifact = zipDirectory(
      outDir,
      `${build.manifest.projectName.replace(/[\\/:*?"<>|]+/g, '-')}.zip`
    );
  } else if (!existsSync(htmlPath)) {
    warn(`no ${htmlPath} after the build: is index.html the project's entry?`);
    return;
  }
  const digest = fileDigest(artifact);
  const at = new Date().toISOString();
  // What the hooks replaced, not what `buildStart` planned: the two differ only when the
  // runtime's modules arrived under ids the plan did not recognise — say so.
  const stripped = [...build.applied.modules].sort();
  const missed = [...build.stripped].filter(path => !build.applied.modules.has(path));
  if (missed.length > 0)
    warn(
      `${missed.length} runtime module(s) planned for stripping were never replaced ` +
        `(${missed.slice(0, 3).join(', ')}${missed.length > 3 ? ', …' : ''}): ` +
        `they did not load from ${build.runtimeSrc ?? 'the resolved runtime'}`
    );
  const strip = stripOutcome(build, stripped);
  const reportPath = buildReportPath(artifact, outDir);
  const { compressed, assets, scan } = build;
  writeBuildReport(reportPath, {
    format: build.format,
    path: artifact,
    at,
    entryScene: scan.entryScenePath,
    scenes: scan.scenePaths.length,
    bytes: digest.bytes,
    gzipBytes: gzipBytesOf(readFileSync(artifact)),
    compress: compressed
      ? {
          enabled: true,
          bundleBytes: compressed.bundleBytes,
          gzipBytes: compressed.gzipBytes,
          base64Bytes: compressed.base64Bytes,
          ratio:
            Math.round((compressed.gzipBytes / Math.max(1, compressed.bundleBytes)) * 1000) / 1000,
          savedBytes: compressed.bundleBytes - compressed.base64Bytes,
        }
      : { enabled: false },
    code: summarizeCode({ bundleBytes: build.bundleBytes, modules: build.moduleSizes }),
    strip: {
      ...strip,
      keep: build.keep,
      stripped,
      dependencies: build.dependencyParsed,
      dependencyImports: [...build.dependencyImports].sort(),
    },
    libraries: librariesOf(build),
    assets: {
      count: scan.assetPaths.length,
      rawBytes: assets?.rawBytes ?? 0,
      base64Bytes: assets?.base64Bytes ?? 0,
      entries: assets?.entries ?? [],
    },
    warnings: scan.warnings,
  });
  writeBuildRecord(root, {
    format: build.format,
    path: artifact,
    ...digest,
    at,
    entryScene: scan.entryScenePath,
    assets: scan.assetPaths.length,
    stripped,
    warnings: scan.warnings,
    report: reportPath,
  });
  log(
    `${build.format}: ${relative(root, artifact)} (${kib(digest.bytes)} KiB` +
      (compressed
        ? `, bundle ${kib(compressed.bundleBytes)} → gzip ${kib(compressed.gzipBytes)} KiB`
        : '') +
      `); report ${relative(root, reportPath)}`
  );
};
