// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { versionMismatch } from './dev-info.ts';

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
