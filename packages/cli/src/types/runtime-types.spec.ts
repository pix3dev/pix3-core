// @vitest-environment node
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('publishes complete checkout type trees when cold consumers build concurrently', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pix3-types-concurrency-'));
  try {
    const moduleUrl = new URL('./runtime-types.ts', import.meta.url).href;
    const script = `import { ensureRuntimeTypes } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify(ensureRuntimeTypes()));`;
    // A private temp root guarantees a cold cache without deleting a developer's active cache.
    const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    const results = await Promise.all(
      [0, 1].map(() => run(process.execPath, ['--input-type=module', '-e', script], { env }))
    );
    const built = results.map(
      result =>
        JSON.parse(result.stdout) as {
          dir: string;
          manifest: { sourceStamp: string };
        }
    );
    expect(built[0].dir).toBe(built[1].dir);
    const dir = built[0].dir;
    expect(dir).not.toContain('.tmp-');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      sourceStamp: string;
    };
    expect(manifest.sourceStamp).toBe(built[0].manifest.sourceStamp);
    expect(existsSync(join(dir, '@pix3/runtime/index.d.ts'))).toBe(true);
    expect(existsSync(join(dir, '@types/three/index.d.ts'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '@pix3/runtime/package.json'), 'utf8'))).toMatchObject(
      {
        name: '@pix3/runtime',
        types: 'index.d.ts',
      }
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
