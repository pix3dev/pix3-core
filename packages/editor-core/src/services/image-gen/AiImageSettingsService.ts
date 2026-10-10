import { inject, injectable } from '@/fw/di';
import type { HostImageGen, HostImageKeyStatus } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import type {
  AspectRatio,
  ImageGenProvider,
  ImageGenTransport,
} from '@/services/image-gen/ImageGenTypes';
import {
  deleteLegacyBrowserKeys,
  readLegacyBrowserKeys,
} from '@/services/image-gen/legacy-browser-keys';

export interface AiImagePreferences {
  selectedProviderId: string;
  /** Selected model id per provider id. */
  modelByProvider: Record<string, string>;
  defaultAspectRatio: AspectRatio;
  defaultImageSize: string;
  /** Provider-specific quality tier (e.g. OpenAI 'low' | 'medium' | 'high'); '' = provider default. */
  defaultQuality: string;
  /** Request a transparent alpha channel from providers that support it (e.g. OpenAI GPT Image). */
  transparentBackground: boolean;
}

const STORAGE_KEY = 'pix3.aiImageSettings:v1';

const ASPECT_RATIOS: readonly AspectRatio[] = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'];

const isAspectRatio = (value: unknown): value is AspectRatio =>
  typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value);

/**
 * Non-secret preferences for AI image generation (selected provider/model, default size/aspect).
 * Persisted in localStorage — this is app configuration, not scene state, so it deliberately does
 * NOT flow through appState / the undo history.
 *
 * API keys are not in the browser at all (plan §B.1): the dev server keeps them in
 * `~/.pix3/keys.json` and adds them to the provider call (`EditorHost.imageGen`). The page sets a
 * key and learns only whether one is set (and its last four characters). A key an earlier editor
 * stored in the browser (`legacy-browser-keys.ts`) is moved to the dev server once and deleted.
 */
@injectable()
export class AiImageSettingsService {
  @inject(ImageGenProviderRegistry)
  private readonly registry!: ImageGenProviderRegistry;

  @inject(HostService)
  private readonly hostService!: HostService;

  private prefs: AiImagePreferences | null = null;
  private readonly listeners = new Set<(prefs: AiImagePreferences) => void>();

  getPreferences(): AiImagePreferences {
    return { ...this.ensureLoaded() };
  }

  updatePreferences(patch: Partial<AiImagePreferences>): void {
    const next: AiImagePreferences = { ...this.ensureLoaded(), ...patch };
    if (patch.modelByProvider) {
      next.modelByProvider = { ...this.ensureLoaded().modelByProvider, ...patch.modelByProvider };
    }
    this.prefs = next;
    this.persist(next);
    this.notify();
  }

  /** Resolve the currently-selected provider (falls back to the default provider). */
  getSelectedProvider(): ImageGenProvider | undefined {
    const prefs = this.ensureLoaded();
    return this.registry.get(prefs.selectedProviderId) ?? this.registry.getDefault();
  }

  /** Resolve the selected model id for a provider (falls back to its first model). */
  getSelectedModelId(providerId: string): string | undefined {
    const prefs = this.ensureLoaded();
    const provider = this.registry.get(providerId);
    if (!provider) {
      return undefined;
    }
    const stored = prefs.modelByProvider[providerId];
    if (stored && provider.getModel(stored)) {
      return stored;
    }
    return provider.models[0]?.id;
  }

  subscribe(listener: (prefs: AiImagePreferences) => void): () => void {
    this.listeners.add(listener);
    listener(this.getPreferences());
    return () => this.listeners.delete(listener);
  }

  // -- API keys (kept by the dev server, plan §B.1) ---------------------------

  private migration: Promise<void> | null = null;

  /** Whether the dev server has a key for the provider (never the key itself). */
  async keyStatus(providerId: string): Promise<HostImageKeyStatus> {
    const provider = this.registry.get(providerId);
    if (!provider) return { set: false };
    const imageGen = this.imageGen();
    await (this.migration ??= this.migrateBrowserKeys(imageGen));
    return (await imageGen.keys())[provider.id];
  }

