import { afterEach, describe, expect, it } from 'vitest';

import { EDITOR_PRESENCE_CHANNEL, isEditorOpen, mountEditorLink, profilerUrl } from './editor-link';

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

  it('opens its menu upward from the chevron and closes it on Escape or a press outside', () => {
    const unmount = mountEditorLink('/__pix3/');
    const root = document.querySelector('.pix3-editor-link')?.shadowRoot;
    const more = root?.querySelector<HTMLButtonElement>('[data-action="menu"]');
    const menu = root?.querySelector<HTMLElement>('.menu');
    expect(menu?.hidden).toBe(true);
    more?.click();
    expect(menu?.hidden).toBe(false);
    expect(more?.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.querySelector('[data-item="profiler"]')?.textContent).toContain('Profiler');
    more?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
    );
    expect(menu?.hidden).toBe(true);
    more?.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu?.hidden).toBe(true);
    unmount();
  });

  it('points the profiler at this page with a bare ?debug, keeping the rest', () => {
    expect(profilerUrl('http://localhost:5173/')).toBe('http://localhost:5173/?debug');
    expect(profilerUrl('http://localhost:5173/?scene=scenes%2Fmain.pix3scene#x')).toBe(
      'http://localhost:5173/?debug&scene=scenes%2Fmain.pix3scene#x'
    );
    expect(profilerUrl('http://localhost:5173/?debug=1&scene=a')).toBe(
      'http://localhost:5173/?debug&scene=a'
    );
  });
});
