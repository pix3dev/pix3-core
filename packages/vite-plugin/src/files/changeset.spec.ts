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
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sleep, startProject, type TestProject } from '../test-support/harness.ts';
import { parseChangeset } from './changeset.ts';
import { ProjectFiles, type FsFrame, type ProjectFilesOptions } from './project-files.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const A_OLD = 'root:\n  - id: a\n    type: Group2D\n';
const A_NEW = 'root:\n  - id: a\n    type: Group2D\n    name: renamed\n';
const P_OLD = 'root:\n  - id: p\n    type: Sprite2D\n';
const P_NEW = 'root:\n  - id: p\n    type: Sprite2D\n    name: renamed\n';

describe('POST /__pix3/api/changeset (dev server)', () => {
  let project: TestProject | null = null;
  afterEach(async () => {
    await project?.close();
    project = null;
  });

  const claim = (p: TestProject, writerId: string) =>
    p.mutate('/__pix3/api/handover/claim', { method: 'POST', body: JSON.stringify({ writerId }) });
  const changeset = (p: TestProject, writer: string, files: unknown[], headers = {}) =>
    p.mutate('/__pix3/api/changeset', {
      method: 'POST',
      writer,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ files }),
    });
  const read = (p: TestProject, path: string): string | null => {
    const absolute = join(p.root, path);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  };

  it('writes two files as one transaction with one pix3:fs frame', async () => {
    const p = (project = await startProject({ 'scenes/a.pix3scene': A_OLD }));
    const tab = await p.connectTab('tab-a');
    await claim(p, 'tab-a');
    const response = await changeset(p, 'tab-a', [
      { path: 'scenes/a.pix3scene', text: A_NEW, ifMatch: sha(A_OLD) },
      { path: 'prefabs/p.prefab', text: P_NEW, createOnly: true },
    ]);
    expect(response.status).toBe(200);
    const body = await json(response);
    const seq = body.seq as number;
    expect(body.files).toEqual([
      { path: 'scenes/a.pix3scene', sha256: sha(A_NEW), size: Buffer.byteLength(A_NEW), seq },
      { path: 'prefabs/p.prefab', sha256: sha(P_NEW), size: Buffer.byteLength(P_NEW), seq },
    ]);
    expect(read(p, 'scenes/a.pix3scene')).toBe(A_NEW);
    expect(read(p, 'prefabs/p.prefab')).toBe(P_NEW);

    const frame = await tab.waitFor(f => f.type === 'pix3:fs' && f.seq === seq);
    expect(frame.writerId).toBe('tab-a');
    const events = frame.events as { op: string; path: string; author: string; sha256?: string }[];
    expect(events.filter(e => e.path.endsWith('.pix3scene') || e.path.endsWith('.prefab'))).toEqual(
      [
        {
          op: 'modify',
          path: 'scenes/a.pix3scene',
          kind: 'file',
          sha256: sha(A_NEW),
          author: 'editor',
        },
        {
          op: 'create',
          path: 'prefabs/p.prefab',
          kind: 'file',
          sha256: sha(P_NEW),
          author: 'editor',
        },
      ]
    );
    expect(events.every(e => e.author === 'editor')).toBe(true);

    // The watcher's echo of the renames finds nothing new: no second frame for these files.
    await sleep(700);
    const fsFrames = tab.frames.filter(
      f =>
        f.type === 'pix3:fs' &&
        (f.events as { path: string }[]).some(e => e.path === 'scenes/a.pix3scene')
    );
    expect(fsFrames).toHaveLength(1);
    expect(readdirSync(join(p.root, '.pix3', 'tx'))).toEqual([]);

    const history = await json(await p.fetch('/__pix3/api/history?path=scenes/a.pix3scene'));
    expect(
      (history.entries as { author: string; sha256: string }[]).map(e => [e.author, e.sha256])
    ).toEqual([
      ['editor', sha(A_NEW)],
      ['external', sha(A_OLD)],
    ]);
  });

  it('refuses the whole changeset when the second file is stale, writing nothing', async () => {
    const p = (project = await startProject({
      'scenes/a.pix3scene': A_OLD,
      'prefabs/p.prefab': P_OLD,
    }));
    await claim(p, 'tab-a');
    const response = await changeset(p, 'tab-a', [
      { path: 'scenes/a.pix3scene', text: A_NEW, ifMatch: sha(A_OLD) },
      { path: 'prefabs/p.prefab', text: P_NEW, ifMatch: `"${sha('what the editor thought')}"` },
    ]);
    expect(response.status).toBe(412);
    expect(await json(response)).toMatchObject({
      error: 'base_mismatch',
      path: 'prefabs/p.prefab',
      currentHash: sha(P_OLD),
    });
    expect(read(p, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(read(p, 'prefabs/p.prefab')).toBe(P_OLD);

    const exists = await changeset(p, 'tab-a', [
      { path: 'scenes/b.pix3scene', text: A_NEW },
      { path: 'prefabs/p.prefab', text: P_NEW, createOnly: true },
    ]);
    expect(exists.status).toBe(412);
    expect(await json(exists)).toMatchObject({ error: 'exists', path: 'prefabs/p.prefab' });
    expect(read(p, 'scenes/b.pix3scene')).toBeNull();
  });

  it('refuses a changeset from a superseded writer with 409 and writes nothing', async () => {
    const p = (project = await startProject({ 'scenes/a.pix3scene': A_OLD }));
    await claim(p, 'tab-a');
    await claim(p, 'tab-b');
    const response = await changeset(p, 'tab-a', [
      { path: 'scenes/a.pix3scene', text: A_NEW, ifMatch: sha(A_OLD) },
      { path: 'prefabs/p.prefab', text: P_NEW },
    ]);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: 'writer_superseded', writerId: 'tab-b' });
    expect(read(p, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(read(p, 'prefabs/p.prefab')).toBeNull();
  });

  it('replays a retried X-Mutation-Id and takes binary entries as base64', async () => {
    const p = (project = await startProject());
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const files = [{ path: 'assets/blob.bin', base64: bytes.toString('base64') }];
    const first = await changeset(p, 'tab-a', files, { 'X-Mutation-Id': 'cs-1' });
    expect(first.status).toBe(200);
    const again = await changeset(p, 'tab-a', files, { 'X-Mutation-Id': 'cs-1' });
    expect(again.headers.get('x-mutation-replayed')).toBe('true');
    expect(await json(again)).toEqual(await json(first));
    expect(readFileSync(join(p.root, 'assets/blob.bin')).equals(bytes)).toBe(true);
  });
});