  async setApiKey(providerId: string, apiKey: string): Promise<HostImageKeyStatus> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`Unknown image provider: ${providerId}`);
    }
    const status = await this.imageGen().setKey(provider.id, apiKey);
    this.notify();
    return status;
  }

  async clearApiKey(providerId: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return;
    }
    await this.imageGen().setKey(provider.id, null);
    this.notify();
  }

  /** The provider's calls, through the dev server's proxy. */
  transportFor(provider: ImageGenProvider): ImageGenTransport {
    const imageGen = this.imageGen();
    return (path, init) => imageGen.fetch(provider.id, path, init);
  }

  private imageGen(): HostImageGen {
    const imageGen = HostService.isInstalled() ? this.hostService.host.imageGen : undefined;
    if (!imageGen) {
      throw new Error('This dev server has no image-generation proxy (update @pix3/vite-plugin).');
    }
    return imageGen;
  }

  /**
   * Once per tab: a key an earlier editor kept in the browser (per project, encrypted in
   * IndexedDB) moves to the dev server unless the server already has one for that provider; then
   * the browser database is deleted. A failed hand-over keeps it for the next tab to try.
   */
  private async migrateBrowserKeys(imageGen: HostImageGen): Promise<void> {
    try {
      const stored = await readLegacyBrowserKeys();
      if (!stored) return;
      if (stored.size > 0) {
        const status = await imageGen.keys();
        for (const provider of this.registry.list()) {
          if (status[provider.id].set) continue;
          const value = [...stored].find(
            ([id, key]) =>
              key.trim() &&
              (id === provider.apiKeySecretId || id.endsWith(`:${provider.apiKeySecretId}`))
          )?.[1];
          if (value) await imageGen.setKey(provider.id, value);
        }
      }
      await deleteLegacyBrowserKeys();
    } catch (error) {
      console.warn('[pix3] could not move a browser-stored image-gen key to the dev server', error);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.prefs = null;
    this.migration = null;
  }

  // -- internals -------------------------------------------------------------

  private ensureLoaded(): AiImagePreferences {
    if (!this.prefs) {
      this.prefs = this.load();
    }
    return this.prefs;
  }

  private defaults(): AiImagePreferences {
    const defaultProvider = this.registry.getDefault();
    return {
      selectedProviderId: defaultProvider?.id ?? '',
      modelByProvider: {},
      defaultAspectRatio: 'Auto',
      defaultImageSize: '1K',
      defaultQuality: '',
      transparentBackground: false,
    };
  }

  private load(): AiImagePreferences {
    const defaults = this.defaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return defaults;
      }
      const parsed = JSON.parse(raw) as Partial<AiImagePreferences> | null;
      if (!parsed || typeof parsed !== 'object') {
        return defaults;
      }
      return {
        selectedProviderId:
          typeof parsed.selectedProviderId === 'string' &&
          this.registry.get(parsed.selectedProviderId)
            ? parsed.selectedProviderId
            : defaults.selectedProviderId,
        modelByProvider:
          parsed.modelByProvider && typeof parsed.modelByProvider === 'object'
            ? { ...(parsed.modelByProvider as Record<string, string>) }
            : {},
        defaultAspectRatio: isAspectRatio(parsed.defaultAspectRatio)
          ? parsed.defaultAspectRatio
          : defaults.defaultAspectRatio,
        defaultImageSize:
          typeof parsed.defaultImageSize === 'string'
            ? parsed.defaultImageSize
            : defaults.defaultImageSize,
        defaultQuality:
          typeof parsed.defaultQuality === 'string'
            ? parsed.defaultQuality
            : defaults.defaultQuality,
        transparentBackground:
          typeof parsed.transparentBackground === 'boolean'
            ? parsed.transparentBackground
            : defaults.transparentBackground,
      };
    } catch {
      return defaults;
    }
  }

  private persist(prefs: AiImagePreferences): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore persistence errors (private mode / quota)
    }
  }

  private notify(): void {
    const snapshot = this.getPreferences();
    this.listeners.forEach(listener => listener(snapshot));
  }
}
