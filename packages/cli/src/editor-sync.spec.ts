// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncEditor } from './editor-sync.ts';

/** `pix3 check` / `smoke` tell a gone dev server from a busy one (the plugin's rule, P13). */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const projectPointingAt = (port: number): string => {
  const root = mkdtempSync(join(tmpdir(), 'pix3-sync-'));
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

describe('syncEditor', () => {
  it('a server that accepts but does not answer hello is unsynced, not gone', async () => {
    const port = await listen(createServer(() => {}));
    const result = await syncEditor(projectPointingAt(port), { probeTimeoutMs: 200 });
    expect(result.status).toBe('unsynced');
    expect(result.status === 'unsynced' && result.reason).toContain('did not answer within 0.2 s');
  });

  it('a refused connection is a stale dev.json: no-server', async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await syncEditor(projectPointingAt(port))).toEqual({ status: 'no-server' });
  });
});
