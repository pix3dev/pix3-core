import { afterEach, describe, expect, it } from 'vitest';

import { EDITOR_PRESENCE_CHANNEL, isEditorOpen, mountEditorLink } from './editor-link';

const answering: BroadcastChannel[] = [];
/** A stand-in for an open editor tab (`editor-presence.ts` answers the same way). */
const fakeEditor = (): void => {
  const channel = new BroadcastChannel(EDITOR_PRESENCE_CHANNEL);
  channel.onmessage = event => {
    const data = event.data as { type?: string; id?: string };
    if (data.type === 'ping') channel.postMessage({ type: 'pong', id: data.id });
  };
  answering.push(channel);
};

afterEach(() => {
  for (const channel of answering.splice(0)) channel.close();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

describe('editor link', () => {
  it('knows whether an editor tab answers', async () => {
    expect(await isEditorOpen(100)).toBe(false);
    fakeEditor();
    expect(await isEditorOpen(500)).toBe(true);
  });

  it('mounts a link with a labelled hide button, and stays hidden for the session once hidden', () => {
    const unmount = mountEditorLink('/__pix3/');
    const root = document.querySelector('.pix3-editor-link')?.shadowRoot;
    expect(root?.querySelector('[data-action="open"]')?.textContent).toContain('Pix3 editor');
    const hide = root?.querySelector<HTMLButtonElement>('[data-action="hide"]');
    expect(hide?.getAttribute('aria-label')).toBeTruthy();
    hide?.click();
    expect(document.querySelector('.pix3-editor-link')).toBeNull();
    mountEditorLink('/__pix3/');
    expect(document.querySelector('.pix3-editor-link')).toBeNull();
    unmount();
  });
});
