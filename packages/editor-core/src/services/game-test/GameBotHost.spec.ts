import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameBotHost, ModuleBotStore } from '@/services/game-test/GameBotHost';
import { BOT_DIRECTORY, InMemoryBotStore } from '@/services/game-test/game-bots';
import { HostService } from '@/host/HostService';
import { FakeHost } from '@/host/testing/fake-host';

/**
 * The host's job is to answer every failure with something the agent can fix in one edit, and
 * to hand over the policy the dev server evaluated (`virtual:pix3/bot-policies`).
 */

const policyModule = (): Record<string, unknown> => ({ default: { name: 'p', tick: () => {} } });

function buildHost(store: InMemoryBotStore | ModuleBotStore): GameBotHost {
  const host = new GameBotHost();
  Object.defineProperty(host, 'hostService', { value: new HostService(), configurable: true });
  host.setStore(store);
  return host;
}

const storeWith = (entries: Record<string, string | Record<string, unknown>>): InMemoryBotStore => {
  const store = new InMemoryBotStore();
  for (const [name, content] of Object.entries(entries)) store.put(name, content);
  return store;
};

describe('GameBotHost.load — refusals', () => {
  it('needs a name', async () => {
    const result = await buildHost(new InMemoryBotStore()).load('   ');
    expect('error' in result && result.error).toContain('must name a stored policy');
  });

  it('answers a missing policy with the ones that exist', async () => {
    const result = await buildHost(storeWith({ dodge: policyModule() })).load('chase');
    expect('error' in result && result.error).toContain(`${BOT_DIRECTORY}/chase.ts`);
    expect('error' in result && result.error).toContain('Stored policies: dodge');
    expect('error' in result && result.error).toContain('pix3_sync');
  });

  it('refuses a text-only policy the dev server has not loaded', async () => {
    const result = await buildHost(storeWith({ dodge: 'export default {tick(){}}' })).load('dodge');
    expect('error' in result && result.error).toContain('not loaded by the dev server');
  });

  it('reports a module of the wrong shape', async () => {
    const result = await buildHost(storeWith({ dodge: { default: { name: 'x' } } })).load('dodge');
    expect('error' in result && result.error).toContain(`${BOT_DIRECTORY}/dodge.ts: `);
    expect('error' in result && result.error).toContain('tick(bot)');
  });

  it('surfaces a store failure as a read failure, not as a missing policy', async () => {
    const store = new InMemoryBotStore();
    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('permission denied'));
    const result = await buildHost(store).load('dodge');
    expect('error' in result && result.error).toContain('Could not read');
  });
});

describe('GameBotHost.load — success', () => {
  it('resolves the evaluated module into a policy', async () => {
    const module = policyModule();
    const result = await buildHost(storeWith({ dodge: module })).load('dodge');
    expect(result).toEqual({ policy: module.default, name: 'dodge', warnings: [] });
  });
});

describe('ModuleBotStore', () => {
  afterEach(() => HostService.reset());

  it('lists only policies directly in the bots folder, never declarations', async () => {
    const store = new ModuleBotStore(() => ({
      '/design/tests/bots/dodge.ts': policyModule(),
      '/design/tests/bots/chase.ts': policyModule(),
      '/design/tests/bots/lib/helpers.ts': { hero: () => null },
      '/design/tests/bots/pix3-test-bot.d.ts': {},
    }));
    expect((await store.list()).map(bot => bot.path)).toEqual([
      `${BOT_DIRECTORY}/chase.ts`,
      `${BOT_DIRECTORY}/dodge.ts`,
    ]);
    expect((await store.load('dodge'))?.name).toBe('dodge');
    expect(await store.load('lib/helpers')).toBeNull();
  });

  it("is the default store when a host is mounted, reading the host's current roots", async () => {
    const module = policyModule();
    HostService.install(
      new FakeHost({
        roots: {
          editorScripts: { __pix3Revision: 1, modules: {} },
          botPolicies: { __pix3Revision: 1, modules: { '/design/tests/bots/dodge.ts': module } },
        },
      })
    );
    const host = new GameBotHost();
    Object.defineProperty(host, 'hostService', { value: new HostService() });

    const result = await host.load('dodge');
    expect('policy' in result && result.policy).toBe(module.default);
  });
});
