/**
 * SHA-256 for the editor, over WebCrypto (browsers and Node >= 19 alike).
 *
 * Byte-level "changed at all" checks hash the RAW bytes read from or written to disk — never a
 * re-serialization, since two writers format the same values differently. No `node:crypto`
 * fallback: it needs a non-literal `import()`, which makes Vite inject `/@vite/client` into the
 * editor chain (plan §B.2 contract B).
 */

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Lowercase hex SHA-256 of the given bytes (a string is hashed as UTF-8). */
export async function sha256(content: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content instanceof Uint8Array
        ? content
        : new Uint8Array(content);
  // Copy into a fresh ArrayBuffer-backed view: `digest` rejects SharedArrayBuffer views.
  return toHex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

/** {@link sha256} for binary input (atlas cache keys). */
export const sha256Hex = (data: ArrayBuffer | Uint8Array): Promise<string> => sha256(data);
