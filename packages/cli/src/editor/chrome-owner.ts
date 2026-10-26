import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

import { logTail } from '../fs-util.ts';
import { inspectCdpPort } from './cdp-port.ts';
import { CdpProxy, pipeFromStreams } from './cdp-proxy.ts';
import { ensureCdpToken } from './cdp-token.ts';
import { chromeArgs } from './chrome.ts';
import { removeChromeState, writeChromeState } from './chrome-state.ts';
import { CDP_PROXY_PROTOCOL, cdpWsEndpoint, chromeOwnerLogPath } from './paths.ts';
import { readCdpForwardPorts } from './remote.ts';

/**
 * The Chrome owner (plan §D.5): a detached process `pix3 editor` starts, which launches Chrome
 * with `--remote-debugging-pipe`, holds the pipe and serves it as the token proxy on the chosen
 * port, and lives exactly as long as Chrome:
 *
 * - Chrome exits (the user closed it, `Browser.close`, a crash) → the pipe closes → every client
 *   is closed, `~/.pix3/chrome.json` removed, the owner exits;
 * - the owner exits or is killed → the pipe closes → Chrome exits on its own (measured: 30 ms on
 *   Chrome 155), so there is never a Chrome nobody can reach, nor one anybody can reach without
 *   the token;
 * - SIGTERM / SIGINT (`pix3 editor --stop-chrome`) → `Browser.close`, then the above.
 *
 * Detached rather than `pix3 editor` staying in the foreground: the command an agent runs
 * (`npm run editor`, plan §E.1) must return, and the proxy must outlive it.
 */

export interface ChromeOwnerOptions {
  readonly chrome: string;
  readonly port: number;
  readonly profile: string;
  readonly url: string;
  readonly headless?: boolean;
  readonly noSandbox?: boolean;
}

/** The hidden command the owner runs as: `pix3 __chrome-owner '<json options>'`. */
export const CHROME_OWNER_COMMAND = '__chrome-owner';

/** How long Chrome may take to answer on the pipe. */
const CHROME_READY_TIMEOUT_MS = 20_000;
/** How long `Browser.close` may take before the owner kills Chrome. */
const CHROME_CLOSE_TIMEOUT_MS = 3_000;

const stamp = (line: string) => `${new Date().toISOString()} [owner ${process.pid}] ${line}\n`;

