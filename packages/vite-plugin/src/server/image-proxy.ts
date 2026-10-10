import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError, readBytes, readJson, sendJson } from './http.ts';
import { isImageProvider, type ImageKeyStore, type ImageProvider } from './image-keys.ts';

/**
 * `/__pix3/api/keys` and `/__pix3/api/proxy/{gemini,openai}/…` (plan §B.1 «Ключи генерации
 * картинок»). The editor's Generate panel calls the providers through here; the plugin adds the
 * key from {@link ImageKeyStore}, so the page never holds it. Only the two generation endpoints
 * the panel uses are forwarded — the key is not a general-purpose credential for the page.
 * Who may call is the router's business (`RequestGuard.checkEditorOnly`).
 *
 * The key never leaves this module: responses and logs carry the provider, the path, the status
 * and the size; an upstream answer that happens to contain the key gets it replaced by `[key]`.
 */

export const DEFAULT_UPSTREAMS: Readonly<Record<ImageProvider, string>> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com',
};

/** Env overrides of the upstream origins (a local mock in an e2e run). */
export const UPSTREAM_ENV: Readonly<Record<ImageProvider, string>> = {
  gemini: 'PIX3_PROXY_GEMINI_URL',
  openai: 'PIX3_PROXY_OPENAI_URL',
};

/** The upstream paths a provider may be called on (relative to its origin, no leading `/`). */
const ALLOWED_PATHS: Readonly<Record<ImageProvider, RegExp>> = {
  gemini: /^v1(beta)?\/models\/[A-Za-z0-9._-]+:generateContent$/,
  openai: /^v1\/images\/(generations|edits)$/,
};

/** Reference images ride in the body as base64 / multipart. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 5 * 60_000;

export interface ImageProxyDeps {
  readonly keys: ImageKeyStore;
  readonly upstreams: Readonly<Record<ImageProvider, string>>;
  readonly log: (line: string) => void;
  /** For specs; the global `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch;
}

const authHeaders = (provider: ImageProvider, key: string): Record<string, string> =>
  provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };

const KEY_HINT = 'Set it in the Generate panel (the key icon) or in Editor Settings → AI Images.';

export class ImageProxy {
  private readonly deps: ImageProxyDeps;

  constructor(deps: ImageProxyDeps) {
    this.deps = deps;
  }

  /** `GET /__pix3/api/keys` → `{keys: {gemini: {set, last4?}, openai: …}}`. */
  async keyStatus(res: ServerResponse): Promise<void> {
    sendJson(res, 200, { keys: await this.deps.keys.status() });
  }

  /** `PUT /__pix3/api/keys` `{provider, key}` (`key: null` or `''` removes) → the new status only. */
  async setKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, 16 * 1024);
    if (!isImageProvider(body.provider)) {
      throw new HttpError(400, 'bad_provider', '`provider` must be "gemini" or "openai".');
    }
    if (body.key !== null && typeof body.key !== 'string') {
      throw new HttpError(400, 'bad_key', '`key` must be a string, or null to remove it.');
    }
    if (typeof body.key === 'string' && /[\s\0]/.test(body.key.trim())) {
      throw new HttpError(400, 'bad_key', 'An API key has no spaces or control characters.');
    }
    const { status, where } = await this.deps.keys.set(body.provider, body.key);
    this.deps.log(`image-gen: ${body.provider} key ${status.set ? 'set' : 'removed'} (${where})`);
    sendJson(res, 200, { provider: body.provider, ...status, where });
  }

  /** `POST /__pix3/api/proxy/<provider>/<path>` → the upstream's answer, the key added. */
  async forward(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
    const slash = rest.indexOf('/');
    const provider = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash + 1);
    if (!isImageProvider(provider)) {
      throw new HttpError(404, 'not_found', 'Unknown image provider.');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only.');
    if (!ALLOWED_PATHS[provider].test(path)) {
      throw new HttpError(
        403,
        'path_not_allowed',
        `The ${provider} proxy forwards image generation only.`
      );
    }
    const key = await this.deps.keys.key(provider);
    if (!key) {
      req.resume();
      throw new HttpError(409, 'no_key', `No ${provider} API key on this machine. ${KEY_HINT}`);
    }
    const body = await readBytes(req, MAX_REQUEST_BYTES);
    const headers: Record<string, string> = authHeaders(provider, key);
    const contentType = req.headers['content-type'];
    if (typeof contentType === 'string') headers['Content-Type'] = contentType;

    const target = `${this.deps.upstreams[provider].replace(/\/+$/, '')}/${path}`;
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
    // The editor's Cancel (or a closed tab) aborts the upstream call too.
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let upstream: Response;
    let bytes: Buffer;
    try {
      upstream = await (this.deps.fetchImpl ?? fetch)(target, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
      });
      bytes = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      const reason = abort.signal.aborted ? 'aborted' : 'unreachable';
      this.deps.log(`image-gen: ${provider} ${path} → ${reason} (${Date.now() - started} ms)`);
      throw new HttpError(
        502,
        'upstream_unreachable',
        `The ${provider} API did not answer (${reason}): ${scrub(describe(error), key)}`
      );
    } finally {
      clearTimeout(timer);
    }
    const scrubbed = scrubBuffer(bytes, key);
    this.deps.log(
      `image-gen: ${provider} ${path} → ${upstream.status} (${scrubbed.length} bytes, ` +
        `${Date.now() - started} ms)`
    );
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(scrubbed);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ''}`
    : String(error);

const scrub = (text: string, key: string): string => text.split(key).join('[key]');

const scrubBuffer = (bytes: Buffer, key: string): Buffer =>
  bytes.includes(key) ? Buffer.from(scrub(bytes.toString('utf8'), key), 'utf8') : bytes;
