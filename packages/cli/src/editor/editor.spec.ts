// @vitest-environment node
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chooseCdpPort, inspectCdpPort, isEditorPageUrl } from './cdp-port.ts';
import { CdpProxy } from './cdp-proxy.ts';
import { ensureCdpToken, readCdpToken } from './cdp-token.ts';
import { chromeArgs, findChrome, handoffArgs } from './chrome.ts';
import { readChromeState, writeChromeState } from './chrome-state.ts';
import { parseEditorArgs, runEditorCli } from './command.ts';
import { findCdpForward, remoteForwardLines, tokenCopyLine } from './remote.ts';
import { findDevServer, findViteBin, readDevInfo, stopDevServer } from './dev-server.ts';
import { FakeChrome } from './fake-chrome.ts';
import {
  CDP_PORT_RANGE,
  cdpTokenPath,
  chromeProfileDir,
  chromeStatePath,
  DEFAULT_CDP_PORT,
  remoteCdpTokenPath,
} from './paths.ts';

/**
 * `pix3 editor` (plan §D.3, §D.4, §D.5): `.pix3/dev.json` discovery against a real HTTP probe,
 * the 9333 check against servers that imitate Chrome's `/json/version` + `/json/list` and against
 * a real proxy, the token file, the Chrome argument list, and the command's own answers (no
 * project, `--stop`, `--chrome-only` without a server, SSH, no Chrome) — down to a real detached
 * owner process driving `fake-chrome.ts` over the pipe. Real Chrome and Vite are the bridge-e2e
 * harness's job.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

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
  it('a closed port is free; our proxy answering our token is ours', async () => {
    expect(await inspectCdpPort(await freePort())).toEqual({ kind: 'free' });
    const token = 'b'.repeat(43);
    const proxy = new CdpProxy({
      pipe: new FakeChrome(['http://localhost:5173/__pix3/']).pipe(),
      token,
    });
    const port = await proxy.listen(0);
    try {
      expect(await inspectCdpPort(port, { token })).toEqual({
        kind: 'ours',
        browser: 'FakeChrome/1.0',
        pages: ['http://localhost:5173/__pix3/'],
      });
      // Another user's (or another PIX3_HOME's) proxy: foreign, and said so.
      expect(await inspectCdpPort(port, { token: 'c'.repeat(43) })).toMatchObject({
        kind: 'foreign',
        detail: expect.stringContaining('Pix3 CDP proxy that does not know this token'),
      });
      expect(await inspectCdpPort(port)).toMatchObject({ kind: 'foreign' });
    } finally {
      await proxy.close();
    }
  });

  it('never sends the token to a port that has not proven it knows it', async () => {
    const token = 'd'.repeat(43);
    const seen: Array<string | undefined> = [];
    // A squatter that echoes the proxy's marker and a proof-shaped header, then a plain
    // DevTools endpoint with a Pix3 page: neither may see an Authorization header.
    const recording = (headers: Record<string, string>, routes: Record<string, unknown>) =>
      new Promise<number>(resolve => {
        const server = createServer((req, res) => {
          seen.push(req.headers.authorization);
          const body = routes[req.url ?? ''];
          res.writeHead(body === undefined ? 401 : 200, {
            'Content-Type': 'application/json',
            ...headers,
          });
          res.end(body === undefined ? '' : JSON.stringify(body));
        });
        servers.push(server);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
        });
      });
    const squatter = await recording(
      { 'X-Pix3-Cdp-Proxy': '1', 'X-Pix3-Proof': 'x'.repeat(43) },
      {}
    );
    expect(await inspectCdpPort(squatter, { token })).toMatchObject({ kind: 'foreign' });
    const p1 = await recording({}, chrome('Chrome/155.0', ['http://localhost:5173/__pix3/']));
    expect(await inspectCdpPort(p1, { token })).toMatchObject({ kind: 'legacy' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(header => header === undefined)).toBe(true);
  });

  it('a plain DevTools port with a Pix3 editor page or on the recorded port is the P1 launch', async () => {
    const p1 = await serve(chrome('Chrome/155.0', ['http://localhost:5173/__pix3/']));
    expect(await inspectCdpPort(p1, { token: 'x'.repeat(43) })).toMatchObject({
      kind: 'legacy',
      browser: 'Chrome/155.0',
    });
    const recorded = await serve(chrome('Chrome/155.0', ['about:blank']));
    expect(await inspectCdpPort(recorded, { recordedPort: recorded })).toMatchObject({
      kind: 'legacy',
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
  it('builds the app-window argument list of plan §D.4 over the pipe, or a headless tab', () => {
    const args = chromeArgs({ url: 'http://localhost:5173/__pix3/', profile: '/p' });
    expect(args).toEqual([
      '--user-data-dir=/p',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--app=http://localhost:5173/__pix3/',
    ]);
    expect(args.some(a => a.startsWith('--remote-debugging-port'))).toBe(false);
    const headless = chromeArgs({ url: 'http://x/', profile: '/p', headless: true });
    expect(headless.slice(-2)).toEqual(['--headless=new', 'http://x/']);
    expect(headless.some(a => a.startsWith('--app='))).toBe(false);
    // The handoff to a running Chrome carries no debugging flag at all.
    expect(handoffArgs({ url: 'http://x/', profile: '/p' })).toEqual([
      '--user-data-dir=/p',
      ...args.slice(2, -1),
      '--app=http://x/',
    ]);
  });

  it('PIX3_CHROME wins; an empty PATH finds nothing on linux; macOS looks for the binary', () => {
    expect(findChrome({ PIX3_CHROME: '/opt/chrome.sh' }, 'linux')).toEqual({
      kind: 'binary',
      path: '/opt/chrome.sh',
    });
    expect(findChrome({ PATH: scratch }, 'linux')).toBeNull();
    expect(findChrome({ HOME: scratch }, 'darwin')).toBeNull();
  });

  it('creates the token once, 0600, and narrows a file others can read', () => {
    const env = { PIX3_HOME: join(scratch, 'home-token') };
    expect(readCdpToken(env)).toBeNull();
    const token = ensureCdpToken(env);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureCdpToken(env)).toBe(token);
    expect(readCdpToken(env)).toBe(token);
    if (process.platform !== 'win32') {
      expect(statSync(cdpTokenPath(env)).mode & 0o777).toBe(0o600);
      chmodSync(cdpTokenPath(env), 0o644);
      expect(ensureCdpToken(env)).toBe(token);
      expect(statSync(cdpTokenPath(env)).mode & 0o777).toBe(0o600);
    }
    // A file that holds no token is replaced.
    writeFileSync(cdpTokenPath(env), 'short\n');
    const replaced = ensureCdpToken(env);
    expect(replaced).not.toBe(token);
    expect(readCdpToken(env)).toBe(replaced);
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

    const ssh = io(root, {
      SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22',
      PATH: scratch,
      PIX3_HOME: join(scratch, 'home-ssh'),
    });
    expect(await runEditorCli(['--cdp-port', String(await freePort())], ssh.io)).toBe(0);
    expect(ssh.out()).toContain('SSH session');
    expect(ssh.out()).toContain('no token here yet');

    const none = io(root, { PATH: scratch, PIX3_HOME: join(scratch, 'home2') });
    expect(await runEditorCli([], none.io)).toBe(1);
    expect(none.err()).toContain('No Chrome found');
  });

  /** A "Chrome" that records its arguments and runs `fake-chrome.ts` on the pipe it inherits. */
  const fakeChrome = (name: string, extra = '') => {
    const path = join(scratch, `${name}.sh`);
    const log = join(scratch, `${name}.args`);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nexec ${process.execPath} ${join(SRC, 'editor', 'fake-chrome.ts')} ${extra} "$@"\n`,
      { mode: 0o755 }
    );
    return { path, args: () => readFileSync(log, 'utf8').trim().split('\n') };
  };
  const liveProject = async () => {
    const port = await serve({ '/__pix3/api/hello': { ok: true } });
    return {
      root: project({
        url: `http://127.0.0.1:${port}/`,
        editorUrl: `http://127.0.0.1:${port}/__pix3/`,
        port,
        pid: 1,
      }),
      editorUrl: `http://127.0.0.1:${port}/__pix3/`,
    };
  };

  it.skipIf(process.platform === 'win32')(
    'launches Chrome on the pipe behind the proxy, reuses it, opens a second project in it, stops it',
    async () => {
      const first = await liveProject();
      const fake = fakeChrome('fake-chrome');
      const cdp = await freePort();
      const env = { PIX3_CHROME: fake.path, PIX3_HOME: join(scratch, 'home3') };
      const entry = join(SRC, 'index.ts');
      const run = io(first.root, env);
      expect(
        await runEditorCli(['--cdp-port', String(cdp), '--headless'], { ...run.io, entry }),
        run.err()
      ).toBe(0);
      expect(run.out()).toContain(
        `Chrome:     launched behind the CDP proxy ws://127.0.0.1:${cdp}/pix3`
      );
      const args = fake.args();
      expect(args).toContain('--remote-debugging-pipe');
      expect(args.some(a => a.startsWith('--remote-debugging-port'))).toBe(false);
      expect(args).toContain(`--user-data-dir=${join(scratch, 'home3', 'chrome')}`);
      expect(args.at(-1)).toBe(first.editorUrl);
      const state = readChromeState(env);
      expect(state).toMatchObject({ port: cdp, editorUrl: first.editorUrl, proxy: 1 });
      expect(state?.ownerPid).toBeGreaterThan(0);
      const token = readCdpToken(env) as string;
      expect(await inspectCdpPort(cdp, { token })).toMatchObject({
        kind: 'ours',
        pages: [first.editorUrl],
      });
      expect((await fetch(`http://127.0.0.1:${cdp}/json/version`)).status).toBe(401);

      // Again: nothing launched, the tab is there. The project's P2 entry (the token on the
      // command line) is named as one that needs `agent-setup --repair`.
      writeFileSync(
        join(first.root, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'pix3-browser': {
              command: 'npx',
              args: [`--wsEndpoint=ws://127.0.0.1:${cdp}/pix3`, `--wsHeaders=${token}`],
            },
          },
        })
      );
      const again = io(first.root, env);
      expect(
        await runEditorCli(['--cdp-port', String(cdp), '--headless'], { ...again.io, entry })
      ).toBe(0);
      expect(again.out()).toContain('already behind');
      expect(again.out()).toContain('the editor tab is open there');
      expect(again.out()).toContain('.mcp.json has a pix3-browser entry that does not reach');
      expect(again.out()).not.toContain(token);

      // A second project: a new tab in the same Chrome, through the proxy.
      const second = await liveProject();
      const other = io(second.root, env);
      expect(
        await runEditorCli(['--cdp-port', String(cdp), '--headless'], { ...other.io, entry })
      ).toBe(0);
      expect(other.out()).toContain('opened the editor in a new window');
      expect(await inspectCdpPort(cdp, { token })).toMatchObject({
        pages: [first.editorUrl, second.editorUrl],
      });

      // --stop-chrome: the owner closes Chrome and leaves; the record goes with it.
      const stop = io(first.root, env);
      expect(await runEditorCli(['--stop-chrome'], stop.io)).toBe(0);
      expect(stop.out()).toContain('Stopped Chrome and its CDP proxy');
      expect(existsSync(chromeStatePath(env))).toBe(false);
      expect(await inspectCdpPort(cdp, { token })).toEqual({ kind: 'free' });
    },
    30_000
  );

  it.skipIf(process.platform === 'win32')(
    'says why when Chrome exits before it answers (a profile another Chrome holds)',
    async () => {
      const { root } = await liveProject();
      const fake = fakeChrome('fake-chrome-exits', '--fake-exit-at-once');
      const env = { PIX3_CHROME: fake.path, PIX3_HOME: join(scratch, 'home4') };
      const run = io(root, env);
      const code = await runEditorCli(['--cdp-port', String(await freePort()), '--headless'], {
        ...run.io,
        entry: join(SRC, 'index.ts'),
      });
      expect(code).toBe(1);
      expect(run.err()).toContain('Chrome exited before it answered');
      expect(run.err()).toContain('close it and run pix3 editor again');
      expect(readChromeState(env)).toBeNull();
    },
    30_000
  );

  it('refuses to start next to the P1 launch (open debugging port) and says what to close', async () => {
    const { root } = await liveProject();
    const p1 = await serve(chrome('Chrome/155.0', ['http://localhost:5173/__pix3/']));
    const env = { PIX3_CHROME: '/bin/false', PIX3_HOME: join(scratch, 'home5') };
    const run = io(root, env);
    expect(await runEditorCli(['--cdp-port', String(p1)], run.io)).toBe(1);
    expect(run.err()).toContain('open debugging port and no token');
    expect(run.err()).toContain('Close that Chrome');
  });

  it('--url: no project needed; a forward that does not answer is said so', async () => {
    expect(parseEditorArgs(['--url', 'http://localhost:5174'])).toEqual({
      url: 'http://localhost:5174/__pix3/',
      chromeOnly: true,
    });
    expect(
      parseEditorArgs(['--url', 'http://localhost:5174/game/__pix3/', '--ssh', 'box'])
    ).toEqual({ url: 'http://localhost:5174/game/__pix3/', chromeOnly: true, sshHost: 'box' });
    expect(parseEditorArgs(['--url', 'file:///x'])).toEqual({
      error: '--url needs an http(s) URL, not "file:///x"',
    });
    const run = io(scratch, { PIX3_HOME: join(scratch, 'home-url') });
    expect(await runEditorCli(['--url', `http://127.0.0.1:${await freePort()}/`], run.io)).toBe(1);
    expect(run.err()).toContain('does not answer as a Pix3 editor');
  });

  it.skipIf(process.platform === 'win32')(
    'Remote SSH: the human side opens the forwarded editor and prints the token copy; the remote side sees the forward',
    async () => {
      // The human's machine: no project, the editor of a remote dev server through a forward.
      const hello = await serve({ '/__pix3/api/hello': { ok: true } });
      const editorUrl = `http://127.0.0.1:${hello}/__pix3/`;
      const fake = fakeChrome('fake-chrome-remote');
      const cdp = await freePort();
      const local = { PIX3_CHROME: fake.path, PIX3_HOME: join(scratch, 'home-local') };
      const run = io(scratch, local);
      expect(
        await runEditorCli(
          ['--url', editorUrl, '--ssh', 'devbox', '--cdp-port', String(cdp), '--headless'],
          { ...run.io, entry: join(SRC, 'index.ts') }
        ),
        run.err()
      ).toBe(0);
      expect(fake.args().at(-1)).toBe(editorUrl);
      const token = readCdpToken(local) as string;
      expect(run.out()).toContain(tokenCopyLine(cdpTokenPath(local), 'devbox', 'linux'));
      expect(run.out()).toContain(`RemoteForward 127.0.0.1:${DEFAULT_CDP_PORT} 127.0.0.1:${cdp}`);
      expect(run.out()).not.toContain(token);

      // The remote host: its "forward" is the proxy's port itself here (the e2e forwards it).
      const remote = { PIX3_HOME: join(scratch, 'home-remote') };
      expect((await findCdpForward(null, { preferred: cdp })).live).toBeNull();
      mkdirSync(remote.PIX3_HOME, { recursive: true });
      writeFileSync(remoteCdpTokenPath(remote), `${token}\n`, { mode: 0o600 });
      const { root } = await liveProject();
      const ssh = io(root, { ...remote, SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' });
      expect(await runEditorCli(['--cdp-port', String(cdp)], ssh.io)).toBe(0);
      expect(ssh.out()).toContain(`CDP forward: live on 127.0.0.1:${cdp}`);
      expect(ssh.out()).toContain(remoteForwardLines(cdp)[0]);
      expect(ssh.out()).toContain('editor --chrome-only --url http://127.0.0.1:');
      // Another user's token is not proven, and nothing was launched on the remote side.
      writeFileSync(remoteCdpTokenPath(remote), `${'z'.repeat(43)}\n`);
      const other = await findCdpForward('z'.repeat(43), { preferred: cdp });
      expect(other.live).toBeNull();
      expect(other.taken[0]).toMatchObject({ port: cdp });

      const stop = io(scratch, local);
      expect(await runEditorCli(['--stop-chrome'], stop.io)).toBe(0);
    },
    30_000
  );

  it('prints the token copy for cmd / PowerShell on Windows', () => {
    expect(tokenCopyLine('C:\\Users\\a\\.pix3\\cdp-token', 'box', 'win32')).toBe(
      'type "C:\\Users\\a\\.pix3\\cdp-token" | ssh box "umask 077 && mkdir -p ~/.pix3 && cat > ~/.pix3/remote-cdp-token"'
    );
    expect(tokenCopyLine('/h/.pix3/cdp-token', 'box', 'linux')).toBe(
      "ssh box 'umask 077 && mkdir -p ~/.pix3 && cat > ~/.pix3/remote-cdp-token' < /h/.pix3/cdp-token"
    );
  });

  it('--stop-chrome without a recorded owner says so', async () => {
    const run = io(scratch, { PIX3_HOME: join(scratch, 'home6') });
    expect(await runEditorCli(['--stop-chrome'], run.io)).toBe(0);
    expect(run.out()).toContain('No Chrome owner recorded');
  });
});

beforeAll(() => {
  // Nothing here touches the real ~/.pix3: every state test passes PIX3_HOME.
  expect(chromeStatePath({ PIX3_HOME: '/x' })).toBe('/x/chrome.json');
});
