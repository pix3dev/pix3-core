import { writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * `dist/<name>.report.json` (plan §B.6 item 5): why the artifact weighs what it does, written
 * beside it so whoever ran `npm run build` (the coding agent first of all) can answer "why is it
 * this big" without rebuilding — CLAUDE.md «Playable export size» is the prose, this is the
 * numbers for one build.
 *
 * Module sizes come from the bundler's per-chunk `modules` map (`renderedLength`: the module's
 * code after tree-shaking, **before minification**), grouped by where the id lives: `three`,
 * `runtime` (`@pix3/runtime`'s `src/`), `player` (this package's player and the generated
 * `virtual:pix3/*` modules), `project` (the project's own sources), `assets` (the embedded-asset
 * module) and `dependencies` (every other `node_modules` package, listed by name). Each group also
 * carries an estimate of its share of the final minified bundle (its rendered share scaled to the
 * bundle's size), which is the number to quote.
 */

export type ModuleGroup =
  | 'three'
  | 'runtime'
  | 'player'
  | 'project'
  | 'assets'
  | 'dependencies'
  | 'other';

export interface ModuleSize {
  readonly id: string;
  readonly group: ModuleGroup;
  /** Package name for `dependencies` and `three`, null otherwise. */
  readonly package: string | null;
  readonly renderedBytes: number;
}

export interface GroupSize {
  readonly modules: number;
  readonly renderedBytes: number;
  /** Rendered share of the chunk, scaled to the final (minified) bundle bytes. */
  readonly estimatedMinifiedBytes: number;
  readonly share: number;
}

export interface AssetSizeEntry {
  readonly path: string;
  readonly rawBytes: number;
  readonly base64Bytes: number;
}

export interface BuildReport {
  readonly format: 'html' | 'zip';
  readonly path: string;
  readonly at: string;
  readonly entryScene: string;
  readonly scenes: number;
  /** The artifact on disk. */
  readonly bytes: number;
  /** What a gzip channel would transfer for the artifact (zlib level 6). */
  readonly gzipBytes: number;
  readonly compress:
    | {
        readonly enabled: true;
        readonly bundleBytes: number;
        readonly gzipBytes: number;
        readonly base64Bytes: number;
        /** `gzipBytes / bundleBytes`. */
        readonly ratio: number;
        /** `bundleBytes - base64Bytes`: what the file lost (the bootstrap is ~1.5 KiB). */
        readonly savedBytes: number;
      }
    | { readonly enabled: false };
  readonly code: {
    /** Final JS bytes of every chunk (minified). */
    readonly bundleBytes: number;
    /** Sum of the modules' rendered lengths (before minification). */
    readonly renderedBytes: number;
    readonly groups: Record<ModuleGroup, GroupSize>;
    /** `node_modules` packages by rendered bytes (three included), largest first. */
    readonly packages: Record<string, number>;
    readonly largestModules: readonly ModuleSize[];
  };
  readonly strip: {
    readonly enabled: boolean;
    readonly reason: string | null;
    readonly keep: readonly string[];
    /** Runtime modules replaced by stubs (paths under `@pix3/runtime/src`). */
    readonly stripped: readonly string[];
    /** `package → files parsed` for the dependencies that declare the runtime (N11). */
    readonly dependencies: Record<string, number>;
    /** Names a dependency imports from the runtime barrel (kept by that). */
    readonly dependencyImports: readonly string[];
  };
  /** The optional libraries and how each one was resolved. */
  readonly libraries: Record<string, string>;
  readonly assets: {
    readonly count: number;
    readonly rawBytes: number;
    readonly base64Bytes: number;
    /** Largest first. */
    readonly entries: readonly AssetSizeEntry[];
  };
  readonly warnings: readonly string[];
}

export interface ModuleClassifier {
  readonly root: string;
  readonly runtimeSrc: string | null;
  readonly playerDir: string;
  readonly embeddedAssetsId: string;
}

const isUnder = (file: string, dir: string | null): boolean => {
  if (!dir) return false;
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The package name of a `node_modules` id (`@scope/name` or `name`), or null. */
export const packageNameOf = (id: string): string | null => {
  const normalized = id.split(sep).join('/');
  const marker = normalized.lastIndexOf('/node_modules/');
  if (marker < 0) return null;
  const parts = normalized.slice(marker + '/node_modules/'.length).split('/');
  if (parts[0]?.startsWith('@')) return parts.length > 1 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
};

export const classifyModule = (
  id: string,
  classifier: ModuleClassifier
): { group: ModuleGroup; package: string | null } => {
  if (id.startsWith('\0')) {
    const virtual = id.slice(1);
    if (virtual === classifier.embeddedAssetsId) return { group: 'assets', package: null };
    if (virtual.startsWith('virtual:pix3/')) return { group: 'player', package: null };
    return { group: 'other', package: null };
  }
  const file = id.split('?')[0];
  if (isUnder(file, classifier.runtimeSrc)) return { group: 'runtime', package: null };
  if (isUnder(file, classifier.playerDir)) return { group: 'player', package: null };
  const pkg = packageNameOf(file);
  if (pkg === 'three') return { group: 'three', package: pkg };
  if (pkg) return { group: 'dependencies', package: pkg };
  if (isUnder(file, classifier.root)) return { group: 'project', package: null };
  return { group: 'other', package: null };
};

/**
 * A readable id: `@pix3/runtime/src/…` for the runtime, `<package>/…` inside `node_modules`,
 * relative to the root for the project's own files.
 */
export const displayId = (id: string, classifier: ModuleClassifier): string => {
  if (id.startsWith('\0')) return id.slice(1);
  const file = id.split('?')[0];
  if (isUnder(file, classifier.runtimeSrc)) {
    return `@pix3/runtime/src/${relative(classifier.runtimeSrc as string, file)
      .split(sep)
      .join('/')}`;
  }
  const posix = file.split(sep).join('/');
  const marker = posix.lastIndexOf('/node_modules/');
  if (marker >= 0) return posix.slice(marker + '/node_modules/'.length);
  const rel = relative(classifier.root, file);
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : posix;
};

export interface CodeSizes {
  readonly bundleBytes: number;
  readonly modules: readonly ModuleSize[];
}

const GROUPS: readonly ModuleGroup[] = [
  'three',
  'runtime',
  'player',
  'project',
  'assets',
  'dependencies',
  'other',
];

export const summarizeCode = (sizes: CodeSizes, largest = 30): BuildReport['code'] => {
  const renderedBytes = sizes.modules.reduce((sum, m) => sum + m.renderedBytes, 0);
  const groups = {} as Record<ModuleGroup, GroupSize>;
  for (const group of GROUPS) {
    const members = sizes.modules.filter(m => m.group === group);
    const rendered = members.reduce((sum, m) => sum + m.renderedBytes, 0);
    const share = renderedBytes > 0 ? rendered / renderedBytes : 0;
    groups[group] = {
      modules: members.length,
      renderedBytes: rendered,
      estimatedMinifiedBytes: Math.round(share * sizes.bundleBytes),
      share: Math.round(share * 1000) / 1000,
    };
  }
  const packages: Record<string, number> = {};
  for (const m of sizes.modules) {
    if (m.package && m.renderedBytes > 0) {
      packages[m.package] = (packages[m.package] ?? 0) + m.renderedBytes;
    }
  }
  const sortedPackages = Object.fromEntries(
    Object.entries(packages).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  );
  const largestModules = [...sizes.modules]
    .sort((a, b) => b.renderedBytes - a.renderedBytes || (a.id < b.id ? -1 : 1))
    .slice(0, largest);
  return {
    bundleBytes: sizes.bundleBytes,
    renderedBytes,
    groups,
    packages: sortedPackages,
    largestModules,
  };
};

export const gzipBytesOf = (bytes: Buffer): number => gzipSync(bytes, { level: 6 }).byteLength;

/** `<outDir>/<artifact basename without extension>.report.json`. */
export const buildReportPath = (artifactPath: string, outDir: string): string =>
  join(outDir, `${basename(artifactPath, extname(artifactPath))}.report.json`);

export const writeBuildReport = (path: string, report: BuildReport): void => {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
};
