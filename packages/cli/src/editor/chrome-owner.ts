import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import WebSocket from 'ws';

import { inspectCdpPort } from './cdp-port.ts';
import { CdpProxy, pipeFromStreams } from './cdp-proxy.ts';
import { ensureCdpToken } from './cdp-token.ts';
import { chromeArgs } from './chrome.ts';
import { removeChromeState, writeChromeState } from './chrome-state.ts';
import { CDP_PROXY_PROTOCOL, cdpWsEndpoint, chromeOwnerLogPath } from './paths.ts';

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
  const proxy = new CdpProxy({ pipe, token, log });

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
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  let tail = '';
  try {
    tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n');
  } catch {
    // no log
  }
  throw new Error(
    `${child.exitCode !== null ? `the Chrome owner exited (code ${child.exitCode})` : 'the CDP proxy did not come up'} — ${logPath}:\n${tail}`
  );
};

/**
 * One CDP command through the proxy (browser level), for `pix3 editor` itself: a new tab in a
 * headless Chrome, where there is no window to hand a URL to.
 */
export const proxyCall = (
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
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};
