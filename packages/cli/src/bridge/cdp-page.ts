import WebSocket from 'ws';

import { readChromeState } from '../editor/chrome-state.ts';
import { readCdpToken } from '../editor/cdp-token.ts';
import { CDP_PROXY_PATH } from '../editor/paths.ts';
import { readRemoteCdpToken, remoteCdpPort } from '../editor/remote.ts';

/**
 * The page-level CDP client `pix3 bridge` talks to the editor tab with: the same token proxy
 * chrome-devtools-mcp uses (`pix3 editor` started it), so an agent that cannot load an MCP server
 * — a subagent, CI, a session that is not restarted after `agent-setup` — still reaches the tab.
 * The CLI reads the token itself; it never prints it.
 */

export interface ProxyEndpoint {
  readonly port: number;
  readonly token: string;
  /** `local` = the proxy `pix3 editor` launched here; `forward` = a Remote SSH `RemoteForward`. */
  readonly kind: 'local' | 'forward';
}

/** The proxy to use: the local one `pix3 editor` recorded, else the Remote SSH forward. */
export const resolveProxyEndpoint = (
  env: NodeJS.ProcessEnv = process.env
): ProxyEndpoint | null => {
  const state = readChromeState(env);
  const localToken = readCdpToken(env);
  if (state && localToken) return { port: state.port, token: localToken, kind: 'local' };
  const remoteToken = readRemoteCdpToken(env);
  if (remoteToken)
    return { port: remoteCdpPort(undefined, env), token: remoteToken, kind: 'forward' };
  return null;
};

export interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly type: string;
}

/** The proxy's `/json/list`: the browser's targets. */
export const listPages = async (endpoint: ProxyEndpoint): Promise<PageTarget[]> => {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
  });
  if (!response.ok) throw new Error(`the CDP proxy answered ${response.status} on /json/list`);
  const list = (await response.json()) as PageTarget[];
  return list.filter(target => target.type === 'page');
};

/** One open CDP session on a page, through the proxy. */
export class CdpPage {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    socket.on('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('the page closed'));
      this.#pending.clear();
    });
  }

  static open(endpoint: ProxyEndpoint, targetId: string): Promise<CdpPage> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${endpoint.port}${CDP_PROXY_PATH}/page/${targetId}`,
        { headers: { Authorization: `Bearer ${endpoint.token}` }, perMessageDeflate: false }
      );
      socket.once('open', () => resolve(new CdpPage(socket)));
      socket.once('error', reject);
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page, awaiting a promise, and return its JSON value. */
  async evaluate(expression: string, timeoutMs = 30_000): Promise<unknown> {
    const answer = (await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? 'threw'
      );
    }
    return answer.result?.value;
  }

  close(): void {
    this.#socket.close();
  }
}

export interface PointerOptions {
  /** Touch events (a phone finger) instead of the mouse. */
  readonly touch?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A press and release at page CSS px — what a finger or a click does. */
export const tapAt = async (
  page: CdpPage,
  x: number,
  y: number,
  options: PointerOptions = {}
): Promise<void> => {
  if (options.touch) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(60);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(60);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
};

/** A drag from one page point to another over `durationMs`, in `steps` moves. */
export const swipeBetween = async (
  page: CdpPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: PointerOptions & { readonly durationMs?: number; readonly steps?: number } = {}
): Promise<void> => {
  const steps = Math.max(2, Math.round(options.steps ?? 8));
  const pause = Math.max(0, (options.durationMs ?? 180) / steps);
  const at = (i: number) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  });
  if (options.touch) {
    await page.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await sleep(pause);
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] });
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...from,
    button: 'left',
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    await sleep(pause);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...at(i),
      button: 'left',
      buttons: 1,
    });
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...to,
    button: 'left',
    clickCount: 1,
  });
};
