// @vitest-environment node
import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { proveCdpProxy } from './cdp-proof.ts';
import { CdpProxy } from './cdp-proxy.ts';
import { FakeChrome } from './fake-chrome.ts';
import { CDP_PROXY_HEADER } from './paths.ts';

/**
 * The CDP token proxy (plan §D.5) against an in-memory Chrome (`fake-chrome.ts`, modelled on
 * what Chrome 155 does over the pipe): who gets in, how two clients share one pipe (own root
 * session, remapped ids, events only to the session's owner), and what closes when.
 */

const TOKEN = 'a'.repeat(43);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

const running: Array<{ proxy: CdpProxy; pipe: ReturnType<FakeChrome['pipe']> }> = [];
afterEach(async () => {
  for (const { proxy } of running.splice(0)) await proxy.close();
});

const start = async (urls?: string[]) => {
  const chrome = new FakeChrome(urls);
  const pipe = chrome.pipe();
  const proxy = new CdpProxy({ pipe, token: TOKEN });
  const port = await proxy.listen(0);
  running.push({ proxy, pipe });
  return { chrome, pipe, proxy, port };
};

/** A CDP client: every message it gets, `send` → the answer to that id. */
const connect = (port: number, path = '/pix3', headers: Record<string, string> = AUTH) =>
  new Promise<{
    socket: WebSocket;
    messages: Message[];
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
      id?: number
    ) => Promise<Message>;
    closed: Promise<number>;
  }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const messages: Message[] = [];
    const waiters = new Map<number, (m: Message) => void>();
    let next = 1;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Message;
      messages.push(message);
      if (message.id !== undefined) waiters.get(message.id)?.(message);
    });
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.once('error', reject);
    const closed = new Promise<number>(r => socket.once('close', code => r(code)));
    socket.once('open', () =>
      resolve({
        socket,
        messages,
        closed,
        send: (method, params = {}, sessionId, id = next++) =>
          new Promise(r => {
            waiters.set(id, r);
            socket.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
            );
          }),
      })
    );
  });

const get = (port: number, path: string, headers: Record<string, string> = AUTH) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });

/** `fetch` sends its own Host; a hand-made request can lie about it. */
const rawStatus = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end();
  });

const until = async (predicate: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise(r => setTimeout(r, 10));
  }
};

describe('auth', () => {
  it('answers discovery only to the token, from loopback, without an Origin', async () => {
    const { port } = await start(['http://localhost:5173/__pix3/']);
    const none = await get(port, '/json/version', {});
    expect(none.status).toBe(401);
    expect(none.headers.get(CDP_PROXY_HEADER)).toBe('1');
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect((await get(port, '/json/list', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await get(port, '/json/list', { Authorization: TOKEN })).status).toBe(401);
    expect(
      (await get(port, '/json/list', { ...AUTH, Origin: 'https://evil.example' })).status
    ).toBe(403);
    // DNS rebinding: a name that resolves to 127.0.0.1 is still not a loopback Host.
    expect(await rawStatus(port, '/json/list', { ...AUTH, Host: 'evil.example:80' })).toBe(403);

    const version = (await (await get(port, '/json/version')).json()) as Record<string, unknown>;
    expect(version).toMatchObject({
      Browser: 'FakeChrome/1.0',
      'Pix3-Cdp-Proxy': 1,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/pix3`,
    });
    const list = (await (await get(port, '/json/list')).json()) as Array<Record<string, unknown>>;
    expect(list).toEqual([
      expect.objectContaining({
        type: 'page',
        url: 'http://localhost:5173/__pix3/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/pix3/page/${String(list[0].id)}`,
      }),
    ]);
    expect((await get(port, '/json')).status).toBe(200);
    expect((await get(port, '/json/new?about:blank')).status).toBe(404);
  });

  it('refuses a WebSocket without the token, with a wrong one, or from a page — before it opens', async () => {
    const { port, chrome, proxy } = await start();
    await expect(connect(port, '/pix3', {})).rejects.toThrow('HTTP 401');
    await expect(connect(port, '/pix3', { Authorization: 'Bearer wrong' })).rejects.toThrow(
      'HTTP 401'
    );
    await expect(
      connect(port, '/pix3', { ...AUTH, Origin: 'http://localhost:5173' })
    ).rejects.toThrow('HTTP 403');
    await expect(connect(port, '/devtools/browser/x')).rejects.toThrow('HTTP 404');
    await expect(connect(port, '/pix3/page/NOPE')).rejects.toThrow('HTTP 404');
    expect(proxy.clientCount).toBe(0);
    // Nothing reached Chrome for the refused ones but the page lookup.
    expect(chrome.received.map(m => m.method)).toEqual(['Target.attachToTarget']);
  });
});

describe('proof of the token (a forwarded port on a shared host)', () => {
  it('proves it knows the token without the client sending it; a squatter cannot', async () => {
    const { port, proxy } = await start();
    expect(await proveCdpProxy(port, TOKEN)).toEqual({ kind: 'ours' });
    // Another user's proxy: it answers with the marker, but its proof is for its own token.
    const other = await proveCdpProxy(port, 'b'.repeat(43));
    expect(other.kind).toBe('foreign');
    expect(other.kind === 'foreign' && other.detail).toMatch(/does not know this token/);
    // A squatter that echoes the marker and the challenge back still has no proof.
    const squatter = createServer((req, res) => {
      res.writeHead(401, {
        [CDP_PROXY_HEADER]: '1',
        'X-Pix3-Proof': String(req.headers['x-pix3-challenge'] ?? ''),
      });
      res.end();
    });
    await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve));
    const squatterPort = (squatter.address() as { port: number }).port;
    expect((await proveCdpProxy(squatterPort, TOKEN)).kind).toBe('foreign');
    await new Promise<void>(resolve => squatter.close(() => resolve()));
    expect(await proveCdpProxy(squatterPort, TOKEN)).toEqual({ kind: 'closed' });
    expect(proxy.clientCount).toBe(0);
  });
});

