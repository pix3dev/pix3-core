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
}
