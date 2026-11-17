/**
 * The "Pix3 editor" link over the game in dev (`virtual:pix3/dev`; not on `?clean`, not in a
 * frame, not in a build). A second editor tab would open read-only (the writer lock), so the link
 * first asks over a `BroadcastChannel` whether an editor of this dev server is open: if one
 * answers, the page says so and tries to bring its opener forward; if none does, this tab becomes
 * the editor. The editor answers in `packages/editor-core/src/host/editor-presence.ts`.
 *
 * Its chevron opens a menu (upward: the link sits in the bottom corner) of other ways in —
 * {@link MENU_ITEMS}, today the profiler (this page again with `?debug`).
 */

/** Keep in step with `editor-presence.ts` in editor-core. */
export const EDITOR_PRESENCE_CHANNEL = 'pix3-editor-presence';
const ANSWER_MS = 300;
const HIDDEN_KEY = 'pix3:editor-link:hidden';

export type OpenEditorOutcome = 'navigated' | 'already-open';

/** True when an editor tab of this origin answers within {@link ANSWER_MS}. */
export const isEditorOpen = (timeoutMs: number = ANSWER_MS): Promise<boolean> =>
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

/** This page's URL with the debug overlay on (`?debug`, bare like the editor's Play with Profiler). */
export const profilerUrl = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete('debug');
  const rest = url.searchParams.toString();
  url.search = rest ? `?debug&${rest}` : '?debug';
  return url.href;
};

interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly icon: string;
  readonly run: () => void;
}

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
.more { padding: 4px 5px; }
.more[aria-expanded="true"] { background: rgba(255,255,255,0.14); }
.more[aria-expanded="true"] svg { transform: rotate(180deg); }
.menu {
  position: absolute; left: 0; bottom: calc(100% + 4px); min-width: 100%;
  display: flex; flex-direction: column; gap: 1px; padding: 3px;
  background: rgba(18, 18, 20, 0.92); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
}
.menu[hidden] { display: none; }
.menu button { border-radius: 7px; padding: 6px 8px; white-space: nowrap; }
`;

// Feather `edit-3` and `x`, inline: the player has no IconService.
const EDIT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// Feather `chevron-up` and `activity`.
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
const PROFILER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

/** The chevron menu, bottom-up as listed. Editor modes and "send a node to the agent" go here. */
const MENU_ITEMS: readonly MenuItem[] = [
  {
    id: 'profiler',
    label: 'Profiler',
    title: 'Reload this page with the debug overlay: profiler, pause and step',
    icon: PROFILER_ICON,
    run: () => window.location.assign(profilerUrl(window.location.href)),
  },
];

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
  <div class="menu" role="menu" hidden>${[...MENU_ITEMS]
    .reverse()
    .map(
      item =>
        `<button type="button" role="menuitem" data-item="${item.id}" title="${item.title}">${item.icon}<span>${item.label}</span></button>`
    )
    .join('')}</div>
  <button type="button" data-action="open" title="Open this project in the Pix3 editor">${EDIT_ICON}<span>Pix3 editor</span></button>
  <button type="button" class="more" data-action="menu" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More ways to open">${CHEVRON_ICON}</button>
  <span class="note" hidden>Already open in another tab</span>
  <button type="button" class="close" data-action="hide" title="Hide" aria-label="Hide the editor link">${CLOSE_ICON}</button>
</div>`;
  const link = root.querySelector('.link') as HTMLElement;
  const note = root.querySelector('.note') as HTMLElement;
  const menu = root.querySelector('.menu') as HTMLElement;
  const more = root.querySelector('.more') as HTMLButtonElement;
  const setMenu = (open: boolean): void => {
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector<HTMLButtonElement>('button')?.focus();
  };
  // A press anywhere else closes the menu (presses inside the link stop at it, below).
  const closeOutside = (): void => setMenu(false);
  document.addEventListener('pointerdown', closeOutside);
  link.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      more.focus();
    }
  });
  // Keep the game's own listeners out of the link's clicks.
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
    link.addEventListener(type, event => event.stopPropagation());
  }
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const teardown = (): void => {
    clearTimeout(noteTimer);
    document.removeEventListener('pointerdown', closeOutside);
    host.remove();
  };
  root.addEventListener('click', event => {
    const target = event.target as Element | null;
    const itemId = target?.closest('[data-item]')?.getAttribute('data-item');
    const item = MENU_ITEMS.find(candidate => candidate.id === itemId);
    if (item) {
      setMenu(false);
      item.run();
      return;
    }
    const action = target?.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'menu') {
      setMenu(menu.hidden);
    } else if (action === 'hide') {
      try {
        sessionStorage.setItem(HIDDEN_KEY, '1');
      } catch {
        // Hidden for this page only.
      }
      teardown();
    } else if (action === 'open') {
      setMenu(false);
      void openEditor(editorUrl).then(outcome => {
        if (outcome !== 'already-open') return;
        note.hidden = false;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => (note.hidden = true), 3000);
      });
    }
  });
  document.body.appendChild(host);
  return teardown;
}
