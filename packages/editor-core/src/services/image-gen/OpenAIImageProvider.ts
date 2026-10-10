import {
  ImageGenError,
  proxyFailure,
  type AspectRatio,
  type Background,
  type GenerateImageParams,
  type GeneratedImage,
  type ImageGenProvider,
  type ImageGenResult,
  type ProviderModel,
  type RequestContext,
} from './ImageGenTypes';

/**
 * API version prefix under the provider's origin (the proxy forwards `v1/images/…`). OpenAI sends
 * no CORS headers, so a browser could never call it directly anyway; the dev server's proxy adds
 * the `Authorization` header (plan §B.1).
 */
const API_VERSION = 'v1';

const ASPECTS: readonly AspectRatio[] = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'];
const QUALITIES: readonly string[] = ['low', 'medium', 'high'];

/**
 * GPT Image supports only three pixel sizes plus `'auto'`. We derive the size from the requested
 * aspect ratio so the shared aspect-ratio UI drives it (there is no separate size knob).
 */
const sizeForAspect = (aspect?: AspectRatio): string => {
  switch (aspect) {
    case '1:1':
      return '1024x1024';
    case '3:4':
    case '9:16':
      return '1024x1536';
    case '4:3':
    case '16:9':
      return '1536x1024';
    default:
      return 'auto';
  }
};

/**
 * OpenAI GPT Image generation. Text-to-image hits `POST v1/images/generations` (JSON); when
 * reference images are attached it switches to `POST v1/images/edits` (multipart/form-data with
 * `image[]` parts). GPT Image can emit a real alpha channel directly (`background: 'transparent'`,
 * PNG output), so a transparent cutout needs no local background-removal pass. The API returns
 * base64 image bytes (`data[].b64_json`); there is no hosted-URL mode for these models.
 *
 * @see https://developers.openai.com/api/docs/guides/image-generation
 */
