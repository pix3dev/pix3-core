// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chooseCdpPort, inspectCdpPort, isEditorPageUrl } from './cdp-port.ts';
import { chromeArgs, findChrome } from './chrome.ts';
import { readChromeState, writeChromeState } from './chrome-state.ts';
import { parseEditorArgs, runEditorCli } from './command.ts';
import { findDevServer, findViteBin, readDevInfo, stopDevServer } from './dev-server.ts';
import { CDP_PORT_RANGE, chromeProfileDir, chromeStatePath, DEFAULT_CDP_PORT } from './paths.ts';

/**
 * `pix3 editor` (plan §D.3, §D.4): `.pix3/dev.json` discovery against a real HTTP probe, the
 * 9333 check against servers that imitate Chrome's `/json/version` + `/json/list`, the Chrome
 * argument list, and the command's own answers (no project, `--stop`, `--chrome-only` without a
 * server, SSH, no Chrome). Launching Chrome and Vite for real is the bridge-e2e harness's job.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-editor-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** An HTTP server answering `routes` (path → JSON) on a free port. */
const serve = (routes: Record<string, unknown>): Promise<number> =>
  new Promise(resolve => {
    const server = createServer((req, res) => {
      const body = routes[req.url ?? ''];
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

/** A TCP port nothing listens on right now. */
const freePort = async (): Promise<number> => {
  const port = await serve({});
  servers.pop()?.close();
  return port;
};

let counter = 0;
const project = (devJson?: Record<string, unknown>): string => {
  const root = join(scratch, `p${++counter}`);
  mkdirSync(join(root, '.pix3'), { recursive: true });
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
  if (devJson) writeFileSync(join(root, '.pix3', 'dev.json'), JSON.stringify(devJson));
  return root;
};

const chrome = (browser = 'Chrome/155.0', pages: string[] = []) => ({
  '/json/version': { Browser: browser },
  '/json/list': pages.map(url => ({ type: 'page', url })),
});

describe('dev server discovery (.pix3/dev.json)', () => {
  it('reads a complete record and ignores a broken one', () => {
    const info = {
      url: 'http://localhost:5173/',
      editorUrl: 'http://localhost:5173/__pix3/',
      port: 5173,
      pid: 1,
    };
    expect(readDevInfo(project(info))).toEqual(info);
    expect(readDevInfo(project({ url: 'x' }))).toBeNull();
    expect(readDevInfo(project())).toBeNull();
  });

  it('tells a live server from a stale record by asking /__pix3/api/hello', async () => {
    const port = await serve({ '/__pix3/api/hello': { ok: true } });
    const live = project({
      url: `http://127.0.0.1:${port}/`,
      editorUrl: `http://127.0.0.1:${port}/__pix3/`,
      port,
      pid: 1,
    });
    expect((await findDevServer(live)).status).toBe('live');
    const dead = await freePort();
    const stale = project({
      url: `http://127.0.0.1:${dead}/`,
      editorUrl: `http://127.0.0.1:${dead}/__pix3/`,
      port: dead,
      pid: 1,
    });
    expect((await findDevServer(stale)).status).toBe('stale');
    expect((await findDevServer(project())).status).toBe('none');
  });

  it('finds vite through the project or an ancestor node_modules', () => {
    const root = project();
    expect(findViteBin(root)).toBeNull();
    mkdirSync(join(scratch, 'node_modules', 'vite', 'bin'), { recursive: true });
    writeFileSync(join(scratch, 'node_modules', 'vite', 'bin', 'vite.js'), '');
    expect(findViteBin(root)).toBe(join(scratch, 'node_modules', 'vite', 'bin', 'vite.js'));
    rmSync(join(scratch, 'node_modules'), { recursive: true });
  });

  it('--stop drops a record whose process is gone', () => {
    const root = project({
      url: 'http://127.0.0.1:1/',
      editorUrl: 'http://127.0.0.1:1/__pix3/',
      port: 1,
      pid: 2 ** 22 - 1,
    });
    expect(stopDevServer(root)).toEqual({ stopped: false, pid: 2 ** 22 - 1 });
    expect(readDevInfo(root)).toBeNull();
    expect(stopDevServer(root)).toEqual({ stopped: false, pid: null });
  });
});

describe('the 9333 check', () => {
  it('a closed port is free; a Pix3 editor page or the recorded port makes it ours', async () => {
    expect(await inspectCdpPort(await freePort())).toEqual({ kind: 'free' });
    const ours = await serve(chrome('Chrome/155.0', ['http://localhost:5173/__pix3/']));
    expect(await inspectCdpPort(ours)).toMatchObject({ kind: 'ours', browser: 'Chrome/155.0' });
    const recorded = await serve(chrome('Chrome/155.0', ['about:blank']));
    expect(await inspectCdpPort(recorded, { recordedPort: recorded })).toMatchObject({
      kind: 'ours',
    });
    expect(isEditorPageUrl('http://localhost:5173/__pix3/')).toBe(true);
    expect(isEditorPageUrl('http://localhost:5173/__pix3/?x=1')).toBe(true);
    expect(isEditorPageUrl('http://localhost:5173/')).toBe(false);
  });

  it("someone else's Chrome or a non-Chrome listener is foreign, with the reason", async () => {
    const theirs = await serve(chrome('Chrome/150.0', ['https://example.com/']));
    expect(await inspectCdpPort(theirs)).toMatchObject({
      kind: 'foreign',
      browser: 'Chrome/150.0',
      detail: expect.stringContaining('not Pix3'),
    });
    const notChrome = await serve({ '/': { hello: 1 } });
    expect(await inspectCdpPort(notChrome)).toMatchObject({
      kind: 'foreign',
      browser: null,
      detail: expect.stringContaining('not Chrome'),
    });
  });

  it('chooses the preferred port when free or ours, else the next one, naming what it skipped', async () => {
    const free = await freePort();
    expect(await chooseCdpPort({ preferred: free })).toMatchObject({ port: free, skipped: [] });
    // Two consecutive ports: the first foreign, the second free.
    const foreign = await serve(chrome('Chrome/150.0', ['https://example.com/']));
    const next = foreign + 1;
    const nextState = await inspectCdpPort(next);
    if (nextState.kind === 'free') {
      const choice = await chooseCdpPort({ preferred: foreign });
      expect(choice.port).toBe(next);
      expect(choice.skipped).toEqual([
        { port: foreign, detail: expect.stringContaining(String(foreign)) },
      ]);
    }
    await expect(chooseCdpPort({ preferred: foreign, range: 0 })).rejects.toThrow(
      /No free debugging port/
    );
    expect(DEFAULT_CDP_PORT).toBe(9333);
    expect(CDP_PORT_RANGE).toBe(6);
  });
});

describe('Chrome', () => {
  it('builds the app-window argument list of plan §D.4, or a headless tab', () => {
    const args = chromeArgs({ url: 'http://localhost:5173/__pix3/', profile: '/p', port: 9333 });
    expect(args).toEqual([
      '--user-data-dir=/p',
      '--remote-debugging-port=9333',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--app=http://localhost:5173/__pix3/',
    ]);
    const headless = chromeArgs({ url: 'http://x/', profile: '/p', port: 1, headless: true });
    expect(headless.slice(-2)).toEqual(['--headless=new', 'http://x/']);
    expect(headless.some(a => a.startsWith('--app='))).toBe(false);
  });

  it('PIX3_CHROME wins; an empty PATH finds nothing on linux; macOS goes through open', () => {
    expect(findChrome({ PIX3_CHROME: '/opt/chrome.sh' }, 'linux')).toEqual({
      kind: 'binary',
      path: '/opt/chrome.sh',
    });
    expect(findChrome({ PATH: scratch }, 'linux')).toBeNull();
    expect(findChrome({ HOME: scratch }, 'darwin')).toBeNull();
  });

  it('records the port and profile under PIX3_HOME', () => {
    const env = { PIX3_HOME: join(scratch, 'home') };
    expect(readChromeState(env)).toBeNull();
    writeChromeState({ port: 9335, profile: chromeProfileDir(env), startedAt: 'now' }, env);
    expect(readChromeState(env)).toMatchObject({ port: 9335 });
    expect(chromeStatePath(env)).toBe(join(scratch, 'home', 'chrome.json'));
    expect(chromeProfileDir(env)).toBe(join(scratch, 'home', 'chrome'));
  });
});

describe('pix3 editor', () => {
  const io = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { cwd, env, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
      out: () => out.join(''),
      err: () => err.join(''),
    };
  };

  it('parses its options', () => {
    expect(parseEditorArgs(['--stop', '--cdp-port', '9340', '--headless'])).toEqual({
      stop: true,
      cdpPort: 9340,
      headless: true,
    });
    expect(parseEditorArgs(['--cdp-port'])).toEqual({ error: '--cdp-port needs a value' });
    expect(parseEditorArgs(['--port', 'x'])).toEqual({ error: '--port needs a port' });
    expect(parseEditorArgs(['--what'])).toEqual({ error: 'unknown option "--what"' });
  });

  it('refuses outside a project and explains a stale record under --chrome-only', async () => {
    const none = io(scratch);
    expect(await runEditorCli([], none.io)).toBe(2);
    expect(none.err()).toContain('pix3project.yaml');
    const dead = await freePort();
    const root = project({
      url: `http://127.0.0.1:${dead}/`,
      editorUrl: `http://127.0.0.1:${dead}/__pix3/`,
      port: dead,
      pid: 1,
    });
    const stale = io(root);
    expect(await runEditorCli(['--chrome-only'], stale.io)).toBe(1);
    expect(stale.err()).toContain('does not answer');
  });

  it('with a live server: --no-chrome stops after it, SSH skips Chrome, no Chrome is explained', async () => {
    const port = await serve({ '/__pix3/api/hello': { ok: true } });
    const root = project({
      url: `http://127.0.0.1:${port}/`,
      editorUrl: `http://127.0.0.1:${port}/__pix3/`,
      port,
      pid: 1,
    });
    const noChrome = io(root);
    expect(await runEditorCli(['--no-chrome'], noChrome.io)).toBe(0);
    expect(noChrome.out()).toContain(`Editor:     http://127.0.0.1:${port}/__pix3/`);
    expect(noChrome.out()).toContain('reused');

    const ssh = io(root, { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22', PATH: scratch });
    expect(await runEditorCli([], ssh.io)).toBe(0);
    expect(ssh.out()).toContain('SSH session');

    const none = io(root, { PATH: scratch, PIX3_HOME: join(scratch, 'home2') });
    expect(await runEditorCli([], none.io)).toBe(1);
    expect(none.err()).toContain('No Chrome found');
  });

  it('launches the Chrome PIX3_CHROME names on a free port and records it', async () => {
    const port = await serve({ '/__pix3/api/hello': { ok: true } });
    const root = project({
      url: `http://127.0.0.1:${port}/`,
      editorUrl: `http://127.0.0.1:${port}/__pix3/`,
      port,
      pid: 1,
    });
    // A "Chrome" that records its arguments and exits.
    const fake = join(scratch, 'fake-chrome.sh');
    const log = join(scratch, 'fake-chrome.log');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\n`, { mode: 0o755 });
    const cdp = await freePort();
    const env = { PIX3_CHROME: fake, PIX3_HOME: join(scratch, 'home3') };
    const run = io(root, env);
    expect(await runEditorCli(['--cdp-port', String(cdp), '--headless'], run.io)).toBe(0);
    expect(run.out()).toContain(`Chrome:     launched on port ${cdp}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const args = readFileSync(log, 'utf8').trim().split('\n');
    expect(args).toContain(`--remote-debugging-port=${cdp}`);
    expect(args).toContain(`--user-data-dir=${join(scratch, 'home3', 'chrome')}`);
    expect(args.at(-1)).toBe(`http://127.0.0.1:${port}/__pix3/`);
    expect(readChromeState(env)).toMatchObject({
      port: cdp,
      editorUrl: `http://127.0.0.1:${port}/__pix3/`,
    });
  });
});

beforeAll(() => {
  // Nothing here touches the real ~/.pix3: every state test passes PIX3_HOME.
  expect(chromeStatePath({ PIX3_HOME: '/x' })).toBe('/x/chrome.json');
});
