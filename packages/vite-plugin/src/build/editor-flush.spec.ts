// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EditorUnsyncedError,
  describeEditorFlush,
  flushEditorBeforeBuild,
} from './editor-flush.ts';

/** The flush before a build tells a gone server from a busy one (`.pix3/dev.json` exists). */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const projectPointingAt = (port: number): string => {
  const root = mkdtempSync(join(tmpdir(), 'pix3-flush-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pix3'));
  writeFileSync(
    join(root, '.pix3', 'dev.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}/`, port, pid: 0 })
  );
  return root;
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
};

describe('flushEditorBeforeBuild', () => {
  it('a refused connection is a stale dev.json: no-server, with the url and why', async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    const result = await flushEditorBeforeBuild(projectPointingAt(port), { skip: false });
    expect(result).toEqual({
      status: 'no-server',
      url: `http://127.0.0.1:${port}/`,
      reason: 'ECONNREFUSED',
    });
  });

  it('a server that accepts but does not answer hello is busy: E_EDITOR_UNSYNCED', async () => {
    // Never responds (a dev server stuck in a long transform, say).
    const port = await listen(createServer(() => {}));
    const root = projectPointingAt(port);
    const pending = flushEditorBeforeBuild(root, { skip: false, probeTimeoutMs: 200 });
    await expect(pending).rejects.toBeInstanceOf(EditorUnsyncedError);
    await expect(
      flushEditorBeforeBuild(root, { skip: false, probeTimeoutMs: 200 })
    ).rejects.toThrow(/did not answer within 0\.2 s[\s\S]*PIX3_NO_SYNC=1/);
    // PIX3_NO_SYNC (the default of `skip`) still skips it.
    process.env.PIX3_NO_SYNC = '1';
    cleanup.push(() => delete process.env.PIX3_NO_SYNC);
    expect(await flushEditorBeforeBuild(root, { probeTimeoutMs: 200 })).toEqual({
      status: 'skipped',
    });
  });

  it('no dev.json: no-server without a url (nothing to log)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pix3-flush-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    expect(await flushEditorBeforeBuild(root, { skip: false })).toEqual({ status: 'no-server' });
  });
});

describe('flushEditorBeforeBuild: what the flush wrote', () => {
  const editorAnswering = async (reply: Record<string, unknown>): Promise<string> => {
    const port = await listen(
      createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url?.endsWith('/flush') ? reply : { ok: true }));
      })
    );
    return projectPointingAt(port);
  };

  it('an editor with nothing unsaved logs nothing (core-tests/game7)', async () => {
    const root = await editorAnswering({ ok: true, editor: true, flushed: true, saved: [] });
    const result = await flushEditorBeforeBuild(root, { skip: false });
    expect(result).toMatchObject({ status: 'flushed', saved: [] });
    expect(describeEditorFlush(result)).toBeNull();
  });

  it('an editor that wrote scenes is logged with the count and the paths', async () => {
    const root = await editorAnswering({
      ok: true,
      editor: true,
      flushed: true,
      saved: ['scenes/a.pix3scene', 'scenes/b.pix3scene'],
    });
    expect(describeEditorFlush(await flushEditorBeforeBuild(root, { skip: false }))).toMatch(
      /wrote 2 unsaved scene\(s\) to disk first: scenes\/a\.pix3scene, scenes\/b\.pix3scene$/
    );
  });
});
