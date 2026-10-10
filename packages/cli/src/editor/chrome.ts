import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { chromeProfileDir, chromeProfileFallbackDir } from './paths.ts';

/**
 * Launching Chrome for the agent (plan §D.4 step 2, §D.5): an app window on the editor URL, our
 * own profile, remote debugging over `--remote-debugging-pipe` only (no debugging port: the
 * owner process holds the pipe and serves it behind the token proxy, `chrome-owner.ts`), and the
 * flags that stop Chrome from throttling a background tab (the agent's tab is in the background
 * almost all the time). A second launch with the same `--user-data-dir` and no debugging flag
 * (`handoffArgs`) opens another app window in the running process — that is how a second project
 * joins the same Chrome and proxy.
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
  return null;
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
}

/** The owner's launch: CDP over the pipe (fds 3/4), never a TCP debugging port. */
export const chromeArgs = (options: ChromeArgsOptions): string[] => [
  `--user-data-dir=${options.profile}`,
  '--remote-debugging-pipe',
  ...CHROME_FLAGS,
  ...(options.headless ? ['--headless=new', options.url] : [`--app=${options.url}`]),
];

/**
 * Another app window in the Chrome that already runs this profile: the process singleton hands
 * the URL over and the new process exits. No debugging flag — the running Chrome keeps its pipe.
 */
export const handoffArgs = (options: { url: string; profile: string }): string[] => [
  `--user-data-dir=${options.profile}`,
  ...CHROME_FLAGS,
  `--app=${options.url}`,
];

/** Start a short-lived Chrome detached (the handoff launch); the command does not wait for it. */
export const launchDetached = (
  launch: ChromeLaunch,
  args: readonly string[],
  spawnImpl: typeof spawn = spawn
): ChildProcess => {
  const child = spawnImpl(launch.path, [...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child;
};

export const describeChromeNotFound = (platform: NodeJS.Platform = process.platform): string =>
  [
    'No Chrome found. Install Google Chrome (or Chromium), or point PIX3_CHROME at the binary',
    platform === 'darwin'
      ? '(the usual place is /Applications/Google Chrome.app).'
      : platform === 'win32'
        ? '(the usual place is %ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe).'
        : '(google-chrome, chromium or chromium-browser on the PATH).',
  ].join(' ');
