// @vitest-environment node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findChrome } from './chrome.ts';

// Browser discovery must not depend on what is installed on the developer's machine or CI.
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(),
}));

describe('macOS Chrome discovery', () => {
  const home = '/Users/pix3 tester';
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const userChrome = join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';

  beforeEach(() => vi.mocked(existsSync).mockReset());

  it('returns null when no supported browser is installed', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(findChrome({ HOME: home }, 'darwin')).toBeNull();
    expect(vi.mocked(existsSync).mock.calls.map(([path]) => path)).toEqual([
      systemChrome,
      userChrome,
      chromium,
    ]);
  });

  it.each([systemChrome, userChrome, chromium])('launches the binary at %s', binary => {
    vi.mocked(existsSync).mockImplementation(path => path === binary);
    expect(findChrome({ HOME: home }, 'darwin')).toEqual({ kind: 'binary', path: binary });
  });

  it('prefers system Chrome when all browsers are installed', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(findChrome({ HOME: home }, 'darwin')).toEqual({ kind: 'binary', path: systemChrome });
  });

  it('uses PIX3_CHROME without probing standard app locations', () => {
    expect(findChrome({ HOME: home, PIX3_CHROME: '/custom/chrome wrapper' }, 'darwin')).toEqual({
      kind: 'binary',
      path: '/custom/chrome wrapper',
    });
    expect(existsSync).not.toHaveBeenCalled();
  });
});
