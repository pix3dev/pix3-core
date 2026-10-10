import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';

import { cdpProof } from './cdp-proof.ts';
import {
  CDP_CHALLENGE_HEADER,
  CDP_PORT_RANGE,
  CDP_PROOF_HEADER,
  CDP_PROXY_HEADER,
  DEFAULT_CDP_PORT,
} from './paths.ts';

/**
 * The check of port 9333 before Chrome is launched (plan §D.4 «Проверка 9333», §D.5): something
 * may already listen there — our own proxy from an earlier `pix3 editor` (reuse it), somebody
 * else's Chrome, proxy or any other process (leave it alone, take the next port), or nothing
 * (launch).
 *
 * "Ours" is decided by what the port says, not by a pid: the proxy answers a challenge with the
 * proof that it knows our token (`~/.pix3/cdp-token`, `cdp-proof.ts`) — the check itself never
 * sends the token, so neither a squatter on 9333 nor somebody else's DevTools port ever sees it.
 * Only a port that proved it already knows the token is asked, with it, for its browser and
 * pages. A plain DevTools endpoint with a
 * Pix3 editor page (`/__pix3/`), or on the port the state file recorded, is the P1 launch
 * (`--remote-debugging-port`, no token): `legacy` — it holds our profile, so a new Chrome cannot
 * start on it, and it is open to every local process; `pix3 editor` asks for it to be closed.
 */

export type CdpPortState =
  | { readonly kind: 'free' }
  | { readonly kind: 'ours'; readonly browser: string; readonly pages: string[] }
  | { readonly kind: 'legacy'; readonly browser: string; readonly pages: string[] }
  | { readonly kind: 'foreign'; readonly browser: string | null; readonly detail: string };

const PROBE_TIMEOUT_MS = 1_500;

interface JsonVersion {
  Browser?: string;
}

interface JsonPage {
  url?: string;
  type?: string;
}

type Probe<T> = {
  readonly status: number;
  readonly proxy: boolean;
  /** The answer's `X-Pix3-Proof`, when the request carried a challenge. */
  readonly proof: string | null;
  readonly body: T | null;
} | null;

const getJson = async <T>(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>
): Promise<Probe<T>> => {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers,
    });
    const proxy = response.headers.get(CDP_PROXY_HEADER) !== null;
    const proof = response.headers.get(CDP_PROOF_HEADER);
    let body: T | null = null;
    if (response.ok) {
      try {
        body = (await response.json()) as T;
      } catch {
        body = null;
      }
    }
    return { status: response.status, proxy, proof, body };
  } catch {
    return null;
  }
};

/** True when a CDP page URL is a Pix3 editor tab. */
export const isEditorPageUrl = (url: string): boolean => /\/__pix3\/(?:[?#]|$)/.test(url);

export const inspectCdpPort = async (
  port: number,
  options: {
    readonly recordedPort?: number | null;
    readonly fetch?: typeof fetch;
    /** The proxy token; without it a proxy can only be told apart, never be ours. */
    readonly token?: string | null;
  } = {}
): Promise<CdpPortState> => {
  const fetchImpl = options.fetch ?? fetch;
  const token = options.token ?? null;
  const base = `http://127.0.0.1:${port}`;
  // The challenge, never the token: an unproven port learns nothing it could reuse.
  const challenge = randomBytes(24).toString('base64url');
  const version = await getJson<JsonVersion>(`${base}/json/version`, fetchImpl, {
    [CDP_CHALLENGE_HEADER]: challenge,
  });
  if (version && token && proves(version.proof, token, challenge)) {
    // Ours: it knows the token, so asking with it gives nothing away.
    const auth = { Authorization: `Bearer ${token}` };
    const ours = await getJson<JsonVersion>(`${base}/json/version`, fetchImpl, auth);
    const list = await getJson<JsonPage[]>(`${base}/json/list`, fetchImpl, auth);
    return {
      kind: 'ours',
      browser: ours?.body?.Browser ?? 'unknown browser',
      pages: pageUrls(list),
    };
  }
  if (version?.proxy) {
    return {
      kind: 'foreign',
      browser: null,
      detail:
        `port ${port} is a Pix3 CDP proxy that does not know this token (HTTP ${version.status}): ` +
        "another user's, or one started with another PIX3_HOME",
    };
  }
  if (!version?.body) {
    // Not a DevTools endpoint: free, or another protocol entirely. Only a listening socket
    // that is not CDP is "foreign"; a refused connection is free.
    const listening = await isListening(port);
    return listening
      ? {
          kind: 'foreign',
          browser: null,
          detail: `port ${port} is in use by something that is not Chrome`,
        }
      : { kind: 'free' };
  }
  // A plain DevTools endpoint: it answered without a token, and gets none.
  const browser = version.body.Browser ?? 'unknown browser';
  const urls = pageUrls(await getJson<JsonPage[]>(`${base}/json/list`, fetchImpl, {}));
  if (urls.some(isEditorPageUrl) || options.recordedPort === port) {
    return { kind: 'legacy', browser, pages: urls };
  }
  return {
    kind: 'foreign',
    browser,
    detail: `port ${port} is a ${browser} that is not Pix3's (${urls.length} page(s), none is /__pix3/)`,
  };
};

const proves = (proof: string | null, token: string, challenge: string): boolean => {
  if (!proof) return false;
  const expected = Buffer.from(cdpProof(token, challenge));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const pageUrls = (list: Probe<JsonPage[]>): string[] =>
  (Array.isArray(list?.body) ? list.body : [])
    .filter(p => p.type === 'page' || p.type === undefined)
    .map(p => p.url ?? '');

const isListening = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
  });

export interface PortChoice {
  readonly port: number;
  readonly state: CdpPortState;
  /** Ports that were tried and found foreign, with why — printed as the diagnostic. */
  readonly skipped: Array<{ port: number; detail: string }>;
}

/**
 * The port to use: `preferred` when it is free, ours or the P1 launch (which the caller has to
 * deal with), else the first such port of the following range. Every port skipped is reported so `pix3 editor` can explain itself.
 */
export const chooseCdpPort = async (
  options: {
    readonly preferred?: number;
    readonly recordedPort?: number | null;
    readonly fetch?: typeof fetch;
    readonly token?: string | null;
    readonly range?: number;
  } = {}
): Promise<PortChoice> => {
  const preferred = options.preferred ?? DEFAULT_CDP_PORT;
  const skipped: Array<{ port: number; detail: string }> = [];
  for (let port = preferred; port <= preferred + (options.range ?? CDP_PORT_RANGE); port++) {
    const state = await inspectCdpPort(port, options);
    if (state.kind !== 'foreign') return { port, state, skipped };
    skipped.push({ port, detail: state.detail });
  }
  throw new Error(
    `No free debugging port between ${preferred} and ${preferred + (options.range ?? CDP_PORT_RANGE)}:\n` +
      skipped.map(s => `  ${s.detail}`).join('\n')
  );
};
