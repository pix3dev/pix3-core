// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startProject, type TestProject } from '../test-support/harness.ts';
import { CHECKOUT_NODE_MODULES, FIXTURE_FILES } from '../test-support/build-fixture.ts';

/**
 * `POST /__pix3/api/build` (plan §B.6 «Из UI»): the dev server flushes the writer tab, spawns the
 * project's own `vite build` (`process.execPath node_modules/vite/bin/vite.js build`), streams
 * `pix3:build` frames and answers with `.pix3/build.json`. The child loads `vite.config.mjs`,
 * which imports this plugin from source.
 */

const PLUGIN_SOURCE = resolve(import.meta.dirname, '../index.ts');
const BUILD_TIMEOUT_MS = 180_000;

let project: TestProject | null = null;
afterEach(async () => {
  await project?.close();
  project = null;
});

const fixtureText = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(FIXTURE_FILES)
      .filter(([, content]) => typeof content === 'string')
      .map(([path, content]) => [path, content as string])
  );

const startFixture = async (options = ''): Promise<TestProject> => {
  project = await startProject({
    ...fixtureText(),
    'vite.config.mjs': `import { pix3 } from ${JSON.stringify(PLUGIN_SOURCE)};\nexport default { plugins: [pix3(${options})], logLevel: 'warn' };\n`,
  });
  // The binary asset and this checkout's node_modules (vite, @pix3/runtime, three).
  const png = FIXTURE_FILES['sprites/dot.png'] as Buffer;
  mkdirSync(dirname(join(project.root, 'sprites', 'dot.png')), { recursive: true });
  writeFileSync(join(project.root, 'sprites', 'dot.png'), png);
  symlinkSync(CHECKOUT_NODE_MODULES, join(project.root, 'node_modules'), 'dir');
  return project;
};

const postBuild = (p: TestProject, body: Record<string, unknown> = {}): Promise<Response> =>
  p.mutate('/__pix3/api/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /__pix3/api/build', () => {
  it(
    'flushes the writer tab, runs vite build in a child, streams progress and answers with the artifact',
    async () => {
      const p = await startFixture();
      const tab = await p.connectTab('tab-a');
      await p.mutate('/__pix3/api/handover/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writerId: 'tab-a' }),
      });
      let flushes = 0;
      tab.onRequest('flush', () => {
        flushes++;
        return { ok: true };
      });

      const response = await postBuild(p, { format: 'html' });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.format).toBe('html');
      expect(body.path).toBe(join(p.root, 'dist', 'index.html'));
      expect(existsSync(body.path as string)).toBe(true);
      expect(body.bytes).toBe(readFileSync(body.path as string).byteLength);
      expect(typeof body.sha256).toBe('string');
      expect(flushes).toBe(1);

      const phases = tab.frames
        .filter(frame => frame.type === 'pix3:build')
        .map(frame => frame.phase);
      expect(phases[0]).toBe('flush');
      expect(phases[1]).toBe('start');
      expect(phases.at(-1)).toBe('done');
      const done = tab.frames.find(f => f.type === 'pix3:build' && f.phase === 'done');
      expect((done?.record as Record<string, unknown>)?.path).toBe(body.path);
      // The child was the same plugin in build mode: a classic single-file page.
      const page = readFileSync(body.path as string, 'utf8');
      expect(page).not.toContain('type="module"');
      expect(page).toContain('Slider2D was stripped from this build');
      rmSync(join(p.root, 'dist'), { recursive: true, force: true });
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'refuses a second build while one runs, and refuses when the writer tab cannot flush',
    async () => {
      const p = await startFixture();
      const tab = await p.connectTab('tab-a');
      await p.mutate('/__pix3/api/handover/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writerId: 'tab-a' }),
      });
      tab.onRequest('flush', () => ({ ok: false, reason: 'gesture_in_progress' }));
      const refused = await postBuild(p, { format: 'zip' });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe('E_EDITOR_UNSYNCED');
      expect(existsSync(join(p.root, '.pix3', 'build.json'))).toBe(false);

      tab.onRequest('flush', () => ({ ok: true }));
      const first = postBuild(p, { format: 'zip' });
      await tab.waitFor(frame => frame.type === 'pix3:build' && frame.phase === 'start', 20_000);
      const second = await postBuild(p, {});
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe('build_in_progress');
      const firstBody = (await (await first).json()) as Record<string, unknown>;
      expect(firstBody.format).toBe('zip');
      expect(String(firstBody.path)).toMatch(/Fixture Game\.zip$/);
      expect(existsSync(firstBody.path as string)).toBe(true);
    },
    BUILD_TIMEOUT_MS
  );

  it('answers 400 with a bad format, and when the dev server runs with build: false', async () => {
    const p = await startFixture();
    const bad = await postBuild(p, { format: 'exe' });
    expect(bad.status).toBe(400);
    await p.close();

    project = await startProject({ 'index.html': '<!doctype html>' }, { build: false });
    const refused = await postBuild(project, {});
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('build_disabled');
  });
});
