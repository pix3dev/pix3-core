import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { TAKE_OVER_EVENT } from './pix3-host-banner';

type BannerElement = HTMLElement & { updateComplete: Promise<unknown> };

const mount = async (): Promise<BannerElement> => {
  const banner = document.createElement('pix3-host-banner') as BannerElement;
  document.body.appendChild(banner);
  await banner.updateComplete;
  return banner;
};

const settle = async (banner: BannerElement): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await banner.updateComplete;
};

beforeAll(async () => {
  await import('./pix3-host-banner');
});

beforeEach(() => {
  resetAppState();
  appState.project.status = 'ready';
  appState.project.host.connection = 'open';
  appState.project.host.writer = 'self';
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('pix3-host-banner', () => {
  it('stays empty while this tab is the connected writer', async () => {
    const banner = await mount();
    expect(banner.querySelector('.host-banner')).toBeNull();
  });

  it('offers Take over in a read-only tab and asks the writer service for the claim', async () => {
    appState.project.host.writer = 'other';
    const banner = await mount();
    const listener = vi.fn();
    window.addEventListener(TAKE_OVER_EVENT, listener);
    try {
      expect(banner.textContent).toContain('Another tab is editing');
      banner.querySelector<HTMLButtonElement>('.host-banner__action')?.click();
      expect(listener).toHaveBeenCalledTimes(1);
      await settle(banner);
      expect(banner.querySelector<HTMLButtonElement>('.host-banner__action')?.disabled).toBe(true);

      appState.project.host.writer = 'self';
      await settle(banner);
      expect(banner.querySelector('.host-banner')).toBeNull();
    } finally {
      window.removeEventListener(TAKE_OVER_EVENT, listener);
    }
  });

  it('says edits stay in memory while the dev server is gone, with nothing to click', async () => {
    appState.project.host.connection = 'closed';
    appState.project.host.writer = 'other';
    const banner = await mount();
    expect(banner.textContent).toContain('Dev server disconnected');
    expect(banner.querySelector('.host-banner__action')).toBeNull();
  });
});
