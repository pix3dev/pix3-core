// Prebuilds the page half of `pix3 play --bot` into `dist/play/prebuilt/` for the published
// package: the editor's BotSession and the page bot world (editor-core sources of this checkout),
// one IIFE the CLI evaluates in the game's page. A repo checkout builds it on the fly. See
// `src/play/bundle.ts`.
import { rmSync } from 'node:fs';
import { stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlayBundle } from '../src/play/bundle.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(packageRoot, 'dist', 'play', 'prebuilt');

rmSync(outdir, { recursive: true, force: true });
await buildPlayBundle(outdir, { minify: true });
stdout.write(`build-play: wrote ${outdir}\n`);
