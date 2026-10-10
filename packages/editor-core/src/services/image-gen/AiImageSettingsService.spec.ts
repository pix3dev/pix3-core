import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorHost, HostImageGen, HostImageKeyStatus } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';

const legacy = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Map<string, string> | null>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/services/image-gen/legacy-browser-keys', () => ({
  readLegacyBrowserKeys: legacy.read,
  deleteLegacyBrowserKeys: legacy.remove,
}));

import { AiImageSettingsService } from './AiImageSettingsService';
import { ImageGenProviderRegistry } from './ImageGenProviderRegistry';

/** The dev server's key store, as the page sees it: status in, status out, never a key back. */
const fakeImageGen = (initial: Partial<Record<'gemini' | 'openai', string>> = {}) => {
  const stored = new Map(Object.entries(initial));
  const status = (key: string | undefined): HostImageKeyStatus =>
    key ? { set: true, last4: key.slice(-4) } : { set: false };
  const imageGen: HostImageGen = {
    keys: vi.fn(async () => ({
      gemini: status(stored.get('gemini')),
      openai: status(stored.get('openai')),
    })),
    setKey: vi.fn(async (provider, key) => {
      if (key) stored.set(provider, key);
      else stored.delete(provider);
      return { ...status(key ?? undefined), where: 'home' as const };
    }),
    fetch: vi.fn(async () => new Response('{}')),
  };
  return { imageGen, stored };
};

const service = (imageGen: HostImageGen): AiImageSettingsService => {
  HostService.install({ imageGen } as unknown as EditorHost);
  const settings = new AiImageSettingsService();
  Object.defineProperty(settings, 'registry', { value: new ImageGenProviderRegistry() });
  Object.defineProperty(settings, 'hostService', { value: new HostService() });
  return settings;
};

describe('AiImageSettingsService keys', () => {
  beforeEach(() => {
    legacy.read.mockReset().mockResolvedValue(null);
    legacy.remove.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => HostService.reset());

  it('asks the dev server and routes generation through its proxy', async () => {
    const { imageGen } = fakeImageGen({ gemini: 'AIza-0123456789-wxyz' });
    const settings = service(imageGen);
    expect(await settings.keyStatus('gemini')).toEqual({ set: true, last4: 'wxyz' });
    expect(await settings.keyStatus('openai')).toEqual({ set: false });
    const provider = new ImageGenProviderRegistry().get('openai')!;
    await settings.transportFor(provider)('v1/images/generations', { method: 'POST' });
    expect(imageGen.fetch).toHaveBeenCalledWith('openai', 'v1/images/generations', {
      method: 'POST',
    });
  });

  it('moves a browser-stored key to the dev server once, then deletes the browser copy', async () => {
    legacy.read.mockResolvedValue(
      new Map([
        ['project:p1:ai-provider:gemini:api-key', 'AIza-from-the-browser'],
        ['project:p2:ai-provider:openai:api-key', 'sk-from-the-browser'],
      ])
    );
    // The server already has an OpenAI key: that one stays.
    const { imageGen, stored } = fakeImageGen({ openai: 'sk-on-the-server' });
    const settings = service(imageGen);
    await settings.keyStatus('gemini');
    await settings.keyStatus('openai');
    expect(stored.get('gemini')).toBe('AIza-from-the-browser');
    expect(stored.get('openai')).toBe('sk-on-the-server');
    expect(imageGen.setKey).toHaveBeenCalledTimes(1);
    expect(legacy.read).toHaveBeenCalledTimes(1);
    expect(legacy.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps the browser copy when the hand-over fails', async () => {
    legacy.read.mockResolvedValue(new Map([['ai-provider:gemini:api-key', 'AIza-x']]));
    const { imageGen } = fakeImageGen();
    vi.mocked(imageGen.setKey).mockRejectedValueOnce(new Error('dev server gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await service(imageGen).keyStatus('gemini');
    expect(legacy.remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('says so when the dev server has no proxy', async () => {
    const settings = service(undefined as unknown as HostImageGen);
    await expect(settings.keyStatus('gemini')).rejects.toThrow(/no image-generation proxy/);
  });
});
