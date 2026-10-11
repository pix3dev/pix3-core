import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import {
  CDP_CHALLENGE_HEADER,
  CDP_PROOF_HEADER,
  CDP_PROOF_REFUSED_HEADER,
  CDP_PROOF_SCOPE_HEADER,
  CDP_PROXY_HEADER,
} from './paths.ts';

/**
 * The proxy proves it knows the token before a client sends it (Remote SSH, plan §E.3).
 *
 * A `RemoteForward` port sits on the remote host's loopback, which every user of that host
 * shares: whoever binds the port first gets the connections. A client that sends
 * `Authorization: Bearer <token>` to a squatter has handed the token over. So `pix3`'s own
 * probes of a forwarded port send `X-Pix3-Challenge: <random nonce>` and no token, and trust
 * the port only when the answer's `X-Pix3-Proof` is right — the proxy answers it on every reply,
 * a 401 included. chrome-devtools-mcp cannot do this (it sends its `--wsHeaders` on connect); for
 * it the guard is `ExitOnForwardFailure` (the README's SSH lines) — recorded in
 * `.plans/agent-bridge.md` (A20–A23, A28). Locally the same rule holds for `pix3 editor`'s port
 * check (`cdp-port.ts`, A26): no port gets the token before its proof.
 *
 * **The proof is bound to the port the client dialled** (A28): `HMAC-SHA256(sha256(token),
 * "pix3-cdp-proof/2" ⏎ scope ":" port ⏎ nonce)`, where the client says its scope in
 * `X-Pix3-Proof-Scope` — `local` (it dialled the proxy itself: `port` must be the one the proxy
 * listens on) or `forward` (it dialled a `RemoteForward` on another host: `port` must be one the
 * human told this proxy it is forwarded at, `pix3 editor --url … --remote-port <n>`). The proxy
 * reads `port` from the request's `Host` and signs only for those ports. An unbound proof could
 * be relayed: a squatter on the remote port 9333 passes the challenge on to the real forward on
 * 9334 and hands its answer back — the client then sends the token to the squatter. Bound, the
 * relayed answer is for 9334 (or for a `Host` the squatter rewrote to 9333, which the proxy
 * refuses to sign: it is not forwarded there). The port is what both sides know: the human
 * configured it in `RemoteForward` and in `--remote-port`, the agent's host in `--cdp-port`.
 */

const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const PROBE_TIMEOUT_MS = 1_500;

/** `local`: the client dialled the proxy itself; `forward`: a `RemoteForward` of it. */
export type ProofScope = 'local' | 'forward';

export const cdpProof = (
  token: string,
  challenge: string,
  scope: ProofScope,
  port: number
): string =>
  createHmac('sha256', createHash('sha256').update(token).digest())
    .update(`pix3-cdp-proof/2\n${scope}:${port}\n${challenge}`)
    .digest('base64url');

/** The request's challenge, or null when absent or not a plain nonce. */
export const readChallenge = (headers: IncomingHttpHeaders): string | null => {
  const value = headers[CDP_CHALLENGE_HEADER.toLowerCase()];
  return typeof value === 'string' && CHALLENGE_SHAPE.test(value) ? value : null;
};

/** The scope a challenge asks for (`local` unless it says `forward`). */
export const readProofScope = (headers: IncomingHttpHeaders): ProofScope =>
  headers[CDP_PROOF_SCOPE_HEADER.toLowerCase()] === 'forward' ? 'forward' : 'local';

/** The challenge headers of a probe that dials `scope`. */
export const challengeHeaders = (challenge: string, scope: ProofScope): Record<string, string> => ({
  [CDP_CHALLENGE_HEADER]: challenge,
  [CDP_PROOF_SCOPE_HEADER]: scope,
});

/** True when `proof` is the proxy's answer to `challenge` for `scope`:`port` under `token`. */
export const provesToken = (
  proof: string | null,
  token: string,
  challenge: string,
  scope: ProofScope,
  port: number
): boolean => {
  if (!proof) return false;
  const expected = Buffer.from(cdpProof(token, challenge, scope, port));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export type ProvenPort =
  /** Our proxy (or a forward of it): it knows the token. */
  | { readonly kind: 'ours' }
  /** Nothing answers HTTP there. */
  | { readonly kind: 'closed' }
  /** Something answers without the proof: another user's proxy, a squatter, anything else. */
  | { readonly kind: 'foreign'; readonly detail: string };

/**
 * Ask `127.0.0.1:<port>` whether it is a proxy that knows `token` and signs for this port in
 * `scope` — without sending the token.
 */
export const proveCdpProxy = async (
  port: number,
  token: string,
  options: { readonly scope?: ProofScope; readonly fetch?: typeof fetch } = {}
): Promise<ProvenPort> => {
  const scope = options.scope ?? 'local';
  const challenge = randomBytes(24).toString('base64url');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`http://127.0.0.1:${port}/json/version`, {
      headers: challengeHeaders(challenge, scope),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    return { kind: 'closed' };
  }
  if (provesToken(response.headers.get(CDP_PROOF_HEADER), token, challenge, scope, port)) {
    return { kind: 'ours' };
  }
  if (!response.headers.get(CDP_PROXY_HEADER)) {
    return {
      kind: 'foreign',
      detail: `port ${port} is in use by something that is not a Pix3 CDP proxy (HTTP ${response.status})`,
    };
  }
  // Unproven, so only a hint: a relaying squatter can send this header as well as anyone.
  return {
    kind: 'foreign',
    detail: response.headers.get(CDP_PROOF_REFUSED_HEADER)
      ? `port ${port} answers as a Pix3 CDP proxy that will not prove the token for port ${port} — ` +
        `your proxy not told it is forwarded there (pix3 editor --url … --remote-port ${port} on your machine), ` +
        'or something relaying another port'
      : `port ${port} is a Pix3 CDP proxy that does not know this token`,
  };
};
