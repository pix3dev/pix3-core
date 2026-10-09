/**
 * `EditorHost.files` over `/__pix3/api/*` (`.plans/editor-core-port.md` §1.2). A failed call
 * rejects with an `Error` carrying `failure: {code, status, message, currentHash?}` — the shape
 * `@pix3/editor-core`'s `hostFailureOf` reads.
 */

export type HostFileErrorCode =
  | 'not_found'
  | 'base_mismatch'
  | 'exists'
  | 'writer_superseded'
  | 'reserved_path'
  | 'bad_path'
  | 'not_a_file'
  | 'not_empty'
  | 'forbidden'
  | 'network'
  | 'other';

export interface HostFileFailure {
  readonly code: HostFileErrorCode;
  readonly status: number;
  /** The file a changeset failed on. */
  readonly path?: string;
  readonly currentHash?: string | null;
  readonly message: string;
}

export interface HostManifestEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly size: number;
  readonly mtime: number;
  readonly sha256?: string;
}

export interface HostWriteOptions {
  readonly ifMatch?: string;
  readonly createOnly?: boolean;
  readonly mutationId?: string;
}

export interface HostChangesetEntry {
  readonly path: string;
  readonly data: Uint8Array | string;
  readonly ifMatch?: string;
  readonly createOnly?: boolean;
}

export interface HostWriteResult {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly seq: number;
  readonly mtime?: number;
}

export interface HostChangesetResult {
  readonly seq: number;
  readonly files: readonly HostWriteResult[];
}

/** What the files client needs from the connection. */
export interface ApiCaller {
  readonly base: string;
  api(route: string, init?: RequestInit): Promise<Response>;
}

const KNOWN_CODES = new Set<string>([
  'not_found',
  'base_mismatch',
  'exists',
  'writer_superseded',
  'reserved_path',
  'bad_path',
  'not_a_file',
  'not_empty',
]);

export class HostFileError extends Error {
  readonly failure: HostFileFailure;
  constructor(failure: HostFileFailure) {
    super(failure.message);
    this.name = 'HostFileError';
    this.failure = failure;
  }
}

export const failureOf = async (response: Response): Promise<HostFileError> => {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const raw = typeof body.error === 'string' ? body.error : '';
  const code: HostFileErrorCode = KNOWN_CODES.has(raw)
    ? (raw as HostFileErrorCode)
    : response.status === 403
      ? 'forbidden'
      : response.status === 404
        ? 'not_found'
        : 'other';
  return new HostFileError({
    code,
    status: response.status,
    message: typeof body.message === 'string' ? body.message : `HTTP ${response.status}`,
    ...(typeof body.path === 'string' ? { path: body.path } : {}),
    ...('currentHash' in body ? { currentHash: (body.currentHash as string | null) ?? null } : {}),
  });
};

export const networkError = (error: unknown): HostFileError =>
  new HostFileError({
    code: 'network',
    status: 0,
    message: `The dev server did not answer: ${error instanceof Error ? error.message : String(error)}`,
  });

/** Bytes as base64 without `Buffer` (this runs in the page); chunked to stay off the arg limit. */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const etagOf = (response: Response): string =>
  (response.headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');

const q = (path: string): string => `file?path=${encodeURIComponent(path)}`;

export class HostFilesClient {
  private readonly caller: ApiCaller;

  constructor(caller: ApiCaller) {
    this.caller = caller;
  }

  private async call(route: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.caller.api(route, init);
    } catch (error) {
      throw networkError(error);
    }
  }

  private async json(route: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.call(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failureOf(response);
    return (await response.json()) as Record<string, unknown>;
  }

  async read(path: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
    const response = await this.call(q(path));
    if (response.status === 404) return null;
    if (!response.ok) throw await failureOf(response);
    return { bytes: new Uint8Array(await response.arrayBuffer()), sha256: etagOf(response) };
  }

  async readText(path: string): Promise<string | null> {
    const read = await this.read(path);
    return read ? new TextDecoder().decode(read.bytes) : null;
  }

  async head(path: string): Promise<{ sha256: string; size: number } | null> {
    const response = await this.call(q(path), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw await failureOf(response);
    return { sha256: etagOf(response), size: Number(response.headers.get('content-length') ?? 0) };
  }

  async write(
    path: string,
    data: Uint8Array | string,
    options: HostWriteOptions = {}
  ): Promise<{ path: string; sha256: string; size: number; seq: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (options.ifMatch)
      headers['If-Match'] = options.ifMatch === '*' ? '*' : `"${options.ifMatch}"`;
    if (options.createOnly) headers['If-None-Match'] = '*';
    if (options.mutationId) headers['X-Mutation-Id'] = options.mutationId;
    const response = await this.call(q(path), {
      method: 'PUT',
      headers,
      body: typeof data === 'string' ? data : (data as BodyInit),
    });
    if (!response.ok) throw await failureOf(response);
    const body = (await response.json()) as {
      path: string;
      sha256: string;
      size: number;
      seq: number;
    };
    return body;
  }

  /**
   * Several files as one transaction (plan §C.4). A refusal names the file in `failure.path`;
   * nothing was written then.
   */
  async writeChangeset(
    entries: readonly HostChangesetEntry[],
    options: { mutationId?: string } = {}
  ): Promise<HostChangesetResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.mutationId) headers['X-Mutation-Id'] = options.mutationId;
    const files = entries.map(entry => ({
      path: entry.path,
      ...(typeof entry.data === 'string' ? { text: entry.data } : { base64: toBase64(entry.data) }),
      ...(entry.ifMatch ? { ifMatch: entry.ifMatch } : {}),
      ...(entry.createOnly ? { createOnly: true } : {}),
    }));
    const response = await this.call('changeset', {
      method: 'POST',
      headers,
      body: JSON.stringify({ files }),
    });
    if (!response.ok) throw await failureOf(response);
    return (await response.json()) as HostChangesetResult;
  }

  async mkdir(path: string): Promise<void> {
    await this.json('mkdir', { path });
  }

  async delete(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.json('delete', { path, recursive: options.recursive === true });
  }

  async move(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<void> {
    await this.json('move', { from, to, overwrite: options.overwrite === true });
  }

  async manifest(): Promise<{ revision: string; seq: number; files: HostManifestEntry[] }> {
    const response = await this.call('manifest');
    if (!response.ok) throw await failureOf(response);
    return (await response.json()) as { revision: string; seq: number; files: HostManifestEntry[] };
  }

  async hash(paths: readonly string[]): Promise<Record<string, string | null>> {
    const body = await this.json('hash', { paths });
    return body.hashes as Record<string, string | null>;
  }

  url(path: string): string {
    return `${this.caller.base}${path.split('/').map(encodeURIComponent).join('/')}`;
  }
}
