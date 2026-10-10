// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startProject, type TestProject } from '../test-support/harness.ts';

/**
 * The image-gen keys and proxy (plan §B.1 «Ключи генерации картинок»): who may call, that the
 * key reaches the upstream and nothing else, where and how it is stored.
 */

const GEMINI_KEY = 'AIzaSy-test-gemini-key-0123456789';
const OPENAI_KEY = 'sk-test-openai-key-abcdefghijklmnop';
const RUNTIME = {
  'node_modules/@pix3/runtime/package.json': JSON.stringify({
    name: '@pix3/runtime',
    version: '2.0.0-alpha.0',
  }),
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

/** A stand-in for both providers: records each request, answers what `reply` says. */
const startUpstream = async (
  reply: (seen: Seen) => { status: number; body: string } = () => ({
    status: 200,
    body: JSON.stringify({ data: [{ b64_json: 'aGk=' }] }),
  })
): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> => {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(entry);
      const answer = reply(entry);
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
  readonly p: TestProject;
  readonly home: string;
  readonly upstream: Awaited<ReturnType<typeof startUpstream>>;
  readonly session: string;
  /** A call the way the editor page makes it. */
  editor(path: string, init?: RequestInit): Promise<Response>;
}

const setup = async (
  reply?: Parameters<typeof startUpstream>[0],
  home = mkdtempSync(join(tmpdir(), 'pix3-home-'))
): Promise<Setup> => {
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const upstream = await startUpstream(reply);
  cleanups.push(() => upstream.close());
  const p = await startProject(RUNTIME, {
    imageGen: { home, upstreams: { gemini: upstream.url, openai: `${upstream.url}/oa` } },
  });
  cleanups.push(() => p.close());
  const page = await (
    await p.fetch('/__pix3/', { headers: { 'Sec-Fetch-Dest': 'document' } })
  ).text();
  const session = /name="pix3-session" content="([^"]+)"/.exec(page)?.[1] ?? '';
  expect(session).not.toBe('');
  const editor = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('X-Pix3', '1');
    headers.set('X-Pix3-Session', session);
    headers.set('Origin', p.origin);
    headers.set('Referer', `${p.origin}/__pix3/`);
    headers.set('Sec-Fetch-Site', 'same-origin');
    return p.fetch(path, { ...init, headers });
  };
  return { p, home, upstream, session, editor };
};

