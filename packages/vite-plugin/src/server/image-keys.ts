import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { errnoCode } from './http.ts';

/**
 * Image-generation API keys (plan §B.1 «Ключи генерации картинок»). They live on this machine,
 * never in the browser: the origin is the dev server's port, which every project and the game's
 * own code share, so localStorage / IndexedDB is no place for a secret. The plugin's proxy
 * (`image-proxy.ts`) reads the key per request and adds it to the upstream call.
 *
 * Where: `~/.pix3/keys.json` (`PIX3_HOME` overrides `~/.pix3`, as for the CLI), mode 0600 in a
 * 0700 directory. When `~` cannot be written (a sandbox), `.pix3/local/keys.json` in the project —
 * `.pix3/` is gitignored by the starter, and the file API refuses `.pix3/local` (`paths.ts`).
 * The file is read on every request, so an edit by hand applies at once; unknown entries survive
 * a write.
 */

export const IMAGE_PROVIDERS = ['gemini', 'openai'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export const isImageProvider = (value: unknown): value is ImageProvider =>
  typeof value === 'string' && (IMAGE_PROVIDERS as readonly string[]).includes(value);

/** What the editor may learn about a key: whether it is there, and its last four characters. */
export interface KeyStatus {
  readonly set: boolean;
  readonly last4?: string;
}

export interface KeyStoreOptions {
  /** `~/.pix3` (or `PIX3_HOME`). */
  readonly home: string;
  readonly projectRoot: string;
}

export const defaultPix3Home = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PIX3_HOME || join(homedir(), '.pix3');

export const KEYS_FILE = 'keys.json';
export const LOCAL_KEYS_PATH = '.pix3/local/keys.json';

/** Errors that mean "this directory is not ours to write" — the cue for the project fallback. */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

const statusOf = (key: string | undefined): KeyStatus =>
  key ? { set: true, last4: key.length >= 12 ? key.slice(-4) : undefined } : { set: false };

export class ImageKeyStore {
  private readonly homeFile: string;
  private readonly localFile: string;

  constructor(options: KeyStoreOptions) {
    this.homeFile = join(options.home, KEYS_FILE);
    this.localFile = join(options.projectRoot, ...LOCAL_KEYS_PATH.split('/'));
  }

  /** The key for `provider`, or null. The home file wins over the project fallback. */
  async key(provider: ImageProvider): Promise<string | null> {
    const home = await readKeys(this.homeFile);
    const value = home?.[provider] ?? (await readKeys(this.localFile))?.[provider];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  async status(): Promise<Record<ImageProvider, KeyStatus>> {
    const out = {} as Record<ImageProvider, KeyStatus>;
    for (const provider of IMAGE_PROVIDERS) {
      out[provider] = statusOf((await this.key(provider)) ?? undefined);
    }
    return out;
  }

  /**
   * Set (or with `null` remove) one provider's key. Written to `~/.pix3/keys.json`, or to the
   * project's `.pix3/local/keys.json` when the home directory refuses the write. A removal clears
   * the key from both files, so the fallback cannot bring it back.
   */
  async set(
    provider: ImageProvider,
    key: string | null
  ): Promise<{ readonly status: KeyStatus; readonly where: 'home' | 'project' }> {
    const value = key?.trim() || null;
    if (value === null) {
      await this.update(this.homeFile, provider, null).catch(ignoreUnwritable);
      await this.update(this.localFile, provider, null).catch(ignoreUnwritable);
      return { status: { set: false }, where: 'home' };
    }
    try {
      await this.update(this.homeFile, provider, value);
      // A key moved home must not leave a stale copy behind in the project.
      await this.update(this.localFile, provider, null).catch(ignoreUnwritable);
      return { status: statusOf(value), where: 'home' };
    } catch (error) {
      if (!UNWRITABLE.has(errnoCode(error) ?? '')) throw error;
      await this.update(this.localFile, provider, value);
      return { status: statusOf(value), where: 'project' };
    }
  }

  private async update(file: string, provider: ImageProvider, value: string | null): Promise<void> {
    const current = await readKeys(file);
    if (value === null && !current?.[provider]) return;
    const next: Record<string, unknown> = { ...(current ?? {}) };
    if (value === null) delete next[provider];
    else next[provider] = value;
    await writeSecretFile(file, `${JSON.stringify(next, null, 2)}\n`);
  }
}

const ignoreUnwritable = (error: unknown): void => {
  const code = errnoCode(error) ?? '';
  if (!UNWRITABLE.has(code) && code !== 'ENOENT') throw error;
};

const readKeys = async (file: string): Promise<Record<string, unknown> | null> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A hand edit that broke the JSON: no key rather than a crash (the message never quotes it).
    return null;
  }
};

/** 0600 file in a 0700 directory, replaced atomically (never a moment with looser bits). */
const writeSecretFile = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
};
