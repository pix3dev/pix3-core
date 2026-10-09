/**
 * Rewrite a single-file build's HTML so it runs as a classic script (port of DeepCore's
 * `classicScriptCompatibilityPlugin`, plan §B.6 item 5). Playables run inside sandboxed /
 * opaque-origin iframes and MRAID webviews, where a `<script type="module">` with `crossorigin`
 * is refused or deferred past the point the container expects a frame: the inlined module tag
 * becomes a plain `<script>` at the end of `<body>` (so `#app` exists when it runs), and the
 * ESM-only expressions a bundle may carry are rewritten: `import.meta.url` becomes
 * `document.baseURI`, `import.meta.resolve` (Vite 8's preload helper probes it) `undefined`, and
 * any other `import.meta` an empty object — a classic script cannot even parse `import.meta`.
 */
export const toClassicScriptHtml = (html: string): string => {
  let out = html
    .replace(/<script\b([^>]*)>/gi, (_match, attrs: string) => {
      const cleaned = attrs
        .replace(/\s+type=(['"])module\1/gi, '')
        .replace(/\s+crossorigin(?:=(['"]).*?\1)?/gi, '');
      return `<script${cleaned}>`;
    })
    .replace(/\bimport\.meta\.url\b/g, 'document.baseURI')
    .replace(/\bimport\.meta\.resolve\b/g, 'undefined')
    .replace(/\bimport\.meta\b/g, '({})');

  const headOpen = /<head>/i.exec(out);
  const headClose = /<\/head>/i.exec(out);
  const bodyOpen = /<body\b[^>]*>/i.exec(out);
  if (!headOpen || !headClose || !bodyOpen) return out;

  const headStart = headOpen.index + headOpen[0].length;
  const headEnd = headClose.index;
  const bodyClose = out.toLowerCase().indexOf('</body>', bodyOpen.index + bodyOpen[0].length);
  if (bodyClose < 0)
    throw new Error('Failed to locate </body> while rewriting classic script output.');

  const headContent = out.slice(headStart, headEnd);
  const headScripts = headContent.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  if (headScripts.length === 0) return out;

  let nextHead = headContent;
  for (const tag of headScripts) nextHead = nextHead.replace(tag, '');
  out =
    out.slice(0, headStart) +
    nextHead +
    out.slice(headEnd, bodyClose) +
    `${headScripts.join('\n')}\n` +
    out.slice(bodyClose);
  return out;
};
