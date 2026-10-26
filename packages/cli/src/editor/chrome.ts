import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { chromeProfileDir, chromeProfileFallbackDir } from './paths.ts';

/**
 * Launching Chrome for the agent (plan §D.4 step 2, §D.5): an app window on the editor URL, our
 * own profile, remote debugging over `--remote-debugging-pipe` only (no debugging port: the
 * owner process holds the pipe and serves it behind the token proxy, `chrome-owner.ts`), and the
 * flags that stop Chrome from throttling a background tab (the agent's tab is in the background
 * almost all the time). A second project never launches the profile again (a headless Chrome
 * would start a second process nobody owns): its tab is opened through the proxy
 * (`ensureEditorTab` in `chrome-owner.ts`).
 */

export const CHROME_FLAGS: readonly string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const onPath = (name: string, env: NodeJS.ProcessEnv): string | null => {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

/**
 * The Chrome binary. Always a binary, macOS included: the pipe is a pair of inherited file
 * descriptors, which `open -na` (the P1 launch, which kept Chrome out of the caller's seatbelt
 * sandbox) cannot pass on.
 */
export interface ChromeLaunch {
  readonly kind: 'binary';
  readonly path: string;
}

/**
 * The Chrome to launch: `PIX3_CHROME` (a binary or a wrapper script that `exec`s one — the pipe
 * fds 3 and 4 must reach Chrome), else the platform's usual places. Null when none is found —
 * `pix3 editor` then prints what to install or set.
 */
export const findChrome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ChromeLaunch | null => {
  if (env.PIX3_CHROME) return { kind: 'binary', path: env.PIX3_CHROME };
  if (platform === 'darwin') {
    const binaries = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const path of binaries) if (existsSync(path)) return { kind: 'binary', path };
    return null;
  }
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      (v): v is string => Boolean(v)
    );
    for (const root of roots) {
      const candidate = join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (existsSync(candidate)) return { kind: 'binary', path: candidate };
    }
    return null;
  }
  for (const name of [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ]) {
    const path = onPath(name, env);
    if (path) return { kind: 'binary', path };
  }
  const cached = playwrightChromium(env);
  return cached ? { kind: 'binary', path: cached } : null;
};

/**
 * The newest Chromium Playwright downloaded (`npx playwright install chromium`), on a Linux box
 * with no system Chrome — a remote dev host often has one in `~/.cache/ms-playwright` from some
 * test suite. `PLAYWRIGHT_BROWSERS_PATH` moves the cache. The headless shell is not a candidate:
 * it has no tabs to give the editor.
 */
export const playwrightChromium = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const cache = env.PLAYWRIGHT_BROWSERS_PATH || join(env.HOME ?? '', '.cache', 'ms-playwright');
  let builds: string[];
  try {
    builds = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name));
  } catch {
    return null;
  }
  builds.sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)));
  for (const build of builds) {
    for (const dir of ['chrome-linux64', 'chrome-linux']) {
      const candidate = join(cache, build, dir, 'chrome');
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
};

const readProcFlag = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * Whether Chrome needs `--no-sandbox` to start here. Its Linux sandbox needs unprivileged user
 * namespaces, which root, a kernel with them off, and Ubuntu 24's AppArmor restriction all deny —
 * a distro Chrome or Chromium package ships an AppArmor profile that lifts the restriction, a
 * downloaded build (Playwright's, a tarball) does not, and dies with "No usable sandbox!".
 * `PIX3_CHROME_NO_SANDBOX=1` / `=0` decides by hand.
 */
export const needsNoSandbox = (
  chromePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readFlag: (path: string) => string | null = readProcFlag,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): boolean => {
  if (env.PIX3_CHROME_NO_SANDBOX === '1') return true;
  if (env.PIX3_CHROME_NO_SANDBOX === '0') return false;
  if (platform !== 'linux') return false;
  if (uid === 0) return true;
  if (readFlag('/proc/sys/kernel/unprivileged_userns_clone') === '0') return true;
  if (readFlag('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') {
    const packaged = /^\/(opt\/google|usr\/bin|usr\/lib|snap)\//.test(chromePath);
    return !packaged;
  }
  return false;
};

/** The profile directory, created; the temp fallback when the home one cannot be made. */
export const ensureProfileDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const preferred = chromeProfileDir(env);
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = chromeProfileFallbackDir();
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
};

export interface ChromeArgsOptions {
  readonly url: string;
  readonly profile: string;
  /** No window: `--headless=new` and the URL as a plain tab (headless Chrome ignores `--app`). */
  readonly headless?: boolean;
  /** `--no-sandbox`: see {@link needsNoSandbox}. */
  readonly noSandbox?: boolean;
}

/** The headless window: the editor and a portrait game in its Game tab both readable. */
const HEADLESS_WINDOW = '1600,1200';

/** The owner's launch: CDP over the pipe (fds 3/4), never a TCP debugging port. */
export const chromeArgs = (options: ChromeArgsOptions): string[] => [
  `--user-data-dir=${options.profile}`,
  '--remote-debugging-pipe',
  ...CHROME_FLAGS,
  ...(options.noSandbox ? ['--no-sandbox'] : []),
  // Headless Chrome's default window is 780×380: the editor's Game tab then shows a portrait
  // game a few hundred pixels tall. A desktop-sized window gives screenshots something to read.
  ...(options.headless
    ? ['--headless=new', `--window-size=${HEADLESS_WINDOW}`, options.url]
    : [`--app=${options.url}`]),
];

export const describeChromeNotFound = (platform: NodeJS.Platform = process.platform): string =>
  [
    'No Chrome found. Install Google Chrome (or Chromium), or point PIX3_CHROME at the binary',
    platform === 'darwin'
      ? '(the usual place is /Applications/Google Chrome.app).'
      : platform === 'win32'
        ? '(the usual place is %ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe).'
        : '(google-chrome, chromium or chromium-browser on the PATH; or `npx playwright install chromium`, which pix3 editor finds in ~/.cache/ms-playwright).',
  ].join(' ');
