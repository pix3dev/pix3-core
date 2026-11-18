import { openPageLink, pageRole } from './editor-rpc';

/**
 * The game page's early link to the editor (plan play-in-page S5b): the plugin's
 * `transformIndexHtml` puts this module in the page's `<head>` on the dev server, so on a page the
 * editor opened (`?role=`) the link says hello — and obeys `navigate`, `close` and the Play gate —
 * long before the game's own modules have loaded. The player takes its `loadId` and waits at its
 * `gate` (`virtual:pix3/dev`'s `devPageLink`); the debug overlay attaches the booted page.
 */
const role = pageRole(location.search);
if (role && !window.__PIX3_PAGE_LINK__) {
  const link = openPageLink(role);
  if (link) window.__PIX3_PAGE_LINK__ = link;
}
