import { readFileSync } from 'node:fs';

import { devJsonPath, type DevInfo } from '../dev-info.ts';

/**
 * Before a build reads the disk (plan §B.6 «npm run build, pix3 check, pix3 smoke»): if
 * `.pix3/dev.json` points at a live dev server, ask it to flush the editor's unsaved scenes first
 * (`POST /__pix3/api/flush`, up to {@link FLUSH_TIMEOUT_MS}). A server that does not answer is
 * treated as gone (a stale `dev.json` after a crash); an editor that cannot flush in time is
 * `E_EDITOR_UNSYNCED` — the build would otherwise ship a scene older than what the designer sees.
 *
 * `PIX3_NO_SYNC=1` skips the step (the CLI's `--no-sync`). The CLI carries its own copy of this logic
 * (`packages/cli/src/editor-sync.ts`); keep the two in step.
 */

export const FLUSH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;

export type EditorFlushResult =
  | { readonly status: 'skipped' }
  | { readonly status: 'no-server' }
  | { readonly status: 'no-editor'; readonly url: string }
  | { readonly status: 'flushed'; readonly url: string };

export class EditorUnsyncedError extends Error {
  readonly code = 'E_EDITOR_UNSYNCED';
  constructor(message: string) {
    super(message);
    this.name = 'EditorUnsyncedError';
  }
}

const readDevInfo = (root: string): DevInfo | null => {
  try {
    const parsed = JSON.parse(readFileSync(devJsonPath(root), 'utf8')) as Partial<DevInfo>;
    return typeof parsed.url === 'string' ? (parsed as DevInfo) : null;
  } catch {
    return null;
  }
};

const fetchWithTimeout = (url: string, init: RequestInit, timeoutMs: number): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

/**
 * Flush the editor that `.pix3/dev.json` points at, if any. Throws {@link EditorUnsyncedError}
 * when an editor is connected but did not confirm the flush in time.
 */
export const flushEditorBeforeBuild = async (
  root: string,
  options: { readonly skip?: boolean; readonly timeoutMs?: number } = {}
): Promise<EditorFlushResult> => {
  if (options.skip ?? process.env.PIX3_NO_SYNC === '1') return { status: 'skipped' };
  const info = readDevInfo(root);
  if (!info) return { status: 'no-server' };
  const timeoutMs = options.timeoutMs ?? FLUSH_TIMEOUT_MS;
  const api = `${info.url.endsWith('/') ? info.url : `${info.url}/`}__pix3/api/`;
  try {
    const hello = await fetchWithTimeout(`${api}hello`, {}, PROBE_TIMEOUT_MS);
    if (!hello.ok) return { status: 'no-server' };
  } catch {
    return { status: 'no-server' };
  }
  let reply: { ok?: boolean; editor?: boolean; flushed?: boolean; reason?: string };
  try {
    const response = await fetchWithTimeout(
      `${api}flush`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pix3': '1' },
        body: JSON.stringify({ timeoutMs }),
      },
      timeoutMs + PROBE_TIMEOUT_MS
    );
    reply = (await response.json()) as typeof reply;
  } catch (error) {
    throw new EditorUnsyncedError(
      `The Pix3 editor at ${info.url} did not confirm the flush of its unsaved scenes within ` +
        `${Math.round(timeoutMs / 1000)} s (${error instanceof Error ? error.message : String(error)}). ` +
        `Save in the editor and retry, or skip with PIX3_NO_SYNC=1.`
    );
  }
  if (reply.ok === false) {
    throw new EditorUnsyncedError(
      `The Pix3 editor at ${info.url} could not flush its unsaved scenes (${reply.reason ?? 'unknown'}). ` +
        `Save in the editor and retry, or skip with PIX3_NO_SYNC=1.`
    );
  }
  return reply.editor
    ? { status: 'flushed', url: info.url }
    : { status: 'no-editor', url: info.url };
};
