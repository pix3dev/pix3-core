// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { publicUrlOf, versionMismatch } from './dev-info.ts';

describe('versionMismatch (plan §A.3 gate)', () => {
  it('needs an exact match between prereleases', () => {
    expect(versionMismatch('2.0.0-alpha.1', '2.0.0-alpha.1')).toBeNull();
    expect(versionMismatch('2.0.0-alpha.0', '2.0.0-alpha.1')).toContain(
      'npm i @pix3/runtime@2.0.0-alpha.1'
    );
  });

  it('accepts any patch of the same minor between releases', () => {
    expect(versionMismatch('2.1.3', '2.1.0')).toBeNull();
    expect(versionMismatch('2.0.9', '2.1.0')).toContain('npm i @pix3/runtime@2.1.0');
    expect(versionMismatch('2.1.0', '2.1.0-beta.1')).not.toBeNull();
  });

  it('asks for the runtime when the project has none, and skips the gate without an editor', () => {
    expect(versionMismatch(null, '2.0.0')).toContain('npm i @pix3/runtime');
    expect(versionMismatch('2.0.0', null)).toBeNull();
  });
});

describe('publicUrlOf (dev.json publicUrl, Remote SSH)', () => {
  it('takes PIX3_PUBLIC_URL first, with or without the base spelled out', () => {
    const at = (env: string, base = '/') => publicUrlOf({ env, port: 5173, base });
    expect(at('http://localhost:5174')).toBe('http://localhost:5174/');
    expect(at('http://localhost:5174/')).toBe('http://localhost:5174/');
    expect(at('http://localhost:5174', '/game/')).toBe('http://localhost:5174/game/');
    expect(at('http://localhost:5174/game/', '/game/')).toBe('http://localhost:5174/game/');
    expect(at('ftp://x')).toBeNull();
    expect(at('not a url')).toBeNull();
    // The env wins over a tab.
    expect(
      publicUrlOf({ env: 'http://h:1', tabOrigin: 'http://localhost:9', port: 5173, base: '/' })
    ).toBe('http://h:1/');
  });

  it("learns it from a tab's Origin only when that is not the server's own loopback address", () => {
    const tab = (tabOrigin: string) => publicUrlOf({ tabOrigin, port: 5173, base: '/' });
    expect(tab('http://localhost:5173')).toBeNull();
    expect(tab('http://127.0.0.1:5173')).toBeNull();
    expect(tab('http://localhost:5174')).toBe('http://localhost:5174/');
    expect(tab('https://box.example')).toBe('https://box.example/');
    expect(publicUrlOf({ tabOrigin: null, port: 5173, base: '/' })).toBeNull();
  });
});
