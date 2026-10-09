import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Before `pix3 check` / `pix3 smoke` read the project (plan §B.6 «npm run build, pix3 check,
 * pix3 smoke»): if `.pix3/dev.json` points at a live dev server, ask it to flush the editor's
 * unsaved scenes first (`POST /__pix3/api/flush`, up to {@link EDITOR_FLUSH_TIMEOUT_MS}). A
 * server that does not answer is treated as gone (a stale `dev.json`); an editor that cannot
 * flush in time is `E_EDITOR_UNSYNCED`, because the check would otherwise judge a scene older
 * than what the designer sees. `--no-sync` skips the step.
 *
 * Same logic as the plugin's `src/build/editor-flush.ts` (which `vite build` runs); keep the two
 * in step.
 */

export const EDITOR_FLUSH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;
export const E_EDITOR_UNSYNCED = 'E_EDITOR_UNSYNCED';

export type EditorSyncResult =
  | { readonly status: 'skipped' }
  | { readonly status: 'no-server' }
  | { readonly status: 'no-editor'; readonly url: string }
  | { readonly status: 'flushed'; readonly url: string }
  | { readonly status: 'unsynced'; readonly url: string; readonly reason: string };

const devServerUrl = (projectRoot: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, '.pix3', 'dev.json'), 'utf8')) as {
      url?: unknown;
    };
    return typeof parsed.url === 'string' ? parsed.url : null;
  } catch {
    return null;
  }
};

/** Flush the editor that `.pix3/dev.json` points at, if any. Never throws. */
export const syncEditor = async (
  projectRoot: string,
  options: { readonly noSync?: boolean; readonly timeoutMs?: number } = {}
): Promise<EditorSyncResult> => {
  if (options.noSync) return { status: 'skipped' };
  const url = devServerUrl(projectRoot);
  if (!url) return { status: 'no-server' };
  const timeoutMs = options.timeoutMs ?? EDITOR_FLUSH_TIMEOUT_MS;
  const api = `${url.endsWith('/') ? url : `${url}/`}__pix3/api/`;
  try {
    const hello = await fetch(`${api}hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!hello.ok) return { status: 'no-server' };
  } catch {
    return { status: 'no-server' };
  }
  try {
    const response = await fetch(`${api}flush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pix3': '1' },
      body: JSON.stringify({ timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + PROBE_TIMEOUT_MS),
    });
    const reply = (await response.json()) as {
      ok?: boolean;
      editor?: boolean;
      reason?: string;
    };
    if (reply.ok === false) {
      return { status: 'unsynced', url, reason: reply.reason ?? `HTTP ${response.status}` };
    }
    return reply.editor ? { status: 'flushed', url } : { status: 'no-editor', url };
  } catch (error) {
    return {
      status: 'unsynced',
      url,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** The one-line explanation of an `unsynced` result. */
export const describeUnsynced = (
  result: Extract<EditorSyncResult, { status: 'unsynced' }>
): string =>
  `the Pix3 editor at ${result.url} did not flush its unsaved scenes (${result.reason}); ` +
  `save in the editor and retry, or pass --no-sync to read the disk as it is`;
