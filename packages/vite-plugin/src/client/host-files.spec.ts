// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { HostFileError, HostFilesClient, type ApiCaller } from './host-files.ts';

/** A connection that records the request and answers with `reply`. */
const fakeCaller = (
  reply: Response
): ApiCaller & { calls: { route: string; init?: RequestInit }[] } => {
  const calls: { route: string; init?: RequestInit }[] = [];
  return {
    base: '/',
    calls,
    api: async (route, init) => {
      calls.push({ route, init });
      return reply;
    },
  };
};

describe('HostFilesClient.writeChangeset', () => {
  it('sends text as text and bytes as base64', async () => {
    const caller = fakeCaller(Response.json({ seq: 3, files: [] }));
    const result = await new HostFilesClient(caller).writeChangeset([
      { path: 'scenes/a.pix3scene', data: 'root: []\n', ifMatch: 'abc' },
      { path: 'a.bin', data: new Uint8Array([0, 255]), createOnly: true },
    ]);
    expect(result.seq).toBe(3);
    expect(caller.calls[0].route).toBe('changeset');
    expect(JSON.parse(String(caller.calls[0].init?.body))).toEqual({
      files: [
        { path: 'scenes/a.pix3scene', text: 'root: []\n', ifMatch: 'abc' },
        { path: 'a.bin', base64: 'AP8=', createOnly: true },
      ],
    });
  });

  it('rejects a stale file with base_mismatch naming it', async () => {
    const caller = fakeCaller(
      Response.json(
        { error: 'base_mismatch', message: 'changed', path: 'b.prefab', currentHash: 'def' },
        { status: 412 }
      )
    );
    const error = await new HostFilesClient(caller)
      .writeChangeset([{ path: 'b.prefab', data: 'x' }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostFileError);
    expect((error as HostFileError).failure).toEqual({
      code: 'base_mismatch',
      status: 412,
      message: 'changed',
      path: 'b.prefab',
      currentHash: 'def',
    });
  });

  it('maps a superseded writer to writer_superseded', async () => {
    const caller = fakeCaller(
      Response.json({ error: 'writer_superseded', message: 'read-only' }, { status: 409 })
    );
    const error = await new HostFilesClient(caller)
      .writeChangeset([{ path: 'a.pix3scene', data: 'x' }])
      .catch((e: unknown) => e);
    expect((error as HostFileError).failure.code).toBe('writer_superseded');
  });
});
