/** The overlay's HTML snippets (its panes render strings into a shadow root). */

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** A label / value row; `value` is HTML (escape what came from the game). */
export const row = (label: string, value: string, cls = ''): string =>
  `<div class="row"><span>${escapeHtml(label)}</span><span class="${cls}">${value}</span></div>`;

export const section = (title: string, body: string): string =>
  `<section><h3>${escapeHtml(title)}</h3>${body}</section>`;
