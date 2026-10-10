import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { headerValue, HttpError } from './http.ts';

/**
 * Who may talk to `/__pix3/*` (plan §B.1 «Защита записи»).
 *
 * The plugin's middleware runs before Vite's own host validation (it is a pre-middleware), so it
 * checks the `Host` itself:
 * - **Host** — a literal loopback name or one of `server.allowedHosts` (DNS rebinding: a page on an
 *   attacker's domain that resolves to 127.0.0.1 still sends its own name);
 * - **peer address** — loopback unless `allowRemote` (a dev server started with `--host` must not
 *   hand the project's files to the LAN);
 * - **mutations and the WebSocket** — `X-Pix3: 1` (mutations) and, when the request carries an
 *   `Origin`, the page's own origin. A cross-site page cannot add the header without a CORS
 *   preflight, which this server never answers; a WebSocket has no preflight at all, so its
 *   `Origin` is the only thing that keeps another site's tab from opening the event stream.
 *   Local processes (the CLI) send no `Origin`.
 */

export type AllowedHosts = readonly string[] | true;

export interface GuardOptions {
  readonly allowRemote: boolean;
  /** Vite's `server.allowedHosts` (`true` = any). */
  readonly allowedHosts: () => AllowedHosts;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `Host` header → lower-cased name (`[::1]` keeps its brackets), or null when malformed. */
export const hostNameOf = (hostHeader: string | undefined): string | null => {
  const host = (hostHeader ?? '').trim().toLowerCase();
  if (!host) return null;
  let name: string;
  let port: string;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return null;
    name = host.slice(0, close + 1);
    const rest = host.slice(close + 1);
    if (rest && !rest.startsWith(':')) return null;
    port = rest.slice(1);
  } else {
    const colon = host.indexOf(':');
    name = colon < 0 ? host : host.slice(0, colon);
    port = colon < 0 ? '' : host.slice(colon + 1);
    if (colon >= 0 && !port) return null;
  }
  if (port && !/^\d{1,5}$/.test(port)) return null;
  return name || null;
};

/** Vite's rule for one `allowedHosts` entry: exact name, or `.example.com` for it and subdomains. */
const matchesAllowed = (name: string, entry: string): boolean => {
  const allowed = entry.toLowerCase();
  if (allowed.startsWith('.')) return name === allowed.slice(1) || name.endsWith(allowed);
  return name === allowed;
};

export const isAllowedHost = (hostHeader: string | undefined, allowed: AllowedHosts): boolean => {
  const name = hostNameOf(hostHeader);
  if (name === null) return false;
  if (LOOPBACK_NAMES.has(name) || name.startsWith('127.')) return true;
  if (allowed === true) return true;
  return allowed.some(entry => matchesAllowed(name, entry));
};

export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return plain === '::1' || plain.startsWith('127.');
};

/** `Origin` header, or null when absent (a non-browser client). */
export const originOf = (req: IncomingMessage): string | null => headerValue(req, 'origin');

/** The origin a page served by this request's `Host` has. */
const ownOrigins = (req: IncomingMessage): string[] => {
  const host = headerValue(req, 'host') ?? '';
  return [`http://${host}`, `https://${host}`].map(origin => origin.toLowerCase());
};

export class RequestGuard {
  private readonly options: GuardOptions;

  constructor(options: GuardOptions) {
    this.options = options;
  }

  /** Every `/__pix3/*` request, reads included. */
  checkPeer(req: IncomingMessage): void {
    if (!isAllowedHost(req.headers.host, this.options.allowedHosts())) {
      throw new HttpError(403, 'forbidden_host', 'Forbidden host.');
    }
    if (!this.options.allowRemote && !isLoopbackAddress(req.socket.remoteAddress)) {
      throw new HttpError(
        403,
        'forbidden_remote',
        'The Pix3 editor only answers this machine. Pass pix3({ allowRemote: true }) to serve it ' +
          'to other hosts.'
      );
    }
  }

  checkSameOrigin(req: IncomingMessage): void {
    const origin = originOf(req);
    if (origin !== null && !ownOrigins(req).includes(origin.toLowerCase())) {
      throw new HttpError(403, 'forbidden_origin', 'Origin not allowed.');
    }
  }

  /** Anything that is not GET/HEAD. */
  checkMutation(req: IncomingMessage): void {
    if (headerValue(req, 'x-pix3') !== '1') {
      throw new HttpError(403, 'missing_x_pix3', 'Mutations need the header `X-Pix3: 1`.');
    }
    this.checkSameOrigin(req);
  }

  /**
   * Routes only the editor page may use, reads included: the image-generation keys and proxy
   * (plan §B.1). On top of {@link checkMutation}:
   * - `Sec-Fetch-Site`, when the browser sends it, is `same-origin`;
   * - `Referer`, when sent, is a page under `editorPrefix` (`<base>__pix3/`) — the game at `/` is
   *   the same origin, so the origin alone cannot tell the two apart;
   * - `X-Pix3-Session` is the token the plugin hands only to a top-level navigation of the editor
   *   page ({@link editorSessionFor}). A `Referer` is the page's to choose within its origin
   *   (`fetch(url, {referrer})`), the token is not.
   * Same-origin isolation has limits a header cannot fix (a service worker the game registers on
   * `/` sees the editor's traffic); the key itself never reaches any page.
   */
  checkEditorOnly(req: IncomingMessage, editorPrefix: string, sessionToken: string): void {
    this.checkMutation(req);
    const site = headerValue(req, 'sec-fetch-site');
    if (site !== null && site !== 'same-origin') {
      throw new HttpError(403, 'forbidden_site', 'Only the editor page may call this route.');
    }
    const referer = headerValue(req, 'referer');
    if (referer !== null) {
      let path: string;
      try {
        path = new URL(referer).pathname;
      } catch {
        path = '';
      }
      if (!path.startsWith(editorPrefix)) {
        throw new HttpError(403, 'forbidden_page', 'Only the editor page may call this route.');
      }
    }
    if (!sameSecret(headerValue(req, 'x-pix3-session') ?? '', sessionToken)) {
      throw new HttpError(
        403,
        'bad_session',
        'Missing or stale editor session: reload the editor tab.'
      );
    }
  }
}

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The session token for an editor-page request, or null when this request must not get it: the
 * page fetched by script (`Sec-Fetch-Dest: empty`) or framed (`iframe`) — the game at `/` can do
 * both. Browsers send `Sec-Fetch-*` only to secure origins (https, localhost); without them (a
 * plain-http LAN address under `allowRemote`, a non-browser client) the token is handed out.
 */
export const editorSessionFor = (req: IncomingMessage, token: string): string | null => {
  const dest = headerValue(req, 'sec-fetch-dest');
  if (dest === null) return token;
  return dest === 'document' ? token : null;
};
