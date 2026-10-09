import { createConnection } from 'node:net';

import { CDP_PORT_RANGE, DEFAULT_CDP_PORT } from './paths.ts';

/**
 * The check of port 9333 before Chrome is launched (plan §D.4 «Проверка 9333»): something may
 * already listen there — our own Chrome from an earlier `pix3 editor` (reuse it), somebody else's
 * Chrome or any other process (leave it alone, take the next port), or nothing (launch).
 *
 * "Ours" is decided by what the port says, not by a pid: a page whose URL is a Pix3 editor
 * (`/__pix3/`) is the marker, and a port the state file recorded as ours counts too (the editor
 * window may be closed while Chrome keeps running).
 */

export type CdpPortState =
  | { readonly kind: 'free' }
  | { readonly kind: 'ours'; readonly browser: string; readonly pages: string[] }
  | { readonly kind: 'foreign'; readonly browser: string | null; readonly detail: string };

const PROBE_TIMEOUT_MS = 1_500;

interface JsonVersion {
  Browser?: string;
}

interface JsonPage {
  url?: string;
  type?: string;
}

const getJson = async <T>(url: string, fetchImpl: typeof fetch): Promise<T | null> => {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

/** True when a CDP page URL is a Pix3 editor tab. */
export const isEditorPageUrl = (url: string): boolean => /\/__pix3\/(?:[?#]|$)/.test(url);

export const inspectCdpPort = async (
  port: number,
  options: { readonly recordedPort?: number | null; readonly fetch?: typeof fetch } = {}
): Promise<CdpPortState> => {
  const fetchImpl = options.fetch ?? fetch;
  const base = `http://127.0.0.1:${port}`;
  const version = await getJson<JsonVersion>(`${base}/json/version`, fetchImpl);
  if (!version) {
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
  const browser = version.Browser ?? 'unknown browser';
  const pages = (await getJson<JsonPage[]>(`${base}/json/list`, fetchImpl)) ?? [];
  const urls = pages.filter(p => p.type === 'page' || p.type === undefined).map(p => p.url ?? '');
  if (urls.some(isEditorPageUrl) || options.recordedPort === port) {
    return { kind: 'ours', browser, pages: urls };
  }
  return {
    kind: 'foreign',
    browser,
    detail: `port ${port} is a ${browser} that is not Pix3's (${urls.length} page(s), none is /__pix3/)`,
  };
};

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
 * The port to use: `preferred` when it is free or ours, else the first free/ours port of the
 * following range. Every port skipped is reported so `pix3 editor` can explain itself.
 */
export const chooseCdpPort = async (
  options: {
    readonly preferred?: number;
    readonly recordedPort?: number | null;
    readonly fetch?: typeof fetch;
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