/** The owner's main: returns once Chrome is gone (the exit code of the owner). */
export const runChromeOwner = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> => {
  const log = (line: string) => process.stdout.write(stamp(line));
  let options: ChromeOwnerOptions;
  try {
    options = JSON.parse(argv[0] ?? '') as ChromeOwnerOptions;
    if (typeof options.chrome !== 'string' || typeof options.port !== 'number') throw new Error();
  } catch {
    log(`bad options: ${argv[0] ?? '(none)'}`);
    return 2;
  }
  const token = ensureCdpToken(env);
  const args = chromeArgs(options);
  log(`launching ${options.chrome} ${args.join(' ')}`);
  const chrome = spawn(options.chrome, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const stderrTail: string[] = [];
  chrome.stderr?.setEncoding('utf8');
  chrome.stderr?.on('data', (text: string) => {
    stderrTail.push(...text.split('\n').filter(Boolean));
    stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
  });
  const exited = new Promise<string>(resolve => {
    chrome.once('exit', (code, signal) => resolve(`code ${code ?? '-'}, signal ${signal ?? '-'}`));
    chrome.once('error', error => resolve(error.message));
  });
  const pipe = pipeFromStreams(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
  const proxy = new CdpProxy({
    pipe,
    token,
    log,
    // Remote SSH: the ports `pix3 editor --url … --remote-port` named, read on every challenge.
    forwardPorts: () => readCdpForwardPorts(env),
  });

  // 1. Chrome answers on the pipe — or exits first (a Chrome that already runs this profile
  // takes the launch over and the new process exits at once).
  const ready = await Promise.race([
    proxy.call('Browser.getVersion').then(
      v => ({ ok: true as const, product: String(v.product) }),
      // The pipe closed: Chrome is exiting — say how, once it has.
      () =>
        Promise.race([
          exited,
          new Promise<string>(r => setTimeout(() => r('pipe closed'), 2_000)),
        ]).then(how => ({ ok: false as const, why: `Chrome exited before it answered (${how})` }))
    ),
    exited.then(how => ({ ok: false as const, why: `Chrome exited before it answered (${how})` })),
    new Promise<{ ok: false; why: string }>(resolve =>
      setTimeout(
        () =>
          resolve({ ok: false, why: `Chrome did not answer within ${CHROME_READY_TIMEOUT_MS} ms` }),
        CHROME_READY_TIMEOUT_MS
      ).unref()
    ),
  ]);
  if (!ready.ok) {
    log(
      `${ready.why}. A Chrome that already runs the profile ${options.profile} (an editor window ` +
        'of an earlier pix3 editor?) takes a new launch over: close it and run pix3 editor again.' +
        (stderrTail.length ? `\nChrome said:\n${stderrTail.join('\n')}` : '')
    );
    chrome.kill('SIGKILL');
    return 3;
  }

  // 2. The proxy listens.
  let port: number;
  try {
    port = await proxy.listen(options.port);
  } catch (error) {
    log(`cannot listen on 127.0.0.1:${options.port}: ${(error as Error).message}`);
    chrome.kill('SIGKILL');
    return 4;
  }
  writeChromeState(
    {
      port,
      profile: options.profile,
      startedAt: new Date().toISOString(),
      editorUrl: options.url,
      ownerPid: process.pid,
      chromePid: chrome.pid,
      proxy: CDP_PROXY_PROTOCOL,
    },
    env
  );
  log(`${ready.product} (pid ${chrome.pid}) behind ${cdpWsEndpoint(port)}`);

  // 3. Until Chrome is gone.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing Chrome`);
    void proxy.call('Browser.close').catch(() => {});
    setTimeout(() => chrome.kill('SIGKILL'), CHROME_CLOSE_TIMEOUT_MS).unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => stop(signal));
  const how = await new Promise<string>(resolve => {
    proxy.onClose(() => resolve('pipe closed'));
    void exited.then(resolve);
  });
  log(`Chrome is gone (${how})`);
  removeChromeState(process.pid, env);
  await proxy.close().catch(() => {});
  return 0;
};

// --- the side of `pix3 editor` --------------------------------------------------------------------

export interface StartChromeOwnerOptions extends ChromeOwnerOptions {
  /** The script that runs `pix3` (the bin, or `src/index.ts` from a checkout). */
  readonly entry: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Start the owner detached (log in `~/.pix3/chrome-owner.log`) and wait until its proxy answers
 * our token on the port. Throws with the log's tail when it does not.
 */
export const startChromeOwner = async (options: StartChromeOwnerOptions): Promise<ChildProcess> => {
  const { entry, env, timeoutMs, ...ownerOptions } = options;
  const logPath = chromeOwnerLogPath(env);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'w');
  const token = ensureCdpToken(env);
  const child = spawn(
    process.execPath,
    [entry, CHROME_OWNER_COMMAND, JSON.stringify(ownerOptions)],
    { detached: true, stdio: ['ignore', logFd, logFd], env, windowsHide: true }
  );
  child.unref();
  const deadline = Date.now() + (timeoutMs ?? CHROME_READY_TIMEOUT_MS + 2_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const state = await inspectCdpPort(options.port, { token });
    if (state.kind === 'ours') return child;
    await sleep(150);
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  const tail = logTail(logPath, 12);
  throw new Error(
    `${child.exitCode !== null ? `the Chrome owner exited (code ${child.exitCode})` : 'the CDP proxy did not come up'} — ${logPath}:\n${tail}`
  );
};

/** How long a fresh launch may take to show the URL it was given before a tab is opened here. */
export const FIRST_TAB_WAIT_MS = 4_000;
/** How long a tab opened through the proxy may take to show up in `/json/list`. */
const NEW_TAB_WAIT_MS = 5_000;

/**
 * Make sure the Chrome behind the proxy on `port` has a tab on `editorUrl`: wait up to `waitMs`
 * for one (a fresh launch opens its URL itself — unless the binary ignores `--app`, as a headless
 * shell does), else open one through the proxy (`Target.createTarget`, a new window unless the
 * browser is headless) and wait for it to be listed. Never a second launch of the profile: a
 * desktop Chrome would hand it over, but a headless one starts a second process that nobody
 * owns and `--stop-chrome` never ends.
 */
export const ensureEditorTab = async (
  port: number,
  token: string,
  editorUrl: string,
  options: { readonly waitMs?: number } = {}
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  const listed = async (waitMs: number) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = await inspectCdpPort(port, { token });
      if (state.kind !== 'ours') return null;
      const open = state.pages.some(url => url.startsWith(editorUrl));
      if (open || Date.now() >= deadline) return { open, browser: state.browser };
      await sleep(200);
    }
  };
  const before = await listed(options.waitMs ?? 0);
  if (!before) return { ok: false, detail: `the CDP proxy on port ${port} stopped answering` };
  if (before.open) {
    return {
      ok: true,
      detail: options.waitMs ? `${editorUrl}` : `${editorUrl} — the editor tab is open there`,
    };
  }
  const headless = /headless/i.test(before.browser);
  try {
    await proxyCall(port, token, 'Target.createTarget', {
      url: editorUrl,
      ...(headless ? {} : { newWindow: true }),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `could not open the editor in the running Chrome: ${(error as Error).message}`,
    };
  }
  const after = await listed(NEW_TAB_WAIT_MS);
  return after?.open
    ? {
        ok: true,
        detail: `${editorUrl} — opened the editor in a new ${headless ? 'tab' : 'window'} through the proxy`,
      }
    : {
        ok: false,
        detail: `Chrome took Target.createTarget for ${editorUrl}, but no such tab is listed by the proxy (/json/list)`,
      };
};

/** One CDP command through the proxy (browser level), for `pix3 editor` itself. */
const proxyCall = (
  port: number,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(cdpWsEndpoint(port), {
      headers: { Authorization: `Bearer ${token}` },
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result ?? {});
    });
  });

/** `pix3 editor --stop-chrome`: SIGTERM to the owner; resolves once it is gone (or not ours). */
export const stopChromeOwner = async (ownerPid: number, timeoutMs = 6_000): Promise<boolean> => {
  try {
    process.kill(ownerPid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(ownerPid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
};
