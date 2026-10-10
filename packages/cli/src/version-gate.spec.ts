// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CLI_VERSION } from './version.ts';
import {
  bundledRuntimeVersion,
  installedPackageVersion,
  lockstepMismatches,
  runtimeVersionMismatch,
} from './version-gate.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pix3-version-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const install = (root: string, name: string, version: string): void => {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
};

describe('the CLI version gate', () => {
  it('the runtime this checkout bundles is the lockstep version', () => {
    expect(bundledRuntimeVersion()).toBe(CLI_VERSION);
  });

  it('nothing installed: nothing to compare', () => {
    const root = join(scratch, 'bare');
    mkdirSync(root, { recursive: true });
    expect(runtimeVersionMismatch(root)).toBeNull();
    expect(lockstepMismatches(root)).toEqual([]);
  });

  it('resolves node_modules walking up, as Node does', () => {
    const root = join(scratch, 'monorepo');
    install(root, '@pix3/runtime', '1.6.2');
    const nested = join(root, 'games', 'one');
    mkdirSync(nested, { recursive: true });
    expect(installedPackageVersion(nested, '@pix3/runtime')).toBe('1.6.2');
    expect(runtimeVersionMismatch(nested)).toMatchObject({
      installed: '1.6.2',
      bundled: CLI_VERSION,
    });
  });

  it('the same runtime passes; another lockstep package is listed', () => {
    const root = join(scratch, 'same');
    install(root, '@pix3/runtime', CLI_VERSION);
    install(root, '@pix3/cli', CLI_VERSION);
    install(root, '@pix3/editor-core', '2.0.0-alpha.999');
    expect(runtimeVersionMismatch(root)).toBeNull();
    expect(lockstepMismatches(root)).toEqual([
      { name: '@pix3/editor-core', installed: '2.0.0-alpha.999' },
    ]);
  });
});
