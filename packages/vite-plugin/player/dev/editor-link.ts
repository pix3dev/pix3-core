/**
 * The "Pix3 editor" link over the game in dev (`virtual:pix3/dev`; not on `?clean`, not in a
 * frame, not in a build). A second editor tab would open read-only (the writer lock), so the link
 * first asks over a `BroadcastChannel` whether an editor of this dev server is open: if one
 * answers, the page says so and tries to bring its opener forward; if none does, this tab becomes
 * the editor. The editor answers in `packages/editor-core/src/host/editor-presence.ts`.
 */

/** Keep in step with `editor-presence.ts` in editor-core. */
export const EDITOR_PRESENCE_CHANNEL = 'pix3-editor-presence';
const ANSWER_MS = 300;
const HIDDEN_KEY = 'pix3:editor-link:hidden';

export type OpenEditorOutcome = 'navigated' | 'already-open';

/** True when an editor tab of this origin answers within {@link ANSWER_MS}. */
export const isEditorOpen = (timeoutMs = ANSWER_MS): Promise<boolean> =>
  new Promise(resolve => {
    if (typeof BroadcastChannel === 'undefined') {
      resolve(false);
      return;
    }
    const channel = new BroadcastChannel(EDITOR_PRESENCE_CHANNEL);
    const id = Math.random().toString(36).slice(2);
    const done = (open: boolean): void => {
      clearTimeout(timer);
      channel.close();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = event => {
      const data = event.data as { type?: unknown; id?: unknown } | null;
      if (data?.type === 'pong' && data.id === id) done(true);
    };
    channel.postMessage({ type: 'ping', id });
  });

/** Go to the editor: this tab becomes it, unless one is already open. */
export const openEditor = async (editorUrl: string): Promise<OpenEditorOutcome> => {
  if (await isEditorOpen()) {
    try {
      // The editor opened this page (Play in Browser Tab / with Profiler): it is the opener.
      window.opener?.focus();
    } catch {
      // A cross-origin or severed opener: nothing to focus.
    }
    return 'already-open';
  }
  window.location.href = editorUrl;
  return 'navigated';
};

const STYLE = `
:host { all: initial; }
.link {
  position: fixed; left: 8px; bottom: 8px; z-index: 2147483646;
  display: flex; align-items: center; gap: 2px;
  font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8e8e8; background: rgba(18, 18, 20, 0.72); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 999px; padding: 2px; opacity: 0.55; transition: opacity 120ms ease;
}
.link:hover, .link:focus-within { opacity: 1; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer;
  border-radius: 999px; display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; }
button:hover { background: rgba(255,255,255,0.1); }
button:focus-visible { outline: 2px solid rgba(255,207,51,0.6); }
.close { padding: 4px; }
svg { display: block; width: 12px; height: 12px; }
.note { padding: 4px 8px 4px 4px; color: #ffcf33; font-weight: 500; }
`;

// Feather `edit-3` and `x`, inline: the player has no IconService.
const EDIT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const isHidden = (): boolean => {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};

/** Mount the link; returns the teardown. Hidden for the rest of the tab's session by its close button. */
export function mountEditorLink(editorUrl: string): () => void {
  if (isHidden()) return () => undefined;
  const host = document.createElement('div');
  host.className = 'pix3-editor-link';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
<div class="link" part="link">
  <button type="button" data-action="open" title="Open this project in the Pix3 editor">${EDIT_ICON}<span>Pix3 editor</span></button>
  <span class="note" hidden>Already open in another tab</span>
  <button type="button" class="close" data-action="hide" title="Hide" aria-label="Hide the editor link">${CLOSE_ICON}</button>
</div>`;
  const link = root.querySelector('.link') as HTMLElement;
  const note = root.querySelector('.note') as HTMLElement;
  // Keep the game's own listeners out of the link's clicks.
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
    link.addEventListener(type, event => event.stopPropagation());
  }
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener('click', event => {
    const action = (event.target as Element | null)
      ?.closest('[data-action]')
      ?.getAttribute('data-action');
    if (action === 'hide') {
      try {
        sessionStorage.setItem(HIDDEN_KEY, '1');
      } catch {
        // Hidden for this page only.
      }
      host.remove();
    } else if (action === 'open') {
      void openEditor(editorUrl).then(outcome => {
        if (outcome !== 'already-open') return;
        note.hidden = false;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => (note.hidden = true), 3000);
      });
    }
  });
  document.body.appendChild(host);
  return () => {
    clearTimeout(noteTimer);
    host.remove();
  };
}
