import { gzipSync } from 'node:zlib';

/**
 * `pix3({ compress: true })` (plan §B.6 item 5; port of the 1.x `renderCompressedHtmlDocument`):
 * the single-file page's bundle — already one classic script at the end of `<body>` — is gzip'd,
 * base64'd and replaced by a bootstrap that inflates it with `DecompressionStream` and runs it by
 * injecting the text as a classic `<script>`'s `textContent`.
 *
 * Deliberately not a blob URL, a `data:` URL, `eval` or `new Function`: playables run inside
 * sandboxed / opaque-origin iframes and MRAID webviews, where module and blob fetches and
 * `unsafe-eval` are what gets refused; injected script text needs nothing the bootstrap itself
 * did not already need. The bundle is built as `iife` so the injected text declares nothing in
 * the page's global scope. base64's alphabet has no `<`, so the payload cannot contain
 * `</script>`.
 *
 * What it buys and costs is measured in CLAUDE.md «Playable export size»: the file shrinks by
 * about two thirds (the budget ad networks measure); over a gzip channel it is a wash, over
 * brotli +21%.
 */

export interface CompressedHtml {
  readonly html: string;
  /** The script text that was compressed (UTF-8 bytes). */
  readonly bundleBytes: number;
  /** The gzip payload before base64. */
  readonly gzipBytes: number;
  /** The base64 text embedded in the page. */
  readonly base64Bytes: number;
}

const BUNDLE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** The inline script that carries the bundle: the largest one with no `src`. */
const findBundleScript = (html: string): RegExpExecArray | null => {
  let best: RegExpExecArray | null = null;
  for (const match of html.matchAll(BUNDLE_SCRIPT)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    if (!best || match[2].length > best[2].length) best = match;
  }
  return best;
};

export const bootstrapScript = (base64: string): string =>
  [
    '(function () {',
    `  var payload = "${base64}";`,
    '  function fail(message) {',
    "    var box = document.createElement('pre');",
    "    box.id = 'pix3-boot-error';",
    "    box.style.cssText = 'color:#eee;font:14px/1.5 monospace;padding:16px;white-space:pre-wrap';",
    '    box.textContent = message;',
    '    document.body.appendChild(box);',
    "    if (window.__PIX3_PLAYER__) { window.__PIX3_PLAYER__.status = 'failed'; window.__PIX3_PLAYER__.errors.push(message); }",
    '  }',
    "  if (typeof DecompressionStream !== 'function') {",
    "    fail('This build is gzip-compressed and needs a browser with DecompressionStream ' +",
    "      '(Chrome 80+, Safari 16.4+, Firefox 113+). Build without pix3({ compress }) ' +",
    "      'to support older browsers.');",
    '    return;',
    '  }',
    '  try {',
    '    var binary = atob(payload);',
    '    var bytes = new Uint8Array(binary.length);',
    '    for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }',
    "    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));",
    '    new Response(stream).text().then(function (code) {',
    "      var script = document.createElement('script');",
    '      script.textContent = code;',
    '      document.body.appendChild(script);',
    '    }).catch(function (error) {',
    "      fail('Failed to unpack the game bundle: ' + error);",
    '    });',
    '  } catch (error) {',
    "    fail('Failed to unpack the game bundle: ' + error);",
    '  }',
    '})();',
  ].join('\n');

/** Replace the page's bundle script by the gzip payload and its bootstrap. */
export const toCompressedHtml = (html: string): CompressedHtml => {
  const script = findBundleScript(html);
  if (!script) throw new Error('compress: no inline bundle script found in index.html');
  const code = script[2];
  const gzip = gzipSync(Buffer.from(code, 'utf8'), { level: 9 });
  const base64 = gzip.toString('base64');
  const replaced = `<script>\n${bootstrapScript(base64)}\n</script>`;
  return {
    html: html.slice(0, script.index) + replaced + html.slice(script.index + script[0].length),
    bundleBytes: Buffer.byteLength(code, 'utf8'),
    gzipBytes: gzip.byteLength,
    base64Bytes: base64.length,
  };
};
