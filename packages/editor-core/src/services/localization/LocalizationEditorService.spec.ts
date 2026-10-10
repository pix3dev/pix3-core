import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { ExternalReloadService } from '@/host/ExternalReloadService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import type { HostWriteOptions } from '@/host/EditorHost';
import { HostNoticeService } from '@/host/HostNoticeService';
import { MemoryDraftStore, SceneDraftService } from '@/services/project/SceneDraftService';
import { appState, resetAppState } from '@/state';

import { LocalizationEditorService } from './LocalizationEditorService';

/**
 * Locale tables follow the disk (`.plans/write-model.md` W20): a mounted editor over `FakeHost`,
 * whose conditional writes behave like the plugin's (`If-Match` mismatch / `createOnly` → 412).
 */

const EN = 'locales/en.json';
const file = (strings: Record<string, string>, name = 'English'): string =>
  `${JSON.stringify({ $meta: { locale: 'en', name }, strings, sprites: {} }, null, 2)}\n`;

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;
let host: FakeHost;
let writes: Array<{ path: string; options: HostWriteOptions }> = [];

const drafts = new MemoryDraftStore();

async function boot(
  files: Record<string, string>,
  existing: FakeHost | null = null
): Promise<LocalizationEditorService> {
  resetAppState();
  service(SceneDraftService).useStore(drafts);
  host =
    existing ??
    new FakeHost({
      files: { 'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n', ...files },
    });
  await host.whenReady();
  writes = [];
  const write = host.files.write.bind(host.files);
  host.files.write = (path, data, options = {}) => {
    writes.push({ path, options });
    return write(path, data, options);
  };
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  const localization = service(LocalizationEditorService);
  localization.initialize();
  await vi.waitFor(() => expect(localization.getLocales().length).toBeGreaterThan(0));
  return localization;
}

const strings = (path = EN): Record<string, string> =>
  (JSON.parse(host.text(path) ?? '{}') as { strings?: Record<string, string> }).strings ?? {};

/** Close the tab: the service and the editor go, the host (the disk) and the draft store stay. */
async function closeTab(): Promise<void> {
  service(LocalizationEditorService).dispose();
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
}

afterEach(async () => {
  await closeTab();
  drafts.records.clear();
});

describe('LocalizationEditorService — writes', () => {
  it('writes with If-Match on the baseline it read', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const sha = (await host.files.read(EN))!.sha256;
    await loc.setEntry('en', 'bye', 'Bye');
    expect(writes).toEqual([{ path: EN, options: { ifMatch: sha } }]);
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Hello' });
    // The next write is on the version just written.
    const written = (await host.files.read(EN))!.sha256;
    await loc.setEntry('en', 'hello', 'Hi');
    expect(writes[1].options).toEqual({ ifMatch: written });
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Hi' });
  });

  it("an agent's key written before the editor's edit: both survive (412 → merge → write)", async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    // The agent's write; the editor has not followed it yet.
    await host.externalWrite(EN, file({ hello: 'Hello', title: 'Agent title' }));
    await loc.setEntry('en', 'bye', 'Bye');
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Hello', title: 'Agent title' });
    expect(loc.getEntry('en', 'title')).toBe('Agent title');
    expect(loc.getEntry('en', 'bye')).toBe('Bye');
    expect(appState.project.host.notices).toEqual([]);
  });

  it('the same key: the disk value stays, a notice, the editor table in the journal', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    await host.externalWrite(EN, file({ hello: 'Agent hello' }));
    await loc.setEntry('en', 'hello', 'My hello');
    expect(strings()).toEqual({ hello: 'Agent hello' });
    expect(loc.getEntry('en', 'hello')).toBe('Agent hello');
    expect(appState.project.host.notices.map(n => n.message)).toEqual([
      'locales/en.json changed on disk while you were editing it: your change to 1 key was dropped, the disk value kept.',
    ]);
    expect(appState.project.host.notices[0].detail).toContain('hello');
    expect(host.journal.at(-1)).toMatchObject({ path: EN, author: 'rejected-draft' });
    expect(host.journal.at(-1)!.text).toContain('My hello');
  });

  it('a broken file is never written over; its edit stays in memory', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    await host.externalWrite(EN, '{ "strings": { "hello": ');
    await loc.setEntry('en', 'bye', 'Bye');
    expect(host.text(EN)).toBe('{ "strings": { "hello": ');
    expect(loc.hasUnwrittenEdits('en')).toBe(true);
    // Once the file parses again, the edit merges in and is written (the sync's flush).
    await host.externalWrite(EN, file({ hello: 'Fixed' }));
    await service(ExternalReloadService).apply([EN]);
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Fixed' });
    expect(loc.hasUnwrittenEdits('en')).toBe(false);
  });
});

