// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sleep, startProject, type TestProject } from '../test-support/harness.ts';
import {
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_VERSIONS,
  VersionJournal,
  type HistoryEntry,
} from './history.ts';
import { ProjectFiles } from './project-files.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const V1 = 'root:\n  - id: a\n    type: Group2D\n';
const V2 = 'root:\n  - id: a\n    type: Group2D\n    name: two\n';
const V3 = 'root:\n  - id: a\n    type: Group2D\n    name: three\n';
const SCENE = 'scenes/a.pix3scene';

describe('version journal routes (dev server)', () => {
  let project: TestProject | null = null;
  afterEach(async () => {
    await project?.close();
    project = null;
  });

  const list = async (p: TestProject, path = SCENE): Promise<HistoryEntry[]> =>
    (await json(await p.fetch(`/__pix3/api/history?path=${encodeURIComponent(path)}`)))
      .entries as HistoryEntry[];
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 50; i++) {
      const value = await read();
      if (done(value)) return value;
      await sleep(50);
    }
    return read();
  };

  it('snapshots journaled files at start as external', async () => {
    const p = (project = await startProject({ [SCENE]: V1, 'notes.txt': 'x' }));
    const entries = await list(p);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: SCENE, author: 'external', sha256: sha(V1) });
    expect(await list(p, 'notes.txt')).toEqual([]);
  });

  it('journals PUTs as editor and watcher changes as external, and serves each version', async () => {
    const p = (project = await startProject({ [SCENE]: V1 }));
    const put = await p.mutate(`/__pix3/api/file?path=${SCENE}`, { method: 'PUT', body: V2 });
    expect(put.status).toBe(200);
    writeFileSync(join(p.root, SCENE), V3);
    const entries = await until(
      () => list(p),
      value => value.length === 3
    );
    expect(entries.map(e => [e.author, e.sha256])).toEqual([
      ['external', sha(V3)],
      ['editor', sha(V2)],
      ['external', sha(V1)],
    ]);
    const version = await p.fetch(
      `/__pix3/api/history/version?path=${SCENE}&id=${encodeURIComponent(entries[1].id)}`
    );
    expect(version.status).toBe(200);
    expect(await version.text()).toBe(V2);
    expect(entries[1].id).toMatch(/^\d{13}-[0-9a-f]{8}$/);
    expect(entries[1].id.endsWith(sha(V2).slice(0, 8))).toBe(true);
    expect(
      readFileSync(join(p.root, '.pix3', 'history', 'scenes', 'a.pix3scene', entries[1].id), 'utf8')
    ).toBe(V2);

    const unknown = await p.fetch(
      `/__pix3/api/history/version?path=${SCENE}&id=0000000000000-deadbeef`
    );
    expect(unknown.status).toBe(404);
    // The journal is plugin-private: not reachable through the file API.
    expect(
      (await p.fetch('/__pix3/api/file?path=.pix3/history/scenes/a.pix3scene/index.jsonl')).status
    ).toBe(403);
  });

  it('records a rejected draft from any tab, even a superseded one', async () => {
    const p = (project = await startProject({ [SCENE]: V1 }));
    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-b' }),
    });
    const recorded = await p.mutate('/__pix3/api/history/record', {
      method: 'POST',
      writer: 'tab-a',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: SCENE, text: V2, author: 'rejected-draft', note: 'merge lost' }),
    });
    expect(recorded.status).toBe(200);
    const entry = (await json(recorded)) as unknown as HistoryEntry;
    expect(entry).toMatchObject({
      path: SCENE,
      author: 'rejected-draft',
      sha256: sha(V2),
      size: Buffer.byteLength(V2),
      note: 'merge lost',
    });
    expect((await list(p))[0].id).toBe(entry.id);
    expect(readFileSync(join(p.root, SCENE), 'utf8')).toBe(V1);

    const wrongAuthor = await p.mutate('/__pix3/api/history/record', {
      method: 'POST',
      body: JSON.stringify({ path: SCENE, text: V2, author: 'editor' }),
    });
    expect(wrongAuthor.status).toBe(400);
  });

  it('restores a version under the writer check, as an external change', async () => {
    const p = (project = await startProject({ [SCENE]: V1 }));
    const tab = await p.connectTab('tab-a');
    await p.mutate('/__pix3/api/handover/claim', {
      method: 'POST',
      body: JSON.stringify({ writerId: 'tab-a' }),
    });
    await p.mutate(`/__pix3/api/file?path=${SCENE}`, { method: 'PUT', body: V2, writer: 'tab-a' });
    const [, original] = await list(p);
    expect(original.sha256).toBe(sha(V1));

    const restore = (writer: string, headers: Record<string, string> = {}) =>
      p.mutate('/__pix3/api/history/restore', {
        method: 'POST',
        writer,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ path: SCENE, id: original.id }),
      });

    const notWriter = await restore('tab-b');
    expect(notWriter.status).toBe(409);
    expect((await json(notWriter)).error).toBe('writer_superseded');

    const stale = await restore('tab-a', { 'If-Match': `"${sha(V1)}"` });
    expect(stale.status).toBe(412);
    expect(await json(stale)).toMatchObject({ error: 'base_mismatch', currentHash: sha(V2) });

    const restored = await restore('tab-a', { 'If-Match': `"${sha(V2)}"` });
    expect(restored.status).toBe(200);
    const body = await json(restored);
    expect(body).toMatchObject({ path: SCENE, sha256: sha(V1), size: Buffer.byteLength(V1) });
    expect(readFileSync(join(p.root, SCENE), 'utf8')).toBe(V1);

    const frame = await tab.waitFor(f => f.type === 'pix3:fs' && f.seq === body.seq);
    expect(frame.writerId).toBeUndefined();
    expect(frame.events).toEqual([
      { op: 'modify', path: SCENE, kind: 'file', sha256: sha(V1), author: 'external' },
    ]);
    expect((await list(p)).map(e => [e.author, e.sha256])).toEqual([
      ['restore', sha(V1)],
      ['editor', sha(V2)],
      ['external', sha(V1)],
    ]);

    // A full rescan and the watcher's echo find nothing new about the restored file.
    await p.fetch('/__pix3/api/manifest');
    await sleep(700);
    const later = tab.frames.filter(
      f =>
        f.type === 'pix3:fs' &&
        (f.seq as number) > (body.seq as number) &&
        (f.events as { path: string }[]).some(e => e.path === SCENE)
    );
    expect(later).toEqual([]);
  });
});