const putKey = (s: Setup, provider: string, key: string | null): Promise<Response> =>
  s.editor('/__pix3/api/keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('the editor session token', () => {
  it('is in the editor page only for a top-level navigation', async () => {
    const { p, session } = await setup();
    const page = (dest: string) =>
      p.fetch('/__pix3/', { headers: { 'Sec-Fetch-Dest': dest } }).then(r => r.text());
    // The game at `/` can fetch or frame the editor page: neither carries the token.
    expect(await page('empty')).not.toContain(session);
    expect(await page('iframe')).not.toContain(session);
    expect(await page('document')).toContain(session);
    const response = await p.fetch('/__pix3/', { headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('keys', () => {
  it('stores a key 0600 in ~/.pix3/keys.json and only ever answers set / last4', async () => {
    const s = await setup();
    expect((await json(await s.editor('/__pix3/api/keys'))).keys).toEqual({
      gemini: { set: false },
      openai: { set: false },
    });
    const put = await putKey(s, 'gemini', GEMINI_KEY);
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(GEMINI_KEY);
    expect(JSON.parse(putText)).toEqual({
      provider: 'gemini',
      set: true,
      last4: GEMINI_KEY.slice(-4),
      where: 'home',
    });
    const file = join(s.home, 'keys.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ gemini: GEMINI_KEY });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(s.home).mode & 0o077).toBe(0);

    const statusText = await (await s.editor('/__pix3/api/keys')).text();
    expect(statusText).not.toContain(GEMINI_KEY);
    expect(JSON.parse(statusText).keys.gemini).toEqual({ set: true, last4: GEMINI_KEY.slice(-4) });

    await putKey(s, 'gemini', null);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('falls back to .pix3/local/keys.json when the home directory is not writable', async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const parent = mkdtempSync(join(tmpdir(), 'pix3-ro-'));
    mkdirSync(join(parent, 'locked'));
    chmodSync(join(parent, 'locked'), 0o500);
    cleanups.push(() => {
      chmodSync(join(parent, 'locked'), 0o700);
      rmSync(parent, { recursive: true, force: true });
    });
    const s = await setup(undefined, join(parent, 'locked', '.pix3'));
    expect(await json(await putKey(s, 'openai', OPENAI_KEY))).toMatchObject({
      set: true,
      where: 'project',
    });
    const local = join(s.p.root, '.pix3', 'local', 'keys.json');
    expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({ openai: OPENAI_KEY });
    expect(statSync(local).mode & 0o777).toBe(0o600);
    // The proxy reads it from there.
    const answer = await s.editor('/__pix3/api/proxy/openai/v1/images/generations', {
      method: 'POST',
      body: '{}',
    });
    expect(answer.status).toBe(200);
    expect(s.upstream.seen[0].headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    // Never served: not as a static file, not by /@fs/, not through the file API.
    for (const path of [
      '/.pix3/local/keys.json',
      '/%2epix3/local/keys.json',
      '/.PIX3/local/keys.json',
      `/@fs${s.p.root}/.pix3/local/keys.json`,
      '/.pix3/local/keys.json?import',
    ]) {
      const response = await s.p.fetch(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain(OPENAI_KEY);
    }
    const viaApi = await s.p.fetch('/__pix3/api/file?path=.pix3/local/keys.json');
    expect(viaApi.status).toBe(403);
  });

  it('refuses a bad provider or key', async () => {
    const s = await setup();
    expect((await putKey(s, 'midjourney', 'x')).status).toBe(400);
    expect((await putKey(s, 'gemini', 'two words')).status).toBe(400);
  });
});

describe('the proxy', () => {
  it('adds the key server-side, forwards the body, and the page never sees the key', async () => {
    const s = await setup(seen => ({
      status: 400,
      // An upstream that quotes the key back (some do, in an error).
      body: JSON.stringify({
        error: { message: `bad key ${String(seen.headers['x-goog-api-key'])}` },
      }),
    }));
    const info = vi.spyOn(s.p.server.config.logger, 'info');
    const warn = vi.spyOn(s.p.server.config.logger, 'warn');
    await putKey(s, 'gemini', GEMINI_KEY);
    const body = JSON.stringify({ contents: [{ parts: [{ text: 'a red cube' }] }] });
    const response = await s.editor(
      '/__pix3/api/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
      {
        method: 'POST',
        // Whatever the page sends as a key is not forwarded.
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'from-the-page',
          Authorization: 'Bearer from-the-page',
          Cookie: 'a=b',
        },
        body,
      }
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(GEMINI_KEY);
    expect(text).toContain('[key]');
    const [seen] = s.upstream.seen;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(seen.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-pix3-session']).toBeUndefined();
    expect(seen.body.toString('utf8')).toBe(body);
    const logged = [...info.mock.calls, ...warn.mock.calls].map(call => String(call[0]));
    expect(logged.some(line => line.includes('gemini') && line.includes('400'))).toBe(true);
    expect(logged.join('\n')).not.toContain(GEMINI_KEY);
  });

  it('forwards a multipart edit byte for byte with the OpenAI Bearer key', async () => {
    const s = await setup();
    await putKey(s, 'openai', OPENAI_KEY);
    const form = new FormData();
    form.set('model', 'gpt-image-1.5');
    form.append('image[]', new Blob([new Uint8Array([0, 255, 128, 10, 13])]), 'ref.png');
    const response = await s.editor('/__pix3/api/proxy/openai/v1/images/edits', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ b64_json: 'aGk=' }] });
    const [seen] = s.upstream.seen;
    expect(seen.url).toBe('/oa/v1/images/edits');
    expect(seen.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(String(seen.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.body.includes(Buffer.from([0, 255, 128, 10, 13]))).toBe(true);
  });

  it('answers 409 no_key without calling the upstream', async () => {
    const s = await setup();
    const response = await s.editor('/__pix3/api/proxy/openai/v1/images/generations', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('no_key');
    expect(s.upstream.seen).toHaveLength(0);
  });

  it('forwards the two generation endpoints only', async () => {
    const s = await setup();
    await putKey(s, 'gemini', GEMINI_KEY);
    await putKey(s, 'openai', OPENAI_KEY);
    for (const path of [
      'gemini/v1beta/files',
      'gemini/v1beta/models/x:streamGenerateContent',
      'gemini/v1beta/models/../../x:generateContent',
      'openai/v1/chat/completions',
      'openai/v1/images/generations/../../files',
    ]) {
      const response = await s.editor(`/__pix3/api/proxy/${path}`, { method: 'POST', body: '{}' });
      expect([path, response.status]).toEqual([path, 403]);
    }
    expect((await s.editor('/__pix3/api/proxy/stability/v1/x', { method: 'POST' })).status).toBe(
      404
    );
    expect(s.upstream.seen).toHaveLength(0);
  });
});

describe('who may call', () => {
  it('refuses everything but the editor page', async () => {
    const s = await setup();
    await putKey(s, 'gemini', GEMINI_KEY);
    const route = '/__pix3/api/proxy/gemini/v1beta/models/m:generateContent';
    const base = {
      'X-Pix3': '1',
      'X-Pix3-Session': s.session,
      Origin: s.p.origin,
      Referer: `${s.p.origin}/__pix3/`,
      'Sec-Fetch-Site': 'same-origin',
    };
    const cases: [string, Record<string, string | undefined>, string][] = [
      ['no X-Pix3', { 'X-Pix3': undefined }, 'missing_x_pix3'],
      ['another origin', { Origin: 'http://evil.example' }, 'forbidden_origin'],
      ['a cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }, 'forbidden_site'],
      ['the game page', { Referer: `${s.p.origin}/` }, 'forbidden_page'],
      ['the game, deeper', { Referer: `${s.p.origin}/src/main.ts` }, 'forbidden_page'],
      ['no session', { 'X-Pix3-Session': undefined }, 'bad_session'],
      ['a wrong session', { 'X-Pix3-Session': `${s.session.slice(1)}x` }, 'bad_session'],
    ];
    for (const [name, change, code] of cases) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...base, ...change })) {
        if (value !== undefined) headers[key] = value;
      }
      for (const [path, method] of [
        [route, 'POST'],
        ['/__pix3/api/keys', 'GET'],
        ['/__pix3/api/keys', 'PUT'],
      ] as const) {
        const response = await s.p.fetch(path, {
          method,
          headers,
          body: method === 'GET' ? undefined : '{}',
        });
        expect([name, path, method, response.status]).toEqual([name, path, method, 403]);
        expect([name, (await json(response)).error]).toEqual([name, code]);
      }
    }
    expect(s.upstream.seen).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(s.home, 'keys.json'), 'utf8'))).toEqual({
      gemini: GEMINI_KEY,
    });
  });
});
