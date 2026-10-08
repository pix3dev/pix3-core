import type { PlayModeError } from '@/state/AppState';

/**
 * "Copy for agent": 2.x has no in-editor agent chat — the coding agent (Codex, Claude Code) lives
 * in the developer's terminal and drives this tab through DevTools. The editor's part is to put a
 * self-contained prompt on the clipboard, written against the debug bridge the agent can call.
 */

const BRIDGE_HINT =
  'The editor tab exposes `window.__PIX3_DEBUG__` (DevTools): `errors()` has the full stack, ' +
  '`scene()` / `node(id)` the state; after the fix run `sync()` and `play.start()` to verify.';

/** Prompt for a runtime error raised while playing the scene. */
export const buildPlayModeErrorPrompt = (error: PlayModeError): string => {
  const lines = ['A runtime error occurred while playing the scene. Investigate and fix it.', ''];
  lines.push(`Error: ${error.message}`);
  if (error.phase) {
    lines.push(`Phase: ${error.phase}`);
  }
  if (error.nodeName) {
    lines.push(
      error.componentType
        ? `Node: ${error.nodeName} (component ${error.componentType})`
        : `Node: ${error.nodeName}`
    );
  } else if (error.componentType) {
    lines.push(`Component: ${error.componentType}`);
  }
  lines.push('', BRIDGE_HINT);
  return lines.join('\n');
};

/** Prompt for an error line of the Logs panel. */
export const buildLogErrorPrompt = (level: string, message: string, details: string): string =>
  [
    'Fix this error reported in the Pix3 editor logs. Investigate the root cause and fix it.',
    '',
    `[${level.toUpperCase()}] ${message}`,
    ...(details ? ['', details] : []),
    '',
    BRIDGE_HINT,
  ].join('\n');

/** Put `text` on the clipboard; false when the browser refused (no focus, no permission). */
export const copyTextForAgent = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('[copy-for-agent] Clipboard write failed', error);
    return false;
  }
};