describe('changeset transaction and recovery (ProjectFiles)', () => {
  const roots: string[] = [];
  const files: ProjectFiles[] = [];
  afterEach(async () => {
    for (const f of files.splice(0)) await f.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const makeRoot = (initial: Record<string, string>): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-tx-')));
    roots.push(root);
    for (const [path, text] of Object.entries(initial)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const open = async (
    root: string,
    options: Partial<ProjectFilesOptions> = {}
  ): Promise<{ files: ProjectFiles; frames: FsFrame[]; log: string[] }> => {
    const frames: FsFrame[] = [];
    const log: string[] = [];
    const f = new ProjectFiles({
      root,
      onChange: frame => frames.push(frame),
      log: line => log.push(line),
      ...options,
    });
    files.push(f);
    await f.start();
    return { files: f, frames, log };
  };
  const text = (root: string, path: string): string | null =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const txDirs = (root: string): string[] =>
    existsSync(join(root, '.pix3', 'tx')) ? readdirSync(join(root, '.pix3', 'tx')) : [];
  const entries = (withNewFile = false) =>
    parseChangeset({
      files: [
        { path: 'scenes/a.pix3scene', text: A_NEW, ifMatch: sha(A_OLD) },
        withNewFile
          ? { path: 'prefabs/new.prefab', text: P_NEW, createOnly: true }
          : { path: 'prefabs/p.prefab', text: P_NEW, ifMatch: sha(P_OLD) },
      ],
    });

  it('rolls the first file back when the run fails after its rename (nothing half-written)', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD, 'prefabs/p.prefab': P_OLD });
    const { files: f, frames } = await open(root, {
      faults: {
        afterRename: n => {
          if (n === 0) throw new Error('disk full');
        },
      },
    });
    await expect(f.performChangeset(entries(), null)).rejects.toThrow('disk full');
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(text(root, 'prefabs/p.prefab')).toBe(P_OLD);
    expect(f.hashOf('scenes/a.pix3scene')).toBe(sha(A_OLD));
    expect(frames).toEqual([]);
    expect(txDirs(root)).toEqual([]);
  });

  it('deletes a created file on rollback', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD });
    const { files: f } = await open(root, {
      faults: {
        afterRename: n => {
          if (n === 1) throw new Error('boom');
        },
      },
    });
    const changes = parseChangeset({
      files: [
        { path: 'prefabs/new.prefab', text: P_NEW, createOnly: true },
        { path: 'scenes/a.pix3scene', text: A_NEW },
      ],
    });
    await expect(f.performChangeset(changes, null)).rejects.toThrow('boom');
    expect(text(root, 'prefabs/new.prefab')).toBeNull();
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_OLD);
  });

  it('rolls a fully staged changeset forward after a kill between renames', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD, 'prefabs/p.prefab': P_OLD });
    const { files: first } = await open(root, { faults: { afterRename: () => 'kill' } });
    await expect(first.performChangeset(entries(), null)).rejects.toThrow('killed');
    // Mid-transaction on disk: the first file is new, the second still old.
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_NEW);
    expect(text(root, 'prefabs/p.prefab')).toBe(P_OLD);
    expect(txDirs(root)).toHaveLength(1);

    const { files: second, log } = await open(root);
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_NEW);
    expect(text(root, 'prefabs/p.prefab')).toBe(P_NEW);
    expect(second.hashOf('prefabs/p.prefab')).toBe(sha(P_NEW));
    expect(txDirs(root)).toEqual([]);
    expect(log.some(line => line.includes('rolled forward'))).toBe(true);
    const journal = await second.history.list('prefabs/p.prefab');
    expect(journal[0]).toMatchObject({ author: 'editor', sha256: sha(P_NEW) });
  });

  it('rolls back after a kill when a staged file is lost', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD });
    const { files: first } = await open(root, { faults: { afterRename: () => 'kill' } });
    await expect(first.performChangeset(entries(true), null)).rejects.toThrow('killed');
    const [id] = txDirs(root);
    rmSync(join(root, '.pix3', 'tx', id, 'new', '1'));

    const { files: second, log } = await open(root);
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(text(root, 'prefabs/new.prefab')).toBeNull();
    expect(second.hashOf('scenes/a.pix3scene')).toBe(sha(A_OLD));
    expect(txDirs(root)).toEqual([]);
    expect(log.some(line => line.includes('rolled back'))).toBe(true);
    // The rolled-back bytes equal the newest journaled version (the start-up snapshot), so the
    // journal does not record them twice; the new bytes never became a version.
    const journal = await second.history.list('scenes/a.pix3scene');
    expect(journal.map(entry => entry.sha256)).toEqual([sha(A_OLD)]);
  });

  it('rolls back after a kill when a renamed target was overwritten before the restart', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD, 'prefabs/p.prefab': P_OLD });
    const { files: first } = await open(root, {
      faults: { afterRename: n => (n === 1 ? 'kill' : undefined) },
    });
    await expect(first.performChangeset(entries(), null)).rejects.toThrow('killed');
    expect(text(root, 'prefabs/p.prefab')).toBe(P_NEW);
    // Someone overwrote a renamed target before the restart: the intent no longer holds.
    writeFileSync(join(root, 'prefabs/p.prefab'), 'other\n');
    await open(root);
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(text(root, 'prefabs/p.prefab')).toBe(P_OLD);
  });

  it('discards a transaction that died before its intent was written', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD });
    mkdirSync(join(root, '.pix3', 'tx', 'dead', 'new'), { recursive: true });
    writeFileSync(join(root, '.pix3', 'tx', 'dead', 'new', '0'), A_NEW);
    const { log } = await open(root);
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_OLD);
    expect(txDirs(root)).toEqual([]);
    expect(log.some(line => line.includes('no readable intent'))).toBe(true);
  });

  it('finishes an accepted changeset before a claim answers; after it the old writer is refused', async () => {
    const root = makeRoot({ 'scenes/a.pix3scene': A_OLD, 'prefabs/p.prefab': P_OLD });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { files: f } = await open(root, {
      faults: { afterRename: n => (n === 0 ? gate : undefined) },
    });
    await f.claim('tab-a');
    const order: string[] = [];
    const written = f.performChangeset(entries(), 'tab-a').then(result => {
      order.push('changeset');
      return result;
    });
    await sleep(20);
    const claimed = f.claim('tab-b').then(result => {
      order.push('claim');
      return result;
    });
    await sleep(50);
    expect(order).toEqual([]);
    release();
    const [result, handover] = await Promise.all([written, claimed]);
    expect(order).toEqual(['changeset', 'claim']);
    expect(result.files.map(file => file.sha256)).toEqual([sha(A_NEW), sha(P_NEW)]);
    // B starts from a disk that already contains A's changeset.
    expect((handover.hashes as Record<string, string>)['prefabs/p.prefab']).toBe(sha(P_NEW));

    const late = parseChangeset({ files: [{ path: 'scenes/a.pix3scene', text: 'late\n' }] });
    await expect(f.performChangeset(late, 'tab-a')).rejects.toMatchObject({
      status: 409,
      code: 'writer_superseded',
    });
    expect(text(root, 'scenes/a.pix3scene')).toBe(A_NEW);
  });
});
