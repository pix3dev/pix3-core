// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { linkedRuntimeOutdatesCache } from './vite-config.ts';

// A game on `@pix3/runtime: file:../pix3-core/packages/runtime` kept getting the runtime Vite
// prebundled days earlier: nothing in the cache key changes when a linked checkout is edited.
describe('linkedRuntimeOutdatesCache', () => {
  const dirs: string[] = [];
  const project = (linked: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'pix3-cache-'));
    dirs.push(root);
    const source = linked
      ? join(root, 'engine', 'runtime')
      : join(root, 'node_modules', '@pix3', 'runtime');
    mkdirSync(join(source, 'src', 'core'), { recursive: true });
    writeFileSync(join(source, 'src', 'core', 'SceneLoader.ts'), '');
    if (linked) {
      mkdirSync(join(root, 'node_modules', '@pix3'), { recursive: true });
      symlinkSync(source, join(root, 'node_modules', '@pix3', 'runtime'), 'junction');
    }
    const cache = join(root, 'node_modules', '.vite');
    mkdirSync(join(cache, 'deps'), { recursive: true });
    writeFileSync(join(cache, 'deps', '_metadata.json'), '{}');
    const touch = (file: string, secondsAgo: number) => {
      const at = new Date(Date.now() - secondsAgo * 1000);
      utimesSync(file, at, at);
    };
    return {
      runtimeDir: join(root, 'node_modules', '@pix3', 'runtime'),
      cache,
      sourceAt: (secondsAgo: number) =>
        touch(join(source, 'src', 'core', 'SceneLoader.ts'), secondsAgo),
      cacheAt: (secondsAgo: number) => touch(join(cache, 'deps', '_metadata.json'), secondsAgo),
    };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is true for a linked runtime edited after the prebundle', () => {
    const p = project(true);
    p.cacheAt(3600);
    p.sourceAt(60);
    expect(linkedRuntimeOutdatesCache(p.runtimeDir, p.cache)).toBe(true);
  });

  it('is false while the prebundle is newer than the linked sources', () => {
    const p = project(true);
    p.sourceAt(3600);
    p.cacheAt(60);
    expect(linkedRuntimeOutdatesCache(p.runtimeDir, p.cache)).toBe(false);
  });

  it('is false for an installed runtime, for no runtime and for no cache', () => {
    const p = project(false);
    p.cacheAt(3600);
    p.sourceAt(60);
    expect(linkedRuntimeOutdatesCache(p.runtimeDir, p.cache)).toBe(false);
    expect(linkedRuntimeOutdatesCache(null, p.cache)).toBe(false);
    const linked = project(true);
    expect(linkedRuntimeOutdatesCache(linked.runtimeDir, join(linked.cache, 'missing'))).toBe(
      false
    );
  });
});
