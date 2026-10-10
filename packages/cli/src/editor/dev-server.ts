import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The dev server half of `pix3 editor` (plan §D.3, §D.4 step 1): `.pix3/dev.json` is where the
 * plugin records the running Vite dev server (`url`, `editorUrl`, `port`, `pid`); a live one is
 * reused, a stale record is ignored and Vite is started detached — its output goes to
 * `.pix3/dev.log`, and the command waits for the plugin to write a fresh `dev.json`.
 */

export const DEV_JSON = join('.pix3', 'dev.json');
export const DEV_LOG = join('.pix3', 'dev.log');
/** How long a fresh dev server may take to write `dev.json` (plan §D.4: ≤15 s). */
export const DEV_SERVER_START_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface DevInfo {
  readonly url: string;
  readonly editorUrl: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt?: string;
  readonly versions?: Record<string, string | null>;
  /** Where the browser reaches the server when that is not `url` (Remote SSH; the plugin's). */
  readonly publicUrl?: string;
  readonly publicEditorUrl?: string;
}

export const readDevInfo = (root: string): DevInfo | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(root, DEV_JSON), 'utf8')) as Partial<DevInfo>;
    return typeof parsed.url === 'string' &&
      typeof parsed.editorUrl === 'string' &&
      typeof parsed.pid === 'number'
      ? (parsed as DevInfo)
      : null;
  } catch {
    return null;
  }
};

/** `GET <url>__pix3/api/hello` answers → the dev server behind `dev.json` is alive. */
export const probeDevServer = async (
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> => {
  const api = `${url.endsWith('/') ? url : `${url}/`}__pix3/api/hello`;
  try {
    const response = await fetchImpl(api, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
};

export type DevServerFound =
  | { readonly status: 'live'; readonly info: DevInfo }
  | { readonly status: 'stale'; readonly info: DevInfo }
  | { readonly status: 'none' };

/** What `dev.json` says, checked against the server itself. */
export const findDevServer = async (
  root: string,
  fetchImpl: typeof fetch = fetch
): Promise<DevServerFound> => {
  const info = readDevInfo(root);
  if (!info) return { status: 'none' };
  return (await probeDevServer(info.url, fetchImpl))
    ? { status: 'live', info }
    : { status: 'stale', info };
};

/** `node_modules/vite/bin/vite.js` as the project resolves it (the root or an ancestor). */
export const findViteBin = (root: string): string | null => {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface StartDevServerOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Replaces `spawn` in specs. */
  readonly spawnImpl?: typeof spawn;
}

/**
 * Start Vite detached (`process.execPath <vite.js>`, log in `.pix3/dev.log`) and wait for the
 * plugin's `dev.json` of the new process. Throws with the log's tail when it does not come up.
 */
export const startDevServer = async (
  root: string,
  options: StartDevServerOptions = {}
): Promise<DevInfo> => {
  const vite = findViteBin(root);
  if (!vite) {
    throw new Error(
      `No vite in ${root} (node_modules/vite/bin/vite.js): run \`npm install\` in the project first.`
    );
  }
  const stale = readDevInfo(root);
  mkdirSync(join(root, '.pix3'), { recursive: true });
  // The stale record would be read back as the new server's; the plugin only removes its own.
  rmSync(join(root, DEV_JSON), { force: true });
  const log = openSync(join(root, DEV_LOG), 'w');
  const args = [vite, ...(options.port ? ['--port', String(options.port), '--strictPort'] : [])];
  const child = (options.spawnImpl ?? spawn)(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, FORCE_COLOR: '0' },
    // Windows: a detached console app needs no window of its own.
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? DEV_SERVER_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const info = readDevInfo(root);
    if (info && info.pid !== stale?.pid && (await probeDevServer(info.url, options.fetch))) {
      return info;
    }
    await sleep(200);
  }
  let tail = '';
  try {
    tail = readFileSync(join(root, DEV_LOG), 'utf8').split('\n').slice(-15).join('\n');
  } catch {
    // no log
  }
  throw new Error(
    child.exitCode !== null
      ? `vite exited with code ${child.exitCode} (see ${DEV_LOG}):\n${tail}`
      : `the dev server did not write ${DEV_JSON} within ${options.timeoutMs ?? DEV_SERVER_START_TIMEOUT_MS} ms (see ${DEV_LOG}):\n${tail}`
  );
};

/** `pix3 editor --stop`: end the dev server `dev.json` names. */
export const stopDevServer = (root: string): { stopped: boolean; pid: number | null } => {
  const info = readDevInfo(root);
  if (!info) return { stopped: false, pid: null };
  try {
    process.kill(info.pid, 'SIGTERM');
    return { stopped: true, pid: info.pid };
  } catch {
    // Already gone: the record is stale.
    rmSync(join(root, DEV_JSON), { force: true });
    return { stopped: false, pid: info.pid };
  }
};