describe('two clients on one pipe', () => {
  it('each gets its own browser session; ids are remapped both ways', async () => {
    const { port, chrome } = await start();
    const a = await connect(port);
    const b = await connect(port);
    const [ra, rb] = await Promise.all([
      a.send('Browser.getVersion', {}, undefined, 7),
      b.send('Browser.getVersion', {}, undefined, 7),
    ]);
    // Both asked with id 7 and both got their own answer to 7, without a session id.
    expect(ra).toMatchObject({ id: 7, result: { product: 'FakeChrome/1.0' } });
    expect(rb).toMatchObject({ id: 7, result: { product: 'FakeChrome/1.0' } });
    expect(ra.sessionId).toBeUndefined();
    const seen = chrome.received.filter(m => m.method === 'Browser.getVersion');
    expect(new Set(seen.map(m => m.id)).size).toBe(2);
    expect(new Set(seen.map(m => m.sessionId)).size).toBe(2);
    expect(
      seen.every(m => m.sessionId && chrome.sessions.get(m.sessionId)?.kind === 'browser')
    ).toBe(true);
  });

  it('routes events to the session owner only; a session of another client is not found', async () => {
    const { port } = await start(['about:blank']);
    const a = await connect(port);
    const b = await connect(port);
    // a auto-attaches: its child session is announced to a alone.
    await a.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await until(() => a.messages.some(m => m.method === 'Target.attachedToTarget'));
    const attached = a.messages.find(m => m.method === 'Target.attachedToTarget') as Message;
    expect(attached.sessionId).toBeUndefined(); // a's root, as a sees it
    const child = String(attached.params?.sessionId);
    const pinged = await a.send('Fake.ping', {}, child);
    expect(pinged).toMatchObject({ result: { pong: true }, sessionId: child });
    await until(() => a.messages.some(m => m.method === 'Fake.pinged'));
    expect(a.messages.find(m => m.method === 'Fake.pinged')?.sessionId).toBe(child);
    // b sees none of it, and may not use a's session.
    expect(b.messages.filter(m => m.method)).toEqual([]);
    const stolen = await b.send('Runtime.evaluate', { expression: '1' }, child);
    expect(stolen).toMatchObject({
      error: { code: -32001, message: 'Session with given id not found.' },
    });
    // a's own evaluate ran in a's child session.
    const evaluated = await a.send('Runtime.evaluate', { expression: '1 + 1' }, child);
    expect(evaluated.result).toEqual({
      result: { type: 'object', value: { expression: '1 + 1', session: child } },
    });
  });

  it('a page client talks to its page without session ids; the page closing closes it', async () => {
    const { port, chrome } = await start(['about:blank', 'http://localhost:5173/__pix3/']);
    const list = (await (await get(port, '/json/list')).json()) as Array<{
      id: string;
      url: string;
    }>;
    const editor = list.find(p => p.url.endsWith('/__pix3/')) as { id: string };
    const page = await connect(port, `/pix3/page/${editor.id}`);
    const evaluated = await page.send('Runtime.evaluate', { expression: 'document.title' });
    expect(evaluated.sessionId).toBeUndefined();
    const ran = (evaluated.result?.result as { value: { session: string } }).value.session;
    expect(chrome.sessions.get(ran)?.targetId).toBe(editor.id);
    const browser = await connect(port);
    await browser.send('Target.closeTarget', { targetId: editor.id });
    expect(await page.closed).toBe(1000);
  });

  it('a client that leaves is detached, children with it; the others keep working', async () => {
    const { port, chrome, proxy } = await start(['about:blank']);
    const a = await connect(port);
    const b = await connect(port);
    await a.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    await until(() => a.messages.some(m => m.method === 'Target.attachedToTarget'));
    expect(chrome.sessions.size).toBe(3); // a's browser session + its child, b's browser session
    a.socket.close();
    await until(() => chrome.sessions.size === 1);
    expect([...chrome.sessions.values()][0].kind).toBe('browser');
    expect(proxy.clientCount).toBe(1);
    expect(await b.send('Browser.getVersion')).toMatchObject({
      result: { product: 'FakeChrome/1.0' },
    });
  });

  it('a malformed message is answered with an error, not forwarded', async () => {
    const { port, chrome } = await start();
    const a = await connect(port);
    a.socket.send('not json');
    a.socket.send(JSON.stringify({ id: 3 }));
    await until(() => a.messages.length === 2);
    expect(a.messages.map(m => m.error?.code)).toEqual([-32700, -32600]);
    expect(chrome.received.filter(m => m.method !== 'Target.attachToBrowserTarget')).toEqual([]);
  });
});

describe('Chrome gone', () => {
  it('the pipe closing closes every client and tells the owner', async () => {
    const { port, pipe, proxy } = await start();
    const a = await connect(port);
    const b = await connect(port, '/pix3');
    let told = false;
    proxy.onClose(() => {
      told = true;
    });
    pipe.close();
    expect(await a.closed).toBe(1001);
    expect(await b.closed).toBe(1001);
    expect(told).toBe(true);
    expect(proxy.clientCount).toBe(0);
    await expect(proxy.call('Browser.getVersion')).rejects.toThrow('Chrome is gone');
  });
});
