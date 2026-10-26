// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chromeArgs, findChrome, needsNoSandbox, playwrightChromium } from './chrome.ts';

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

describe('Linux: Playwright Chromium and the sandbox', () => {
  it('finds the newest Playwright Chromium when nothing is on the PATH (not the headless shell)', () => {
    const cache = mkdtempSync(join(tmpdir(), 'pix3-pw-'));
    try {
      for (const [build, dir] of [
        ['chromium-1134', 'chrome-linux'],
        ['chromium-1248', 'chrome-linux64'],
        ['chromium_headless_shell-1300', 'chrome-linux'],
      ]) {
        mkdirSync(join(cache, build, dir), { recursive: true });
        const binary = join(cache, build, dir, 'chrome');
        writeFileSync(binary, '#!/bin/sh\n');
        chmodSync(binary, 0o755);
      }
      const expected = join(cache, 'chromium-1248', 'chrome-linux64', 'chrome');
      expect(playwrightChromium({ PLAYWRIGHT_BROWSERS_PATH: cache })).toBe(expected);
      expect(findChrome({ PATH: '', PLAYWRIGHT_BROWSERS_PATH: cache }, 'linux')).toEqual({
        kind: 'binary',
        path: expected,
      });
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('adds --no-sandbox for a downloaded build under the AppArmor userns restriction, not for a packaged one', () => {
    const flags = (values: Record<string, string>) => (path: string) => values[path] ?? null;
    const restricted = flags({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' });
    const pw = '/home/u/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
    expect(needsNoSandbox(pw, {}, 'linux', restricted, 1000)).toBe(true);
    expect(needsNoSandbox('/usr/bin/google-chrome', {}, 'linux', restricted, 1000)).toBe(false);
    expect(needsNoSandbox(pw, {}, 'linux', flags({}), 1000)).toBe(false);
    expect(needsNoSandbox('/usr/bin/chromium', {}, 'linux', flags({}), 0)).toBe(true);
    expect(needsNoSandbox(pw, { PIX3_CHROME_NO_SANDBOX: '0' }, 'linux', restricted, 1000)).toBe(
      false
    );
    expect(needsNoSandbox(pw, {}, 'darwin', restricted, 1000)).toBe(false);
    const headless = chromeArgs({ url: 'u', profile: 'p', headless: true, noSandbox: true });
    expect(headless).toContain('--no-sandbox');
    expect(headless).toContain('--window-size=1600,1200');
  });
});
