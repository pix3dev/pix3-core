#!/usr/bin/env node
// `npm create pix3` — see src/create.js.
import { run } from './src/create.js';

process.exitCode = await run(process.argv.slice(2));
