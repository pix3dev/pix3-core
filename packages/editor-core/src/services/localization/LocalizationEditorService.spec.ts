import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { ExternalReloadService } from '@/host/ExternalReloadService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import type { HostWriteOptions } from '@/host/EditorHost';
import { HostNoticeService } from '@/host/HostNoticeService';
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

async function boot(files: Record<string, string>): Promise<LocalizationEditorService> {
  resetAppState();
  host = new FakeHost({
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

afterEach(async () => {
  service(LocalizationEditorService).dispose();
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
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
