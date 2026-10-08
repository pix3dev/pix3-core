import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * HTTP primitives of `/__pix3/api/*` (port of `packages/cli/src/server/http.ts`). Errors are always
 * `{ error: <code>, message, ...extra }` JSON, the shape the editor's `WorkspaceClient` parses.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

export const readBody = (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'too_large', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export const readJson = async (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES
): Promise<Record<string, unknown>> => {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_json', 'Body must be a JSON object.');
};

export const headerValue = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return null;
};

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): void => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
};

export const errnoCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

export const errorBody = (error: unknown): { status: number; body: Record<string, unknown> } =>
  error instanceof HttpError
    ? { status: error.status, body: { error: error.code, message: error.message, ...error.extra } }
    : { status: 500, body: { error: 'internal', message: 'Internal error.' } };
