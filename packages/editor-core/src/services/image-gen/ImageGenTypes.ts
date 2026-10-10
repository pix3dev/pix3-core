/**
 * Provider-agnostic contracts for AI image generation. New providers (OpenAI GPT Image, etc.)
 * implement {@link ImageGenProvider} and register in `ImageGenProviderRegistry`.
 */

/** 'Auto' lets the model choose (no aspectRatio sent); others map to Gemini imageConfig.aspectRatio. */
export type AspectRatio = 'Auto' | '1:1' | '3:4' | '4:3' | '16:9' | '9:16';

/**
 * Requested output background. Providers that advertise
 * {@link ImageModelCapabilities.supportsTransparency} can honour `'transparent'` and return a PNG
 * with a real alpha channel (no local background-removal pass needed). `'auto'` lets the model
 * decide; `'opaque'` forces a filled background.
 */
export type Background = 'auto' | 'transparent' | 'opaque';

/** A reference/input image, base64-encoded WITHOUT the `data:` URI prefix. */
export interface ReferenceImage {
  readonly mimeType: string;
  readonly data: string;
}

/** A generated output image, base64-encoded WITHOUT the `data:` URI prefix. */
export interface GeneratedImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface GenerateImageParams {
  readonly prompt: string;
  /** Absent/empty => text-to-image. Present => image+reference (edit) generation. */
  readonly references?: readonly ReferenceImage[];
  readonly aspectRatio?: AspectRatio;
  /** Provider-specific size hint (e.g. '1K' | '2K' | '4K' for Gemini). */
  readonly imageSize?: string;
  /** Provider-specific quality tier (e.g. 'low' | 'medium' | 'high' for OpenAI GPT Image). */
  readonly quality?: string;
  /**
   * Desired output background. Only honoured by providers whose selected model advertises
   * {@link ImageModelCapabilities.supportsTransparency}; ignored otherwise.
   */
  readonly background?: Background;
  readonly outputMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Number of images to request. Providers may clamp to their `maxCount`. */
  readonly count?: number;
  readonly signal?: AbortSignal;
}

export interface ImageGenResult {
  readonly images: GeneratedImage[];
  /** Raw provider payload, retained for debugging. */
  readonly raw?: unknown;
}

export interface ImageModelCapabilities {
  readonly supportsReferenceImages: boolean;
  readonly maxReferenceImages: number;
  readonly aspectRatios: readonly AspectRatio[];
  readonly imageSizes: readonly string[];
  /**
   * Provider-specific quality tiers (e.g. `['low', 'medium', 'high']`). Empty/omitted means the
   * model exposes no quality knob and the UI hides the control.
   */
  readonly qualities?: readonly string[];
  readonly maxCount: number;
  /** True when the model can emit a transparent alpha channel directly (skips local bg-removal). */
  readonly supportsTransparency: boolean;
  /** True when direct browser calls are blocked by CORS and a same-origin proxy is required. */
  readonly requiresProxy: boolean;
}

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /**
   * Short price tag rendered next to the label in every model picker (e.g. `'$0.039/img'`,
   * `'8 cr'`). A display string rather than a number because providers meter differently — dollars
   * per output image for direct APIs, credits for aggregators — and because it is a hand-maintained
   * snapshot, not something the API reports. Omit it when the price is not a single figure (e.g.
   * OpenAI, where it depends on the quality tier).
   */
  readonly price?: string;
  readonly capabilities: ImageModelCapabilities;
}

/**
 * Option text for a model picker. Shared by the Generate panel and the settings dialog so both
 * spell the price the same way; a `<option>` renders plain text only, hence the interpunct instead
 * of separate markup.
 */
export const modelPickerLabel = (model: ProviderModel): string =>
  model.price ? `${model.label} · ${model.price}` : model.label;

/**
 * How a provider reaches its API: POST `path` (relative to the provider's API origin, e.g.
 * `v1beta/models/<m>:generateContent`) through the dev server's proxy, which adds the key
 * (`EditorHost.imageGen.fetch`, plan §B.1). The page never holds a key.
 */
export type ImageGenTransport = (path: string, init: RequestInit) => Promise<Response>;

/** Per-request context supplied by the caller. */
export interface RequestContext {
  readonly modelId: string;
  readonly transport: ImageGenTransport;
}

export interface ImageGenProvider {
  readonly label: string;
  readonly models: readonly ProviderModel[];
  /** Matches the dev server's key store and proxy route (`/__pix3/api/proxy/<id>/…`). */
  readonly id: 'gemini' | 'openai';
  /**
   * IndexedDB id the 1.x / early-2.x editor kept this provider's key under in the
   * browser; read once to move the key to the dev server (`AiImageSettingsService`), then deleted.
   */
  readonly apiKeySecretId: string;
  /** Where a user obtains an API key (shown in settings). */
  readonly apiKeyHelpUrl?: string;
  getModel(modelId: string): ProviderModel | undefined;
  generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult>;
}

export type ImageGenErrorKind =
  | 'missing-key'
  | 'network'
  | 'http'
  | 'blocked'
  | 'empty'
  | 'aborted'
  | 'unknown';

/** User-facing image generation error carrying a machine-readable kind. */
export class ImageGenError extends Error {
  constructor(
    readonly kind: ImageGenErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ImageGenError';
  }
}

/**
 * The dev server's own refusal (`{error: '<code>', message}` — a provider's error body has an
 * object under `error`), as an {@link ImageGenError}, or null for anything else.
 */
export const proxyFailure = (payload: unknown, status: number): ImageGenError | null => {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { error?: unknown; message?: unknown };
  if (typeof body.error !== 'string') return null;
  const message = typeof body.message === 'string' ? body.message : `HTTP ${status}`;
  return new ImageGenError(body.error === 'no_key' ? 'missing-key' : 'http', message, status);
};
