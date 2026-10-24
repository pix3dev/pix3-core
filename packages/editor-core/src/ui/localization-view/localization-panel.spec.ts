import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { ExternalReloadService } from '@/host/ExternalReloadService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import { HostNoticeService } from '@/host/HostNoticeService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { appState, resetAppState } from '@/state';

import './localization-panel';
import type { LocalizationPanel } from './localization-panel';

/** The panel's inline key rename against a disk that moves (`.plans/done/write-model.md` W20 debt). */

const EN = 'locales/en.json';
const file = (strings: Record<string, string>): string =>
  `${JSON.stringify({ $meta: { locale: 'en', name: 'English' }, strings, sprites: {} }, null, 2)}\n`;

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;
let panel: LocalizationPanel | null = null;
let host: FakeHost;

async function boot(strings: Record<string, string>): Promise<LocalizationPanel> {
  resetAppState();
  host = new FakeHost({
    files: {
      'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-1\n',
      [EN]: file(strings),
    },
  });
  await host.whenReady();
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  const localization = service(LocalizationEditorService);
  localization.initialize();
  await vi.waitFor(() => expect(localization.getLocales()).toEqual(['en']));
  panel = document.createElement('pix3-localization-panel');
  document.body.appendChild(panel);
  await panel.updateComplete;
  return panel;
}

const renameInput = (key: string): HTMLInputElement | null =>
  panel!.querySelector<HTMLInputElement>(`input[aria-label="Rename ${key}"]`);

async function startRename(key: string, typed: string): Promise<HTMLInputElement> {
  const cell = [...panel!.querySelectorAll<HTMLElement>('span.loc-col-key')].find(
    el => el.textContent?.trim() === key
  )!;
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await panel!.updateComplete;
  const input = renameInput(key)!;
  input.focus();
  input.value = typed;
  return input;
}

const notices = (): string[] => appState.project.host.notices.map(n => n.message);

afterEach(async () => {
  panel?.remove();
  panel = null;
  service(LocalizationEditorService).dispose();
  await handle?.dispose();
  handle = null;
  service(HostNoticeService).reset();
});

describe('localization panel — renaming a key', () => {
  it('the key removed on disk mid-rename: the rename ends with a notice, nothing is renamed', async () => {
    await boot({ hello: 'Hello', bye: 'Bye' });
    const input = await startRename('hello', 'greeting');

    await host.externalWrite(EN, file({ bye: 'Bye' }));
    await service(ExternalReloadService).apply([EN]);
    await panel!.updateComplete;

    expect(renameInput('hello')).toBeNull();
    expect(notices()).toEqual(['"hello" was removed on disk while you were renaming it.']);
    // The removed input's late change/blur does not rename anything.
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('blur'));
    await service(LocalizationEditorService).flush();
    expect(JSON.parse(host.text(EN)!).strings).toEqual({ bye: 'Bye' });
  });

  it('another key changed on disk mid-rename: the typed name survives and commits', async () => {
    await boot({ hello: 'Hello', bye: 'Bye' });
    const input = await startRename('hello', 'greeting');

    await host.externalWrite(EN, file({ hello: 'Hello', bye: 'Bye!', agent: 'Agent' }));
    await service(ExternalReloadService).apply([EN]);
    await panel!.updateComplete;

    expect(renameInput('hello')).toBe(input);
    expect(input.value).toBe('greeting');
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(JSON.parse(host.text(EN)!).strings).toEqual({
        greeting: 'Hello',
        bye: 'Bye!',
        agent: 'Agent',
      })
    );
    expect(notices()).toEqual([]);
  });

  it('a name the disk took meanwhile: not renamed, a notice says why', async () => {
    await boot({ hello: 'Hello' });
    const input = await startRename('hello', 'greeting');

    await host.externalWrite(EN, file({ hello: 'Hello', greeting: 'Hi' }));
    await service(ExternalReloadService).apply([EN]);
    input.dispatchEvent(new Event('change'));
    await panel!.updateComplete;

    expect(renameInput('hello')).toBeNull();
    expect(notices()).toEqual(['"hello" was not renamed: "greeting" already exists.']);
    await service(LocalizationEditorService).flush();
    expect(JSON.parse(host.text(EN)!).strings).toEqual({ hello: 'Hello', greeting: 'Hi' });
  });
});
