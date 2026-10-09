import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { zipSync } from 'fflate';

/**
 * `build: 'zip'` (plan §B.6): nothing is inlined — the build's `index.html`, chunks and the
 * assets emitted beside them go into one `fflate` archive at `<outDir>/<name>.zip`, with paths
 * relative to `outDir` (unpack anywhere; the player's `ResourceManager('./')` is relative).
 */
export const zipDirectory = (outDir: string, zipName: string): string => {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const rel = relative(outDir, absolute).split(sep).join('/');
        if (rel === zipName) continue;
        files[rel] = new Uint8Array(readFileSync(absolute));
      }
    }
  };
  walk(outDir);
  const zipPath = join(outDir, zipName);
  writeFileSync(zipPath, zipSync(files, { level: 6 }));
  return zipPath;
};
