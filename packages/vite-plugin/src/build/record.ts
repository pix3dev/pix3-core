import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RESERVED_ROOT_DIR } from '../files/paths.ts';

/**
 * `.pix3/build.json` — what the last `vite build` produced. Written by the plugin at the end of a
 * build, so whoever ran `npm run build` (the coding agent, a script, CI) gets the artifact's path,
 * size and hash without parsing Vite's output.
 */
export interface BuildRecord {
  readonly format: 'html' | 'zip';
  /** Absolute path of the artifact (`dist/index.html` or `dist/<name>.zip`). */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly at: string;
  readonly entryScene: string;
  readonly assets: number;
  readonly stripped: readonly string[];
  readonly warnings: readonly string[];
  /** Absolute path of `dist/<name>.report.json` (sizes by group, stubs, assets, compression). */
  readonly report?: string;
}

export const buildRecordPath = (root: string): string =>
  join(root, RESERVED_ROOT_DIR, 'build.json');

export const writeBuildRecord = (root: string, record: BuildRecord): void => {
  const path = buildRecordPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
};

export const fileDigest = (path: string): { bytes: number; sha256: string } => ({
  bytes: statSync(path).size,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
});
