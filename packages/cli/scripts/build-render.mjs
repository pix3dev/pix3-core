// Prebuilds the page host of `pix3 render` into `dist/render/prebuilt/` for the published package:
// `src/render/page-host.ts` with the runtime and three.js of this checkout, one IIFE. A repo
// checkout builds it on the fly. See `src/render/bundle.ts`.
import { rmSync } from 'node:fs';
import { stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRenderBundle } from '../src/render/bundle.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(packageRoot, 'dist', 'render', 'prebuilt');

rmSync(outdir, { recursive: true, force: true });
await buildRenderBundle(outdir, { minify: true });
stdout.write(`build-render: wrote ${outdir}\n`);
