import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { GenerationRecord } from '@/services/image-gen/GenerationHistoryService';

import { GeneratePanel } from './generate-panel';

/**
 * The dockable Generate panel: prompt → provider → result block → save into the
 * project, plus the generation history. Everything that reaches IndexedDB, the
 * network or the project files is stubbed.
 */
const PNG_MIME = 'image/png';
/** One transparent pixel, base64 — what the fake provider "generates". */
const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function createModel() {
  return {
    id: 'fake-model',
    label: 'Fake Model',
    capabilities: {
      aspectRatios: ['Auto', '1:1'],
      imageSizes: ['1K'],
      qualities: [],
      supportsReferenceImages: true,
      maxReferenceImages: 6,
      supportsTransparency: false,
    },
  };
}

function createPreferences() {
  return {
    selectedProviderId: 'fake',
    modelByProvider: { fake: 'fake-model' },
    defaultAspectRatio: 'Auto' as const,
    defaultImageSize: '1K',
    defaultQuality: '',
    transparentBackground: false,
  };
}

interface PanelStubs {
  generate: ReturnType<typeof vi.fn>;
  transport: ReturnType<typeof vi.fn>;
  historyAdd: ReturnType<typeof vi.fn>;
  historyList: ReturnType<typeof vi.fn>;
  historyGet: ReturnType<typeof vi.fn>;
  writeBinaryFile: ReturnType<typeof vi.fn>;
}

function createPanel(records: GenerationRecord[] = []): {
  panel: GeneratePanel;
  stubs: PanelStubs;
} {
  const panel = new GeneratePanel();
  const model = createModel();
  const preferences = createPreferences();
  const generate = vi.fn().mockResolvedValue({
    images: [{ data: PIXEL_B64, mimeType: PNG_MIME }],
  });
  const provider = {
    id: 'fake',
    label: 'Fake',
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    apiKeySecretId: 'fake-key',
    apiKeyHelpUrl: undefined,
    generate,
  };
  const transport = vi.fn();
  const historyAdd = vi.fn().mockResolvedValue(undefined);
  const historyList = vi.fn().mockImplementation(async () => records);
  const historyGet = vi
    .fn()
    .mockImplementation(async (id: string) => records.find(record => record.id === id));
  const writeBinaryFile = vi.fn().mockResolvedValue(undefined);

  const stubs: Record<string, unknown> = {
    providers: {
      get: (id: string) => (id === 'fake' ? provider : undefined),
      list: () => [provider],
    },
    aiSettings: {
      getPreferences: () => ({ ...preferences }),
      getSelectedProvider: () => provider,
      getSelectedModelId: () => model.id,
      keyStatus: vi.fn().mockResolvedValue({ set: true, last4: 'abcd' }),
      transportFor: vi.fn().mockReturnValue(transport),
      subscribe: (listener: () => void) => {
        listener();
        return () => undefined;
      },
      updatePreferences: vi.fn(),
    },
    history: {
      subscribe: vi.fn().mockReturnValue(() => undefined),
      list: historyList,
      get: historyGet,
      add: historyAdd,
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    storage: { readBlob: vi.fn(), writeBinaryFile, createDirectory: vi.fn() },
    editorSettings: { showSettings: vi.fn() },
  };

  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return {
    panel,
    stubs: {
      generate,
      transport,
      historyAdd,
      historyList,
      historyGet,
      writeBinaryFile,
    },
  };
}

/** One stored generation, as `GenerationHistoryService.list()` would hand it back. */
function createHistoryRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: 'rec-1',
    providerId: 'fake',
    modelId: 'fake-model',
    prompt: 'A brass gear',
    aspectRatio: 'Auto',
    imageSize: '1K',
    mimeType: PNG_MIME,
    blob: new Blob([new Uint8Array([1])], { type: PNG_MIME }),
    width: 64,
    height: 64,
    createdAt: 0,
    ...overrides,
  };
}

async function mount(panel: GeneratePanel): Promise<void> {
  document.body.appendChild(panel);
  await panel.updateComplete;
}

/**
 * Type a prompt, hit Generate, and wait for the run to finish. The end marker is
 * `history.add` — the last step of the happy path — because the button label is
 * back to "Generate" both before the first render of the in-flight state and
 * after it, so it cannot be waited on.
 */
