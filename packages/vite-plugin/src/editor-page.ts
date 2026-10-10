/**
 * The editor page and `virtual:pix3/editor-host` (plan §B.1, §B.2 variant B).
 *
 * The page is raw HTML: `transformIndexHtml` would inject `/@vite/client`, and with it Vite's
 * `full-reload` and reload-after-reconnect. Its one module is the host, requested from Vite
 * directly by its `/@id/` URL (S1: no inline module and no html-proxy needed).
 */

export const EDITOR_HOST_ID = 'virtual:pix3/editor-host';
export const SPINE_LOADER_ID = 'virtual:pix3/spine-loader';

/**
 * Contract B's page check (plan §B.2), installed before any module loads: a resource observer sets
 * `window.__PIX3_VITE_CLIENT__` when Vite's client is fetched, at load or later (a script added
 * with a CSS import reaches the page on a sync). The resource-timing buffer is raised first — the
 * default 250 entries fill up with the editor's own modules and later entries would be dropped.
 * The regex keeps the literal client path out of the page text.
 */
const VITE_CLIENT_PROBE =
  'window.__PIX3_VITE_CLIENT__=false;try{performance.setResourceTimingBufferSize(1e5);' +
  'new PerformanceObserver(function(list){list.getEntries().forEach(function(e){' +
  'if(/\\/@vite\\/client$/.test(new URL(e.name,location.href).pathname))window.__PIX3_VITE_CLIENT__=true;' +
  "})}).observe({type:'resource',buffered:true})}catch(e){}";

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

export const editorPageHtml = (base: string, options: { css?: boolean } = {}): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pix3</title>
    <style>html,body,#pix3-editor{margin:0;height:100%}</style>
    <script>${VITE_CLIENT_PROBE}</script>${
      options.css ? `\n    <link rel="stylesheet" href="${base}__pix3/editor.css" />` : ''
    }
  </head>
  <body>
    <div id="pix3-editor"></div>
    <script type="module" src="${base}@id/__x00__${EDITOR_HOST_ID}"></script>
  </body>
</html>
`;

/** What `/__pix3/` shows instead of the editor when the version gate fails (plan §A.3). */
export const versionGatePageHtml = (message: string): string =>
  `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Pix3 — version mismatch</title></head>
  <body style="font:15px/1.5 system-ui,sans-serif;margin:3rem;max-width:44rem">
    <h1 style="font-size:1.4rem">Pix3 cannot open this project yet</h1>
    <p>${escapeHtml(message)}</p>
    <p>Then restart the dev server.</p>
  </body>
</html>
`;

export interface EditorHostSource {
  readonly base: string;
  /** `/@fs/…` URL of the plugin's page client (`src/client/index`). */
  readonly clientUrl: string;
  /** Whether `@pix3/editor-core` resolves from the project. */
  readonly editorCore: boolean;
}

/**
 * Source of `virtual:pix3/editor-host`. The script roots are imported statically, so they are in
 * the module graph from the first load and every sync only re-imports them with a fresh `?t=`.
 * Without `@pix3/editor-core` (P1, until the port lands) the page shows the host's state instead
 * of the editor — enough to run the barrier against a real browser.
 */
export const editorHostSource = ({ base, clientUrl, editorCore }: EditorHostSource): string => {
  const lines = [
    `import * as editorScripts from 'virtual:pix3/editor-scripts';`,
    `import * as botPolicies from 'virtual:pix3/bot-policies';`,
    `import { EditorHostConnection, viteClientLoaded } from ${JSON.stringify(clientUrl)};`,
  ];
  if (editorCore) lines.push(`import { mountEditor } from '@pix3/editor-core';`);
  lines.push(
    `const host = new EditorHostConnection({ base: ${JSON.stringify(base)}, roots: { editorScripts, botPolicies } });`,
    `window.__PIX3_HOST__ = host;`,
    `host.connect();`,
    `if (viteClientLoaded()) console.error('[pix3] /@vite/client is loaded on the editor page: a non-literal import(), import.meta.hot or a CSS import reached the editor chain (plan §B.2, contract B; \`pix3 check\` names the file).');`,
    `const root = document.getElementById('pix3-editor');`
  );
  if (editorCore) {
    lines.push(`void host.ready().then(() => mountEditor(root, host));`);
  } else {
    lines.push(
      `root.textContent = 'Pix3 editor host is running; @pix3/editor-core is not installed.';`,
      `void host.ready().then(hello => { root.dataset.tabId = hello.tabId; root.dataset.seq = String(hello.seq); });`
    );
  }
  return `${lines.join('\n')}\n`;
};