describe('start-up snapshot across restarts (ProjectFiles)', () => {
  it('records a file changed while no dev server ran, and nothing for an unchanged one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-history-')));
    try {
      mkdirSync(join(root, 'scenes'));
      writeFileSync(join(root, SCENE), V1);
      const first = new ProjectFiles({ root });
      await first.start();
      await first.close();
      writeFileSync(join(root, SCENE), V2);
      const second = new ProjectFiles({ root });
      await second.start();
      await second.close();
      const third = new ProjectFiles({ root });
      await third.start();
      await third.close();
      expect((await third.history.list(SCENE)).map(e => [e.author, e.sha256])).toEqual([
        ['external', sha(V2)],
        ['external', sha(V1)],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('VersionJournal retention', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const journalAt = (clock: { now: number }): { journal: VersionJournal; root: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-history-')));
    roots.push(root);
    return { journal: new VersionJournal({ root, now: () => clock.now }), root };
  };

  it(`keeps the newest ${HISTORY_MAX_VERSIONS} versions of a path`, async () => {
    const clock = { now: 1_800_000_000_000 };
    const { journal, root } = journalAt(clock);
    const first = await journal.record(SCENE, Buffer.from('v0'), 'editor');
    for (let i = 1; i < HISTORY_MAX_VERSIONS + 5; i++) {
      clock.now += 1;
      await journal.record(SCENE, Buffer.from(`v${i}`), 'editor');
    }
    const entries = await journal.list(SCENE);
    expect(entries).toHaveLength(HISTORY_MAX_VERSIONS);
    expect(entries[0].sha256).toBe(sha(`v${HISTORY_MAX_VERSIONS + 4}`));
    expect(entries[entries.length - 1].sha256).toBe(sha('v5'));
    expect(await journal.read(SCENE, first.id)).toBeNull();
    const dir = join(root, '.pix3', 'history', 'scenes', 'a.pix3scene');
    expect(existsSync(join(dir, first.id))).toBe(false);
    expect(readdirSync(dir)).toHaveLength(HISTORY_MAX_VERSIONS + 1);
  });

  it('drops versions older than the age limit but never the newest one', async () => {
    const clock = { now: 1_800_000_000_000 };
    const { journal } = journalAt(clock);
    await journal.record(SCENE, Buffer.from('old-1'), 'external');
    await journal.record(SCENE, Buffer.from('old-2'), 'editor');
    clock.now += HISTORY_MAX_AGE_MS + 1;
    // Recording the same bytes again is skipped, so nothing is pruned yet either.
    await journal.record(SCENE, Buffer.from('old-2'), 'external');
    expect(await journal.list(SCENE)).toHaveLength(2);
    await journal.record(SCENE, Buffer.from('fresh'), 'editor');
    expect((await journal.list(SCENE)).map(e => e.sha256)).toEqual([sha('fresh')]);

    const other = 'prefabs/p.prefab';
    await journal.record(other, Buffer.from('only'), 'external');
    clock.now += HISTORY_MAX_AGE_MS * 3;
    await journal.record(other, Buffer.from('only'), 'external');
    expect(await journal.list(other)).toHaveLength(1);
  });
});
