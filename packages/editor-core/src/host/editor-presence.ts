/**
 * Answers the game page's "is an editor open?" (`@pix3/vite-plugin`'s `player/dev/editor-link.ts`,
 * the "Pix3 editor" link over the game in dev): a second editor tab would open read-only behind
 * the writer lock, so the link only turns its own tab into the editor when no tab answers.
 * Same-origin by construction — one dev server, one channel.
 */

/** Keep in step with `EDITOR_PRESENCE_CHANNEL` in the plugin's `player/dev/editor-link.ts`. */
export const EDITOR_PRESENCE_CHANNEL = 'pix3-editor-presence';

/** Start answering; returns the disposer. A browser without `BroadcastChannel` answers nothing. */
export function installEditorPresence(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(EDITOR_PRESENCE_CHANNEL);
  channel.onmessage = event => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (data?.type === 'ping') channel.postMessage({ type: 'pong', id: data.id });
  };
  return () => channel.close();
}