describe('LocalizationEditorService — following the disk', () => {
  it('an external version comes in without a write of the editor', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const agentText = file({ hello: 'Hello', title: 'Agent title' });
    await host.externalWrite(EN, agentText);
    await service(ExternalReloadService).apply([EN]);
    expect(loc.getEntry('en', 'title')).toBe('Agent title');
    expect(writes).toEqual([]);
    expect(host.text(EN)).toBe(agentText);
  });

  it('through the pix3:fs frame and ExternalChangeService, with no call from the spec', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const revision = appState.localization.revision;
    await host.externalWrite(EN, file({ hello: 'Hello', title: 'Agent title' }));
    await vi.waitFor(() => expect(loc.getEntry('en', 'title')).toBe('Agent title'), {
      timeout: 3000,
    });
    expect(appState.localization.revision).toBeGreaterThan(revision);
  });

  it('a new locale file appears, a deleted one disappears', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    await host.externalWrite('locales/de.json', file({ hello: 'Hallo' }));
    await service(ExternalReloadService).apply(['locales/de.json']);
    expect(loc.getLocales()).toEqual(['de', 'en']);
    expect(loc.getDefaultLocale()).toBe('en');
    expect(loc.getEntry('de', 'hello')).toBe('Hallo');
    expect(appState.localization.locales).toEqual(['de', 'en']);

    host.externalDelete('locales/de.json');
    await vi.waitFor(() => expect(loc.getLocales()).toEqual(['en']));
    expect(appState.localization.locales).toEqual(['en']);
  });

  it('an agent that wrote from a read older than the editor’s write: a notice offers the edit back', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const stale = host.text(EN)!;
    await loc.setEntry('en', 'hello', 'Hi');
    // The agent read before that write and puts its own version back.
    await host.externalWrite(EN, stale.replace('"Hello"', '"Hello", "title": "T"'));
    await service(ExternalReloadService).apply([EN]);
    expect(loc.getEntry('en', 'hello')).toBe('Hello');
    const notice = appState.project.host.notices.find(n => n.id === `locale-clobber:${EN}`);
    expect(notice?.message).toBe('An agent overwrote your edit in locales/en.json.');
    await service(HostNoticeService).runAction(notice!.actions[0].id);
    expect(strings()).toEqual({ hello: 'Hi', title: 'T' });
  });

  it('the sync flush writes an edit whose write failed without an answer', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const write = host.files.write;
    host.files.write = () => Promise.reject(new Error('socket hang up'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loc.setEntry('en', 'bye', 'Bye');
    expect(loc.hasUnwrittenEdits('en')).toBe(true);
    host.files.write = write;
    await loc.flush();
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Hello' });
    error.mockRestore();
  });
});

describe('LocalizationEditorService — the draft of a write that got no answer (W22)', () => {
  const serverDown = (): (() => void) => {
    const write = host.files.write;
    host.files.write = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => {
      host.files.write = write;
      error.mockRestore();
    };
  };

  it('a failed write is checkpointed; the next open offers it and "Restore" writes it', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const sha = (await host.files.read(EN))!.sha256;
    const restoreServer = serverDown();
    await loc.setEntry('en', 'bye', 'Bye');
    expect(strings()).toEqual({ hello: 'Hello' });
    expect([...drafts.records.values()]).toMatchObject([{ path: EN, baselineSha: sha }]);
    expect([...drafts.records.values()][0].text).toContain('"bye": "Bye"');
    restoreServer();
    await closeTab(); // the edit lived only in memory — and in the draft

    const again = await boot({}, host);
    await vi.waitFor(() => expect(appState.project.host.notices).toHaveLength(1));
    const notice = appState.project.host.notices[0];
    expect(notice.message).toContain(`Unsaved edits to ${EN}`);
    expect(notice.actions.map(a => a.label)).toEqual(['Restore', 'Discard']);
    expect(again.getEntry('en', 'bye')).toBe('');
    await service(HostNoticeService).runAction(notice.actions[0].id);
    await vi.waitFor(() => expect(strings()).toEqual({ bye: 'Bye', hello: 'Hello' }));
    expect(again.getEntry('en', 'bye')).toBe('Bye');
    expect(drafts.records.size).toBe(0);
  });

  it('a draft made against an older disk goes to the journal as rejected-draft, not offered', async () => {
    const loc = await boot({ [EN]: file({ hello: 'Hello' }) });
    const restoreServer = serverDown();
    await loc.setEntry('en', 'bye', 'Bye');
    restoreServer();
    await closeTab();
    await host.externalWrite(EN, file({ hello: 'Hello', agent: 'Agent' }));

    await boot({}, host);
    await vi.waitFor(() => expect(appState.project.host.notices).toHaveLength(1));
    expect(appState.project.host.notices[0].actions).toEqual([]);
    expect(host.journal).toHaveLength(1);
    expect(host.journal[0]).toMatchObject({ author: 'rejected-draft', path: EN });
    expect(host.journal[0].text).toContain('"bye": "Bye"');
    expect(strings()).toEqual({ agent: 'Agent', hello: 'Hello' });
    expect(drafts.records.size).toBe(0);
  });

  it('a write that lands drops the draft; a declared locale without a file is drafted against no version', async () => {
    const loc = await boot({
      'pix3project.yaml':
        'version: 1.0.0\nmetadata:\n  projectId: p-1\nlocalization:\n  defaultLocale: en\n  locales: [en, de]\n',
      [EN]: file({ hello: 'Hello' }),
    });
    const restoreServer = serverDown();
    await loc.setEntry('en', 'bye', 'Bye');
    expect(drafts.records.size).toBe(1);
    restoreServer();
    await loc.flush(); // the sync's step 0 writes it
    expect(strings()).toEqual({ bye: 'Bye', hello: 'Hello' });
    expect(drafts.records.size).toBe(0);

    // A declared locale whose file does not exist yet (its first write is `createOnly`): the draft
    // applies as long as the file is still absent.
    const down = serverDown();
    await loc.setEntry('de', 'hello', 'Hallo');
    down();
    expect([...drafts.records.values()]).toMatchObject([
      { path: 'locales/de.json', baselineSha: '' },
    ]);
    await closeTab();
    await boot({}, host);
    await vi.waitFor(() => expect(appState.project.host.notices).toHaveLength(1));
    expect(appState.project.host.notices[0].actions.map(a => a.label)).toEqual([
      'Restore',
      'Discard',
    ]);
  });
});
