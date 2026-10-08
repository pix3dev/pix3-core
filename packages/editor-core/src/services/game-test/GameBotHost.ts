/**
 * Turns a stored policy file into a live {@link BotPolicy} (§5.3, phase 8).
 *
 * This service owns exactly two things — **where policies come from** and **how a stored
 * policy becomes a callable object** — and nothing about how a policy is driven. The driving
 * is `BotSession` in `game-bots.ts` (pure, spec'd against a fake world); the live world is
 * built in `GameTestService`.
 *
 * Policies are not compiled here. The dev server imports `design/tests/bots/` through the
 * plugin's `virtual:pix3/bot-policies` root (same toolchain, externals and errors as a game
 * script), and {@link ModuleBotStore} reads the evaluated modules from
 * `HostService.host.scripts.current().botPolicies` — so a policy may import a sibling helper,
 * and a policy that does not compile shows Vite's own error in the page.
 *
 * On the first successful load in a project, `design/tests/bots/pix3-test-bot.d.ts` is written
 * next to the policies: completion on `bot.` in whatever editor the file is open in.
 */

import { inject, injectable } from '@/fw/di';
import { HostService } from '@/host/HostService';
import {
  botFilePath,
  botNameFromPath,
  BOT_DIRECTORY,
  describeAvailableBots,
  InMemoryBotStore,
  resolveBotPolicy,
  type BotPolicy,
  type BotStore,
  type StoredBot,
} from '@/services/game-test/game-bots';
import { BOT_DTS_FILE_NAME, PIX3_TEST_BOT_DTS } from '@/services/game-test/pix3-test-bot-dts';

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

/** Where the d.ts is written, so the caller can say it happened. */
export const BOT_DTS_PATH = `${BOT_DIRECTORY}/${BOT_DTS_FILE_NAME}`;

/** The narrow write seam: the host only ever writes the declaration file. */
export interface BotDeclarationWriter {
  writeTextFile(path: string, contents: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
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

@injectable()
export class GameBotHost {
  @inject(HostService)
  private readonly hostService!: HostService;

  private store: BotStore | null = null;
  private declarations: BotDeclarationWriter | null = null;
  /** Written once per project swap, not once per run — it is a constant file. */
  private declarationsWritten = false;

  /** Swap the store (specs, or a host-less embedding). */
  setStore(store: BotStore): void {
    this.store = store;
    this.declarationsWritten = false;
  }

  /** The dev server's policies when a host is mounted, else an empty in-memory store. */
  getStore(): BotStore {
    this.store ??= HostService.isInstalled()
      ? new ModuleBotStore(() => this.hostService.host.scripts.current().botPolicies.modules)
      : new InMemoryBotStore();
    return this.store;
  }

  /**
   * Where the generated `.d.ts` goes; `null` writes nothing (the declarations are an authoring
   * convenience, never a dependency of a run). Identity-guarded so re-pointing the same writer
   * does not rewrite the file on every run.
   */
  setDeclarationWriter(writer: BotDeclarationWriter | null): void {
    if (this.declarations === writer) return;
    this.declarations = writer;
    this.declarationsWritten = false;
  }

  /** Load one policy. Every failure is a sentence the agent can act on, not a throw. */
  async load(name: string): Promise<BotLoaded | BotLoadFailure> {
    const trimmed = name.trim();
    if (!trimmed) {
      return {
        error: `game_run \`bot.name\` must name a stored policy, e.g. {bot: {name: 'dodge'}} for ${BOT_DIRECTORY}/dodge.ts.`,
      };
    }

    let stored: StoredBot | null;
    let siblings: StoredBot[];
    const store = this.getStore();
    try {
      [stored, siblings] = await Promise.all([store.load(trimmed), store.list()]);
    } catch (error) {
      return { error: `Could not read ${BOT_DIRECTORY}: ${describeError(error)}` };
    }
    if (!stored) {
      return {
        error: `No policy stored at ${botFilePath(trimmed)}. ${describeAvailableBots(siblings)} Write one with fs_write — it is a single file exporting {name, tick(bot)}.`,
      };
    }
    if (!stored.module) {
      return {
        error: `${stored.path} is not loaded by the dev server yet — save it under ${BOT_DIRECTORY}/ and sync (a file that does not compile shows Vite's error in the page).`,
      };
    }

    await this.ensureDeclarations();

    const resolved = resolveBotPolicy(stored.module);
    if ('error' in resolved) {
      return { error: `${stored.path}: ${resolved.error}` };
    }
    return { policy: resolved.policy, name: stored.name, warnings: [] };
  }

  /** Write the ambient declarations next to the policies, at most once per project. */
  private async ensureDeclarations(): Promise<void> {
    if (this.declarationsWritten || !this.declarations) return;
    this.declarationsWritten = true;
    try {
      await this.declarations.createDirectory(BOT_DIRECTORY);
    } catch {
      /* the write below is the one whose failure would matter, and it is swallowed too */
    }
    try {
      await this.declarations.writeTextFile(BOT_DTS_PATH, PIX3_TEST_BOT_DTS);
    } catch {
      /* authoring convenience only — never a precondition of a run */
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