async function generate(panel: GeneratePanel, prompt: string, stubs: PanelStubs): Promise<void> {
  const textarea = panel.querySelector<HTMLTextAreaElement>('.gp-prompt');
  if (!textarea) {
    throw new Error('prompt textarea not rendered');
  }
  textarea.value = prompt;
  textarea.dispatchEvent(new Event('input'));
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>('.gp-generate-button')?.click();
  await vi.waitFor(() => {
    expect(stubs.historyAdd).toHaveBeenCalled();
  });
  await panel.updateComplete;
}

/**
 * happy-dom never fires `load`/`error` for an `<img>` pointed at a blob URL, and
 * the panel measures every generated image that way before it delivers it — left
 * alone, the whole generation chain simply parks. Shim the decode, not the panel.
 */
function stubImageDecoding(): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 64;
    naturalHeight = 64;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

describe('GeneratePanel', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    stubImageDecoding();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the prompt bar, generates, and saves the result into the project', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    expect(panel.querySelector('.gp-prompt')).not.toBeNull();

    await generate(panel, 'A brass gear', stubs);

    expect(stubs.generate).toHaveBeenCalledTimes(1);
    // The provider gets the dev server's proxy, never a key.
    expect(stubs.generate.mock.calls[0][1]).toEqual({
      modelId: 'fake-model',
      transport: stubs.transport,
    });
    expect(stubs.historyAdd).toHaveBeenCalledTimes(1);

    const nameInput = panel.querySelector<HTMLInputElement>('.gp-result-name');
    expect(nameInput).not.toBeNull();
    expect(nameInput?.value).toBe('sprites/generated/a-brass-gear.png');

    panel.querySelectorAll<HTMLButtonElement>('.gp-result-actions button')[0]?.click();
    await vi.waitFor(() => {
      expect(stubs.writeBinaryFile).toHaveBeenCalledTimes(1);
    });
    expect(stubs.writeBinaryFile.mock.calls[0][0]).toBe('sprites/generated/a-brass-gear.png');
  });

  it('brings a history entry back as the result, with its prompt', async () => {
    const record = createHistoryRecord();
    const { panel } = createPanel([record]);
    await mount(panel);

    await vi.waitFor(() => {
      expect(panel.querySelector('.gp-history-thumb')).not.toBeNull();
    });
    expect(panel.querySelector('.gp-result')).toBeNull();

    panel.querySelector<HTMLButtonElement>('.gp-history-thumb')?.click();
    await panel.updateComplete;

    expect(panel.querySelector('.gp-result')).not.toBeNull();
    expect(panel.querySelector<HTMLInputElement>('.gp-result-name')?.value).toBe(
      'sprites/generated/a-brass-gear.png'
    );
    expect(panel.querySelector<HTMLTextAreaElement>('.gp-prompt')?.value).toBe('A brass gear');
  });

  it('re-mints history thumbnails after a Golden Layout re-dock', async () => {
    const record = {
      id: 'rec-1',
      providerId: 'fake',
      modelId: 'fake-model',
      prompt: 'A brass gear',
      aspectRatio: 'Auto',
      imageSize: '1K',
      mimeType: PNG_MIME,
      blob: new Blob([new Uint8Array([1])], { type: PNG_MIME }),
      createdAt: 0,
    } as GenerationRecord;
    const { panel } = createPanel([record]);
    await mount(panel);

    await vi.waitFor(() => {
      expect(panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src).toBeTruthy();
    });
    const before = panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src;

    // Golden Layout destroys and recreates a panel on dock/undock; disconnect
    // revoked every object URL it owned.
    panel.remove();
    const urls = (panel as unknown as { historyUrls: Map<string, string> }).historyUrls;
    expect(urls.size).toBe(0);

    await mount(panel);
    // The thumbnail comes back pointing at a freshly minted URL, not the revoked one.
    await vi.waitFor(() => {
      expect(urls.size).toBe(1);
      expect(panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src).toBe(
        urls.get('rec-1')
      );
    });
    expect(before).toBeTruthy();
    expect(urls.get('rec-1')).not.toBe(before);
  });
});