export class OpenAIImageProvider implements ImageGenProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI (GPT Image)';
  readonly apiKeySecretId = 'ai-provider:openai:api-key';
  readonly apiKeyHelpUrl = 'https://platform.openai.com/api-keys';

  readonly models: readonly ProviderModel[] = [
    {
      id: 'gpt-image-1.5',
      label: 'GPT Image 1.5',
      description: 'Flagship. Native transparent PNG, sharpest results.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 4,
        aspectRatios: ASPECTS,
        imageSizes: [],
        qualities: QUALITIES,
        maxCount: 1,
        supportsTransparency: true,
        requiresProxy: true,
      },
    },
    {
      id: 'gpt-image-1-mini',
      label: 'GPT Image 1 Mini',
      description: 'Cheapest lane — good for quick tests.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 4,
        aspectRatios: ASPECTS,
        imageSizes: [],
        qualities: QUALITIES,
        maxCount: 1,
        supportsTransparency: true,
        requiresProxy: true,
      },
    },
    {
      id: 'gpt-image-1',
      label: 'GPT Image 1 (legacy)',
      description: 'Original model — deprecating late 2026. Prefer 1.5.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 4,
        aspectRatios: ASPECTS,
        imageSizes: [],
        qualities: QUALITIES,
        maxCount: 1,
        supportsTransparency: true,
        requiresProxy: true,
      },
    },
  ];

  getModel(modelId: string): ProviderModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  async generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult> {
    const model = this.getModel(ctx.modelId);
    if (!model) {
      throw new ImageGenError('unknown', `Unknown OpenAI image model "${ctx.modelId}".`);
    }

    const size = sizeForAspect(params.aspectRatio);
    const quality =
      params.quality && model.capabilities.qualities?.includes(params.quality)
        ? params.quality
        : undefined;
    // Transparent output must be a format with an alpha channel; PNG is always safe.
    const background = resolveBackground(
      params.background,
      model.capabilities.supportsTransparency
    );
    const outputFormat = 'png';
    const count = Math.min(Math.max(params.count ?? 1, 1), model.capabilities.maxCount);
    const references = model.capabilities.supportsReferenceImages
      ? (params.references ?? []).slice(0, model.capabilities.maxReferenceImages)
      : [];

    let response: Response;
    try {
      response =
        references.length > 0
          ? await ctx.transport(`${API_VERSION}/images/edits`, {
              method: 'POST',
              body: buildEditForm({
                model: ctx.modelId,
                prompt: params.prompt,
                size,
                quality,
                background,
                outputFormat,
                count,
                references,
              }),
              signal: params.signal,
            })
          : await ctx.transport(`${API_VERSION}/images/generations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                stripUndefined({
                  model: ctx.modelId,
                  prompt: params.prompt,
                  n: count,
                  size,
                  quality,
                  background,
                  output_format: outputFormat,
                })
              ),
              signal: params.signal,
            });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ImageGenError('aborted', 'Image generation was cancelled.');
      }
      throw new ImageGenError(
        'network',
        'Network error reaching the dev server. Is it still running?',
        undefined,
        { cause: error }
      );
    }

    let payload: unknown;
    try {
      payload = await this.readJson(response);
    } catch (error) {
      if (isAbortError(error)) {
        throw new ImageGenError('aborted', 'Image generation was cancelled.');
      }
      throw new ImageGenError(
        'network',
        'Network error while reading the OpenAI response.',
        undefined,
        {
          cause: error,
        }
      );
    }

    if (!response.ok) {
      throw (
        proxyFailure(payload, response.status) ??
        new ImageGenError(
          'http',
          extractErrorMessage(payload) ?? describeStatus(response.status),
          response.status
        )
      );
    }

    const images = extractImages(payload, `image/${outputFormat}`);
    if (images.length === 0) {
      throw new ImageGenError('empty', 'The model returned no image. Try rephrasing the prompt.');
    }

    return { images, raw: payload };
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { rawText: text };
    }
  }
}

interface EditFormParams {
  model: string;
  prompt: string;
  size: string;
  quality?: string;
  background?: Background;
  outputFormat: string;
  count: number;
  references: readonly { mimeType: string; data: string }[];
}

/** Assemble the multipart body for the edits endpoint (reference images as `image[]` parts). */
const buildEditForm = (params: EditFormParams): FormData => {
  const form = new FormData();
  form.set('model', params.model);
  form.set('prompt', params.prompt);
  form.set('n', String(params.count));
  form.set('size', params.size);
  form.set('output_format', params.outputFormat);
  if (params.quality) {
    form.set('quality', params.quality);
  }
  if (params.background) {
    form.set('background', params.background);
  }
  params.references.forEach((reference, index) => {
    const blob = base64ToBlob(reference.data, reference.mimeType);
    form.append('image[]', blob, `reference-${index}.${extForMime(reference.mimeType)}`);
  });
  return form;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Drop keys whose value is `undefined` so we never send them in a JSON body. */
const stripUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key as keyof T] = value as T[keyof T];
    }
  }
  return out;
};

/** 'auto' is OpenAI's implicit default, so we omit it; only send an explicit override. */
const resolveBackground = (
  background: Background | undefined,
  supported: boolean
): Background | undefined => {
  if (!supported || !background || background === 'auto') {
    return undefined;
  }
  return background;
};

/** Collect base64 image bytes from an images response (`data[].b64_json`). */
const extractImages = (payload: unknown, mimeType: string): GeneratedImage[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }
  const collected: GeneratedImage[] = [];
  for (const entry of payload.data) {
    if (isRecord(entry) && typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
      collected.push({ mimeType, data: entry.b64_json });
    }
  }
  return collected;
};

const extractErrorMessage = (payload: unknown): string | null => {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return null;
};

const describeStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'Bad request to the OpenAI API. Check the prompt and parameters.';
    case 401:
    case 403:
      return 'Your OpenAI API key was rejected. Re-check the key or its permissions.';
    case 429:
      return 'Rate limit or quota reached. Check your OpenAI billing, then retry.';
    default:
      return `OpenAI API error (HTTP ${status}).`;
  }
};

const extForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};
