/**
 * Where the editor's bot policies come from (§5.3, phase 8): the dev server's
 * `virtual:pix3/bot-policies` root, read from `HostService.host.scripts.current().botPolicies`.
 * Loading a policy is `loadBotPolicy` (`bot-loader.ts`), shared with the game page's test host;
 * the driving is `BotSession` in `game-bots.ts`; the live world is built in `GameTestService`.
 *
 * The editor writes no project files: the policy types (`design/tests/bots/pix3-test-bot.d.ts`)
 * come with the agent kit (`packages/cli/kit-src/design/tests/bots/`, `.plans/done/scripts-vite.md` S8).
 */

import { inject, injectable } from '@/fw/di';
import { HostService } from '@/host/HostService';
import {
  loadBotPolicy,
  ModuleBotStore,
  type BotLoaded,
  type BotLoadFailure,
} from '@/services/game-test/bot-loader';
import { InMemoryBotStore, type BotStore } from '@/services/game-test/game-bots';

@injectable()
export class GameBotHost {
  @inject(HostService)
  private readonly hostService!: HostService;

  private store: BotStore | null = null;

  /** Swap the store (specs, or a host-less embedding). */
  setStore(store: BotStore): void {
    this.store = store;
  }

  /** The dev server's policies when a host is mounted, else an empty in-memory store. */
  getStore(): BotStore {
    this.store ??= HostService.isInstalled()
      ? new ModuleBotStore(() => this.hostService.host.scripts.current().botPolicies.modules)
      : new InMemoryBotStore();
    return this.store;
  }

  /** Load one policy. Every failure is a sentence the agent can act on, not a throw. */
  load(name: string): Promise<BotLoaded | BotLoadFailure> {
    return loadBotPolicy(this.getStore(), name);
  }
}
