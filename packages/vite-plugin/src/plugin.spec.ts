// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { ScriptGraph } from './sync/script-graph.ts';
import { sleep, startProject, type TestProject } from './test-support/harness.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const SCENE = 'root:\n  - id: a\n    type: Group2D\n';
const runtimeAt = (version: string): Record<string, string> => ({
  'node_modules/@pix3/runtime/package.json': JSON.stringify({ name: '@pix3/runtime', version }),
});

let project: TestProject | null = null;
const start = async (...args: Parameters<typeof startProject>): Promise<TestProject> => {
  project = await startProject(...args);
  return project;
};

afterEach(async () => {
  await project?.close();
  project = null;
});

describe('editor page and discovery', () => {
  it('serves raw HTML whose only module is the editor host, with no Vite client', async () => {
    const p = await start(runtimeAt('2.0.0-alpha.0'));
    const redirect = await p.fetch('/__pix3', { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/__pix3/');

    const page = await p.fetch('/__pix3/');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('src="/@id/__x00__virtual:pix3/editor-host"');
    expect(html).not.toContain('@vite/client');
    // The contract-B probe runs before any module (plan §B.2).
    expect(html.indexOf('__PIX3_VITE_CLIENT__')).toBeGreaterThan(-1);
    expect(html.indexOf('__PIX3_VITE_CLIENT__')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('generates the host module importing both script roots and the page client by /@fs/', async () => {
    const p = await start();
    const code = await (await p.fetch('/@id/__x00__virtual:pix3/editor-host')).text();
    expect(code).toContain('virtual:pix3/editor-scripts');
    expect(code).toContain('virtual:pix3/bot-policies');
    expect(code).toMatch(/\/@fs\/.*client\/index\.ts/);
    expect(code).not.toMatch(/import[^;\n]*@vite\/client/);
  });

  it('shows the version gate instead of the editor when the project has no runtime', async () => {
    const p = await start();
    const page = await p.fetch('/__pix3/');
    expect(page.status).toBe(409);
    expect(await page.text()).toContain('npm i @pix3/runtime');
  });

  it('writes .pix3/dev.json while listening and removes it on close', async () => {
    const p = await start();
    const devJson = join(p.root, '.pix3', 'dev.json');
    const info = JSON.parse(readFileSync(devJson, 'utf8')) as Record<string, unknown>;
    expect(info.port).toBe(p.port);
    expect(info.editorUrl).toBe(`http://localhost:${p.port}/__pix3/`);
    expect(info.pid).toBe(process.pid);
    await p.close();
    project = null;
    expect(existsSync(devJson)).toBe(false);
  });

  it('records the address a tab reached the server at as publicUrl (a port forward that is not 1:1)', async () => {
    const p = await start();
    const devJson = join(p.root, '.pix3', 'dev.json');
    const read = () => JSON.parse(readFileSync(devJson, 'utf8')) as Record<string, unknown>;
    const open = async (origin: string): Promise<WebSocket> => {
      const host = new URL(origin).host;
      const socket = new WebSocket(`ws://127.0.0.1:${p.port}/__pix3/ws`, {
        headers: { Host: host, Origin: origin },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('message', () => resolve());
        socket.once('error', reject);
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'hello', tabId: `tab-${host.replace(':', '-')}` }))
        );
      });
      return socket;
    };
    // A tab on the server's own address says nothing new.
    const local = await open(`http://localhost:${p.port}`);
    expect(read().publicUrl).toBeUndefined();
    // VS Code forwarded the port to another local one: the page's Origin is that address.
    const forwarded = await open('http://localhost:15999');
    await sleep(50);
    expect(read().publicUrl).toBe('http://localhost:15999/');
    expect(read().publicEditorUrl).toBe('http://localhost:15999/__pix3/');
    expect(read().editorUrl).toBe(`http://localhost:${p.port}/__pix3/`);
    local.close();
    forwarded.close();
  });

  it('the dev scene manifest finds locales/*.json without a localization block, as the build does', async () => {
    const table = (locale: string) => JSON.stringify({ $meta: { locale }, strings: {} });
    const p = await start({
      'scenes/main.pix3scene': SCENE,
      'locales/de.json': table('de'),
      'locales/en.json': table('en'),
    });
    const code = await (await p.fetch('/@id/__x00__virtual:pix3/scene-manifest')).text();
    const localization = /export const runtimeLocalization = ([\s\S]*?);\n/.exec(code)?.[1];
    expect(JSON.parse(localization ?? 'null')).toEqual({
      defaultLocale: 'en',
      locales: ['de', 'en'],
    });
  });

  it('the dev scene manifest carries the autoloads and follows pix3project.yaml', async () => {
    const p = await start({
      'scenes/main.pix3scene': SCENE,
      'pix3project.yaml':
        'autoloads:\n  - singleton: Counter\n    scriptPath: scripts/Counter.ts\n  - singleton: Off\n    scriptPath: scripts/Off.ts\n    enabled: false\n  - scriptPath: scripts/NoName.ts\n',
    });
    const autoloads = async (): Promise<unknown> => {
      const code = await (await p.fetch('/@id/__x00__virtual:pix3/scene-manifest')).text();
      return JSON.parse(/export const runtimeAutoloads = ([\s\S]*?);\n/.exec(code)?.[1] ?? 'null');
    };
    expect(await autoloads()).toEqual([
      { singleton: 'Counter', scriptPath: 'scripts/Counter.ts', enabled: true },
      { singleton: 'Off', scriptPath: 'scripts/Off.ts', enabled: false },
    ]);
  });

  it('answers hello with the revision, seq and versions', async () => {
    const p = await start({ 'scenes/main.pix3scene': SCENE });
    const hello = await json(await p.fetch('/__pix3/api/hello'));
    expect(hello.seq).toBe(0);
    expect(typeof hello.revision).toBe('string');
    expect((hello.versions as Record<string, unknown>).plugin).toBe('2.0.0-alpha.0');
    expect(hello.writerId).toBeNull();
  });
});

describe('write protection', () => {
  it('refuses a mutation without X-Pix3', async () => {
    const p = await start();
    const response = await p.fetch('/__pix3/api/file?path=a.txt', { method: 'PUT', body: 'x' });
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe('missing_x_pix3');
    expect(existsSync(join(p.root, 'a.txt'))).toBe(false);
  });

  it('refuses a mutation from another origin', async () => {
    const p = await start();
    const response = await p.mutate('/__pix3/api/file?path=a.txt', {
      method: 'PUT',
      body: 'x',
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe('forbidden_origin');
  });

  it('refuses a foreign Host (DNS rebinding)', async () => {
    const p = await start();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: p.port,
          path: '/__pix3/api/hello',
          headers: { Host: 'evil.example' },
        },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('refuses the event socket to a page of another origin', async () => {
    const p = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${p.port}/__pix3/ws`, {
      headers: { Origin: 'http://evil.example' },
    });
    const outcome = await new Promise<string>(resolve => {
      socket.once('open', () => resolve('open'));
      socket.once('error', () => resolve('refused'));
      socket.once('unexpected-response', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  });
});

describe('file API', () => {
  it('creates, reads with an ETag, and refuses a stale If-Match with 412', async () => {
    const p = await start();
    const created = await p.mutate('/__pix3/api/file?path=scenes/a.pix3scene', {
      method: 'PUT',
      body: SCENE,
      headers: { 'If-None-Match': '*' },
    });
    expect(created.status).toBe(200);
    expect((await json(created)).sha256).toBe(sha(SCENE));

    const read = await p.fetch('/__pix3/api/file?path=scenes/a.pix3scene');
    expect(read.headers.get('etag')).toBe(`"${sha(SCENE)}"`);
    expect(await read.text()).toBe(SCENE);

    const again = await p.mutate('/__pix3/api/file?path=scenes/a.pix3scene', {
      method: 'PUT',
      body: 'other',
      headers: { 'If-None-Match': '*' },
    });
    expect(again.status).toBe(412);
    expect((await json(again)).error).toBe('exists');

    const stale = await p.mutate('/__pix3/api/file?path=scenes/a.pix3scene', {
      method: 'PUT',
      body: 'overwrite',
      headers: { 'If-Match': `"${sha('something else')}"` },
    });
    expect(stale.status).toBe(412);
    const body = await json(stale);
    expect(body.error).toBe('base_mismatch');
    expect(body.currentHash).toBe(sha(SCENE));
    expect(readFileSync(join(p.root, 'scenes/a.pix3scene'), 'utf8')).toBe(SCENE);
  });

  it('refuses paths outside the root and the plugin-private part of .pix3', async () => {
    const p = await start();
    expect((await p.fetch('/__pix3/api/file?path=../etc/passwd')).status).toBe(400);
    expect((await p.fetch('/__pix3/api/file?path=/etc/passwd')).status).toBe(400);
    const reserved = await p.fetch('/__pix3/api/file?path=.pix3/dev.json');
    expect(reserved.status).toBe(403);
    expect((await json(reserved)).error).toBe('reserved_path');
  });

  it('replays a retried mutation id instead of running it twice', async () => {
    const p = await start({ 'a.txt': 'a' });
    const move = () =>
      p.mutate('/__pix3/api/move', {
        method: 'POST',
        body: JSON.stringify({ from: 'a.txt', to: 'b.txt' }),
        headers: { 'X-Mutation-Id': 'm-1' },
      });
    const first = await move();
    expect(first.status).toBe(200);
    const second = await move();
    expect(second.status).toBe(200);
    expect(second.headers.get('x-mutation-replayed')).toBe('true');
    expect(existsSync(join(p.root, 'b.txt'))).toBe(true);
  });

  it('lists every file of the revision set with its hash, minus node_modules and .pix3', async () => {
    const p = await start({
      'scenes/a.pix3scene': SCENE,
      'node_modules/x/index.js': 'x',
      'dist/out.js': 'x',
    });
    const manifest = await json(await p.fetch('/__pix3/api/manifest'));
    const paths = (manifest.files as { path: string }[]).map(file => file.path);
    expect(paths).toContain('scenes/a.pix3scene');
    expect(paths).toContain('index.html');
    expect(paths.some(path => path.startsWith('node_modules'))).toBe(false);
    expect(paths.some(path => path.startsWith('dist'))).toBe(false);
    expect(paths.some(path => path.startsWith('.pix3'))).toBe(false);
  });
});

describe('events and the writer', () => {
  it('tells tabs about own writes as editor and about outside writes as external', async () => {
    const p = await start();
    const tab = await p.connectTab('tab-a');
    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-a' }),
    });
    await p.mutate('/__pix3/api/file?path=scenes/a.pix3scene', {
      method: 'PUT',
      body: SCENE,
      writer: 'tab-a',
    });
    const own = await tab.waitFor(
      frame =>
        frame.type === 'pix3:fs' &&
        (frame.events as { path: string }[]).some(e => e.path === 'scenes/a.pix3scene')
    );
    expect(own.writerId).toBe('tab-a');
    expect(
      (own.events as { path: string; author: string }[]).find(e => e.path === 'scenes/a.pix3scene')
        ?.author
    ).toBe('editor');

    writeFileSync(join(p.root, 'scenes/a.pix3scene'), `${SCENE}# agent\n`);
    const outside = await tab.waitFor(
      frame =>
        frame.type === 'pix3:fs' &&
        (frame.events as { sha256?: string }[]).some(e => e.sha256 === sha(`${SCENE}# agent\n`))
    );
    expect((outside.events as { author: string }[])[0].author).toBe('external');
  });

  it('takes writes only from the current writer, and hands over under the write mutex', async () => {
    const p = await start({ 'a.txt': 'a' });
    const a = await p.connectTab('tab-a');
    await p.connectTab('tab-b');
    const claimA = await json(
      await p.mutate('/__pix3/api/handover/claim', {
        method: 'POST',
        body: JSON.stringify({ writerId: 'tab-a' }),
      })
    );
    expect(claimA.writerId).toBe('tab-a');
    expect((claimA.hashes as Record<string, string>)['a.txt']).toBe(sha('a'));

    const fromB = await p.mutate('/__pix3/api/file?path=a.txt', {
      method: 'PUT',
      body: 'b',
      writer: 'tab-b',
    });
    expect(fromB.status).toBe(409);
    expect((await json(fromB)).error).toBe('writer_superseded');

    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-b' }),
    });
    await a.waitFor(frame => frame.type === 'pix3:writer' && frame.writerId === 'tab-b');
    const fromA = await p.mutate('/__pix3/api/file?path=a.txt', {
      method: 'PUT',
      body: 'a2',
      writer: 'tab-a',
    });
    expect(fromA.status).toBe(409);
    expect(readFileSync(join(p.root, 'a.txt'), 'utf8')).toBe('a');
  });
});

describe('sync barrier', () => {
  const sync = async (p: TestProject, body: Record<string, unknown> = {}) =>
    json(
      await p.mutate('/__pix3/api/sync', {
        method: 'POST',
        body: JSON.stringify({ timeoutMs: 3_000, ...body }),
      })
    );

  it('without an editor tab: rescans and reports what changed', async () => {
    const p = await start({ 'scenes/a.pix3scene': SCENE });
    writeFileSync(join(p.root, 'scenes/a.pix3scene'), `${SCENE}# v2\n`);
    const result = await sync(p);
    expect(result.ok).toBe(true);
    expect(result.editor).toBe(false);
    expect((result.changed as Record<string, string>)['scenes/a.pix3scene']).toBe(
      sha(`${SCENE}# v2\n`)
    );
  });

  it('reports expect mismatches as not ok, with the disk hash', async () => {
    const p = await start({ 'scenes/a.pix3scene': SCENE });
    const result = await sync(p, { expect: { 'scenes/a.pix3scene': sha('agent thought so') } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expect_mismatch');
    expect(result.expectMismatch).toEqual([
      { path: 'scenes/a.pix3scene', expected: sha('agent thought so'), actual: sha(SCENE) },
    ]);
  });

  it('stamps every project script with the sha of its bytes on disk', async () => {
    const source = 'export const foo = 1;\n';
    const p = await start({ 'scripts/Foo.ts': source });
    const code = await (await p.fetch('/scripts/Foo.ts')).text();
    expect(code).toContain(
      `(globalThis.__pix3Executed ??= {})["scripts/Foo.ts"] = "${sha(source)}"`
    );
  });

  it('is ok only when the tab executed the new bytes of every changed editor module', async () => {
    const p = await start({
      'scripts/Foo.ts': "import { helper } from '../lib/helper.ts';\nexport const foo = helper;\n",
      'lib/helper.ts': 'export const helper = 1;\n',
    });
    // Load the roots and the chain into the client graph, as the editor page would.
    await p.fetch('/@id/__x00__virtual:pix3/editor-scripts');
    await p.fetch('/scripts/Foo.ts');
    await p.fetch('/lib/helper.ts');
    const tab = await p.connectTab('tab-a');
    let executed: Record<string, string> = {};
    tab.onRequest('sync', request => ({ ok: true, rev: request.rev, executed }));

    const helperV2 = 'export const helper = 2;\n';
    writeFileSync(join(p.root, 'lib/helper.ts'), helperV2);
    const stale = await sync(p, { tabId: 'tab-a' });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe('stale_modules');
    expect(stale.paths).toEqual(['lib/helper.ts']);

    executed = { 'lib/helper.ts': sha(helperV2) };
    writeFileSync(join(p.root, 'lib/helper.ts'), 'export const helper = 3;\n');
    const stillStale = await sync(p, { tabId: 'tab-a' });
    expect(stillStale.paths).toEqual(['lib/helper.ts']);

    executed = { 'lib/helper.ts': sha('export const helper = 3;\n') };
    const ok = await sync(p, { tabId: 'tab-a' });
    expect(ok.ok).toBe(true);
    expect(ok.tabId).toBe('tab-a');
  });

  it('does not accept an answer from an older revision', async () => {
    const p = await start({ 'scenes/a.pix3scene': SCENE });
    const tab = await p.connectTab('tab-a');
    tab.onRequest('sync', request => ({ ok: true, rev: Number(request.rev) - 1, executed: {} }));
    writeFileSync(join(p.root, 'scenes/a.pix3scene'), `${SCENE}# v2\n`);
    const result = await sync(p, { tabId: 'tab-a' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_modules');
  });

  it('passes the page’s play refusal through with whose session it is', async () => {
    const p = await start({ 'scenes/a.pix3scene': SCENE });
    const tab = await p.connectTab('tab-a');
    tab.onRequest('sync', () => ({
      ok: false,
      reason: 'stale',
      playing: 'designer',
      pending: ['scenes/a.pix3scene'],
      executed: { 'scripts/Foo.ts': sha('x') },
    }));
    const result = await sync(p, { tabId: 'tab-a' });
    expect(result).toMatchObject({ ok: false, reason: 'stale', playing: 'designer' });
    expect(result.executed).toBeUndefined(); // the stamps are the judge's, not the agent's
  });

  it('flushes through the writer tab when the caller is not a tab', async () => {
    const p = await start();
    const tab = await p.connectTab('tab-a');
    let flushes = 0;
    tab.onRequest('flush', () => {
      flushes += 1;
      return { ok: true, written: [] };
    });
    tab.onRequest('sync', request => ({ ok: true, rev: request.rev, executed: {} }));
    const noWriter = await json(await p.mutate('/__pix3/api/flush', { method: 'POST' }));
    expect(noWriter).toMatchObject({ ok: true, flushed: false });

    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-a' }),
    });
    expect(await json(await p.mutate('/__pix3/api/flush', { method: 'POST' }))).toMatchObject({
      ok: true,
      flushed: true,
    });
    expect((await sync(p)).ok).toBe(true);
    expect(flushes).toBe(2);
  });

  it('reports a gesture that outlasts the flush as not ok', async () => {
    const p = await start();
    const tab = await p.connectTab('tab-a');
    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-a' }),
    });
    tab.onRequest('flush', () => ({ ok: false, reason: 'gesture_in_progress' }));
    const result = await sync(p);
    expect(result).toMatchObject({ ok: false, reason: 'gesture_in_progress', step: 'flush' });
  });

  it('takes a bot policy added, its helper changed and a policy deleted (plan §B.2)', async () => {
    const BOTS = '/@id/__x00__virtual:pix3/bot-policies';
    const p = await start({
      'design/tests/bots/dodge.ts':
        "import { aim } from '../lib/aim.ts';\nexport default { name: 'dodge', tick: () => aim };\n",
      'design/tests/lib/aim.ts': 'export const aim = 1;\n',
      'design/tests/bots/pix3-test-bot.d.ts': 'declare const x: number;\n',
    });
    const root = await (await p.fetch(BOTS)).text();
    expect(root).toContain('export const __pix3Revision');
    expect(root).toContain('/design/tests/bots/dodge.ts');
    expect(root).not.toContain('pix3-test-bot.d.ts');
    await p.fetch('/design/tests/bots/dodge.ts');
    await p.fetch('/design/tests/lib/aim.ts');
    const tab = await p.connectTab('tab-a');
    let executed: Record<string, string> = {};
    tab.onRequest('sync', request => ({ ok: true, rev: request.rev, executed }));

    // A new policy: the barrier wants its executed stamp, and the root globs it.
    const rush = "export default { name: 'rush', tick: () => 2 };\n";
    writeFileSync(join(p.root, 'design/tests/bots/rush.ts'), rush);
    const added = await sync(p, { tabId: 'tab-a' });
    expect(added).toMatchObject({ ok: false, reason: 'stale_modules' });
    expect(added.paths).toEqual(['design/tests/bots/rush.ts']);
    executed = { 'design/tests/bots/rush.ts': sha(rush) };
    expect((await sync(p, { tabId: 'tab-a' })).ok).toBe(true);
    const withRush = await (await p.fetch(BOTS)).text();
    expect(withRush).toContain('/design/tests/bots/rush.ts');
    expect(withRush).toMatch(/__pix3Revision = [1-9]/);
    const rushCode = await (await p.fetch('/design/tests/bots/rush.ts')).text();
    expect(rushCode).toContain(
      `(globalThis.__pix3Executed ??= {})["design/tests/bots/rush.ts"] = "${sha(rush)}"`
    );

    // A helper only a policy imports is part of the chain the editor runs.
    const aim2 = 'export const aim = 2;\n';
    writeFileSync(join(p.root, 'design/tests/lib/aim.ts'), aim2);
    const helper = await sync(p, { tabId: 'tab-a' });
    expect(helper.paths).toEqual(['design/tests/lib/aim.ts']);
    executed = { ...executed, 'design/tests/lib/aim.ts': sha(aim2) };
    expect((await sync(p, { tabId: 'tab-a' })).ok).toBe(true);

    // Deleted: reported as null, nothing to stamp, and the root no longer globs it.
    rmSync(join(p.root, 'design/tests/bots/rush.ts'));
    const deleted = await sync(p, { tabId: 'tab-a' });
    expect(deleted.ok).toBe(true);
    expect((deleted.changed as Record<string, unknown>)['design/tests/bots/rush.ts']).toBeNull();
    expect(await (await p.fetch(BOTS)).text()).not.toContain('rush.ts');
  });

  it('passes the page’s contract-B alarm through (/@vite/client on the editor page)', async () => {
    const p = await start();
    const tab = await p.connectTab('tab-a');
    tab.onRequest('sync', request => ({
      ok: true,
      rev: request.rev,
      executed: {},
      viteClient: true,
    }));
    const result = await sync(p, { tabId: 'tab-a' });
    expect(result).toMatchObject({ ok: true, viteClient: true });
    expect(String(result.warning)).toContain('pix3 check');
  });

  it('tells the editor to re-import its scripts when one changes outside a sync', async () => {
    const p = await start({ 'scripts/Foo.ts': 'export const foo = 1;\n' });
    await p.fetch('/@id/__x00__virtual:pix3/editor-scripts');
    await p.fetch('/scripts/Foo.ts');
    const tab = await p.connectTab('tab-a');
    await sleep(100);
    writeFileSync(join(p.root, 'scripts/Foo.ts'), 'export const foo = 2;\n');
    const frame = await tab.waitFor(f => f.type === 'pix3:scripts', 5_000);
    expect(frame.path).toBe('scripts/Foo.ts');
  });
});

describe('the script graph', () => {
  it('takes project sources, not an in-project cacheDir, node_modules or other files', () => {
    const graph = new ScriptGraph('/p', () => null, ['/p/.vite-cache/']);
    expect(graph.wirePathOf('/p/scripts/A.ts?t=1')).toBe('scripts/A.ts');
    expect(graph.wirePathOf('/p/src/game/x.js')).toBe('src/game/x.js');
    expect(graph.wirePathOf('/p/.vite-cache/deps/three.js')).toBeNull();
    expect(graph.wirePathOf('/p/node_modules/x/index.js')).toBeNull();
    expect(graph.wirePathOf('/p/scenes/a.pix3scene')).toBeNull();
    expect(graph.wirePathOf('/elsewhere/a.ts')).toBeNull();
  });
});
