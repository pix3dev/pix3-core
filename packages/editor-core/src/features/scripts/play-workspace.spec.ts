import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceContainer } from '@/fw/di';

import { ensureSceneActive } from './play-workspace';

// The real EditorTabService pulls in Golden Layout; the specs only need its class as a token.
vi.mock('@/services/editor/EditorTabService', () => ({
  EditorTabService: class EditorTabService {},
}));

/**
 * A container that hands out whatever stub is registered for a class, keyed by the class itself
 * (`getOrCreateToken` is identity here, exactly as the other command specs do it).
 */
const createContainer = (services: Map<unknown, unknown>): ServiceContainer =>
  ({
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) {
        throw new Error('Unexpected getService call in this test');
      }
      return services.get(token) as T;
    },
  }) as unknown as ServiceContainer;

const calls: string[] = [];
const ensureReady = vi.fn(async () => {
  calls.push('ensureReady');
});
const focusOrOpenScene = vi.fn(async (path: string) => {
  calls.push(`focus:${path}`);
});

const buildContainer = async (): Promise<ServiceContainer> => {
  const { ProjectScriptLoaderService } = await import(
    '@/services/scripting/ProjectScriptLoaderService'
  );
  const { EditorTabService } = await import('@/services/editor/EditorTabService');
  return createContainer(
    new Map<unknown, unknown>([
      [ProjectScriptLoaderService, { ensureReady }],
      [EditorTabService, { focusOrOpenScene }],
    ])
  );
};

describe('ensureSceneActive', () => {
  beforeEach(() => {
    calls.length = 0;
    ensureReady.mockClear();
    focusOrOpenScene.mockClear();
  });

  it('registers project scripts before it opens the scene tab', async () => {
    await ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene');

    expect(calls).toEqual(['ensureReady', 'focus:res://scenes/main.pix3scene']);
  });

  it('propagates a failure to open the scene', async () => {
    focusOrOpenScene.mockRejectedValueOnce(new Error('Could not open the scene'));

    await expect(
      ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene')
    ).rejects.toThrow(/Could not open the scene/);
  });
});
