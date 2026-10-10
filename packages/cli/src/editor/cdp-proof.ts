import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { CDP_CHALLENGE_HEADER, CDP_PROOF_HEADER, CDP_PROXY_HEADER } from './paths.ts';

/**
 * The proxy proves it knows the token before a client sends it (Remote SSH, plan §E.3).
 *
 * A `RemoteForward` port sits on the remote host's loopback, which every user of that host
 * shares: whoever binds the port first gets the connections. A client that sends
 * `Authorization: Bearer <token>` to a squatter has handed the token over. So `pix3`'s own
 * probes of a forwarded port send `X-Pix3-Challenge: <random nonce>` and no token, and trust
 * the port only when the answer's `X-Pix3-Proof` is `HMAC-SHA256(sha256(token), nonce)` — the
 * proxy answers it on every reply, a 401 included. chrome-devtools-mcp cannot do this (it sends
 * its `--wsHeaders` on connect); for it the guard is `ExitOnForwardFailure` (the README's SSH
 * lines) — recorded in `.plans/agent-bridge.md` (A20–A23).
 */

const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const PROBE_TIMEOUT_MS = 1_500;

export const cdpProof = (token: string, challenge: string): string =>
  createHmac('sha256', createHash('sha256').update(token).digest())
    .update(challenge)
    .digest('base64url');

/** The request's challenge, or null when absent or not a plain nonce. */
export const readChallenge = (headers: IncomingHttpHeaders): string | null => {
  const value = headers[CDP_CHALLENGE_HEADER.toLowerCase()];
  return typeof value === 'string' && CHALLENGE_SHAPE.test(value) ? value : null;
};

export type ProvenPort =
  /** Our proxy (or a forward of it): it knows the token. */
  | { readonly kind: 'ours' }
  /** Nothing answers HTTP there. */
  | { readonly kind: 'closed' }
  /** Something answers without the proof: another user's proxy, a squatter, anything else. */
  | { readonly kind: 'foreign'; readonly detail: string };

/**
 * Ask `127.0.0.1:<port>` whether it is a proxy that knows `token` — without sending the token.
 */
export const proveCdpProxy = async (
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProvenPort> => {
  const challenge = randomBytes(24).toString('base64url');
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      headers: { [CDP_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    return { kind: 'closed' };
  }
  const proof = response.headers.get(CDP_PROOF_HEADER);
  const expected = Buffer.from(cdpProof(token, challenge));
  if (proof && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), expected)) {
    return { kind: 'ours' };
  }
  return {
    kind: 'foreign',
    detail: response.headers.get(CDP_PROXY_HEADER)
      ? `port ${port} is a Pix3 CDP proxy that does not know this token`
      : `port ${port} is in use by something that is not a Pix3 CDP proxy (HTTP ${response.status})`,
  };
};
