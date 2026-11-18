/**
 * A stored bot policy turned into a live {@link BotPolicy} — the part of loading that needs no
 * editor: the game page's test host (plan play-in-page S3) and the CLI's `dist` bundle.
 *
 * Policies are not compiled here. The dev server imports `design/tests/bots/` through the plugin's
 * `virtual:pix3/bot-policies` root (same toolchain, externals and errors as a game script), and
 * {@link ModuleBotStore} reads the evaluated modules — so a policy may import a sibling helper, and
 * a policy that does not compile shows Vite's own error in the page.
 */

import {
  botFilePath,
  botNameFromPath,
  BOT_DIRECTORY,
  describeAvailableBots,
  resolveBotPolicy,
  type BotPolicy,
  type BotStore,
  type StoredBot,
} from '@/services/game-test/game-bots';
import { describeError } from '@/services/game-test/report-format';

export interface BotLoadFailure {
  error: string;
}

export interface BotLoaded {
  policy: BotPolicy;
  /** The file's bare name — how the run addresses it and how the report names it. */
  name: string;
  /** Load warnings, passed through so a policy that loaded oddly says so. */
  warnings: string[];
}

/**
 * Policies as the dev server evaluated them. `modules` is read on every call, so a policy saved
 * a moment ago (the plugin re-imports the root) is what the next run gets. Keys are glob keys
 * (`/design/tests/bots/dodge.ts`); only files directly in {@link BOT_DIRECTORY} are policies.
 */
export class ModuleBotStore implements BotStore {
  constructor(private readonly modules: () => Readonly<Record<string, Record<string, unknown>>>) {}

  async load(name: string): Promise<StoredBot | null> {
    const path = botFilePath(name);
    return (await this.list()).find(bot => bot.path === path) ?? null;
  }

  async list(): Promise<StoredBot[]> {
    const bots: StoredBot[] = [];
    for (const [key, module] of Object.entries(this.modules())) {
      const path = key.replace(/^(\.\.?\/|\/)+/, '');
      const rest = path.startsWith(`${BOT_DIRECTORY}/`) ? path.slice(BOT_DIRECTORY.length + 1) : '';
      if (!rest || rest.includes('/') || !rest.endsWith('.ts') || rest.endsWith('.d.ts')) continue;
      bots.push({ name: botNameFromPath(path), path, module });
    }
    return bots.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Load one policy from `store`. Every failure is a sentence the agent can act on, not a throw. */
export async function loadBotPolicy(
  store: BotStore,
  name: string
): Promise<BotLoaded | BotLoadFailure> {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      error: `game_run \`bot.name\` must name a stored policy, e.g. {bot: {name: 'dodge'}} for ${BOT_DIRECTORY}/dodge.ts.`,
    };
  }

  let stored: StoredBot | null;
  let siblings: StoredBot[];
  try {
    [stored, siblings] = await Promise.all([store.load(trimmed), store.list()]);
  } catch (error) {
    return { error: `Could not read ${BOT_DIRECTORY}: ${describeError(error)}` };
  }
  if (!stored) {
    return {
      error: `No policy stored at ${botFilePath(trimmed)}. ${describeAvailableBots(siblings)} Write one — a single file exporting {name, tick(bot)} — then pix3_sync.`,
    };
  }
  if (!stored.module) {
    return {
      error: `${stored.path} is not loaded by the dev server yet — save it under ${BOT_DIRECTORY}/ and sync (a file that does not compile shows Vite's error in the page).`,
    };
  }

  const resolved = resolveBotPolicy(stored.module);
  if ('error' in resolved) {
    return { error: `${stored.path}: ${resolved.error}` };
  }
  return { policy: resolved.policy, name: stored.name, warnings: [] };
}
