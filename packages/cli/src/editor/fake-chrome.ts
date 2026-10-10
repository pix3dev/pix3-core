import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

import { pipeFromStreams, type CdpPipe } from './cdp-proxy.ts';

/**
 * A stand-in for Chrome's CDP over `--remote-debugging-pipe`, for the specs of the proxy and of
 * `pix3 editor` (never shipped: nothing `index.ts` loads imports it). It models what the proxy
 * relies on, as measured on Chrome 155 (`.plans/agent-bridge.md`, A14):
 *
 * - flat sessions: `Target.attachToBrowserTarget` (a browser session), `Target.attachToTarget
 *   {flatten}` (a page session, its `Target.attachedToTarget` sent on the calling session),
 *   `Target.setAutoAttach` on a browser session (one child per page), `Target.detachFromTarget`
 *   only from the session that owns the child, and detaching a session drops its children;
 * - `Target.closeTarget` → `Target.detachedFromTarget` on the parent of every session of the page;
 * - an unknown session → `-32001 Session with given id not found.`, an unknown method → `-32601`;
 * - `Runtime.evaluate` on a page session answers `{expression, session}` so a spec can tell
 *   which session ran it; `Fake.*` methods expose the model; `Browser.close` ends the process.
 *
 * Run as a script (`node fake-chrome.ts --remote-debugging-pipe … <url>`) it speaks over fds 3/4
 * like Chrome; `--fake-exit-at-once` exits before answering (a profile another Chrome holds).
 */

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface Session {
  readonly id: string;
  readonly kind: 'browser' | 'page';
  readonly targetId: string;
  /** The session this one was attached from; '' for the pipe's own root. */
  readonly parent: string;
}

interface Target {
  readonly targetId: string;
  readonly type: 'page' | 'browser';
  url: string;
  title: string;
}

export class FakeChrome {
  readonly targets = new Map<string, Target>();
  readonly sessions = new Map<string, Session>();
  /** Every message received, as Chrome saw it (remapped ids and all). */
  readonly received: Message[] = [];
  #counter = 0;
  /** Browser sessions that auto-attach to every page (`Target.setAutoAttach`). */
  readonly #autoAttach = new Set<string>();
  #out: (message: string) => void = () => {};
  #onClose: () => void = () => {};

  constructor(urls: readonly string[] = ['about:blank']) {
    this.targets.set('browser', { targetId: 'browser', type: 'browser', url: '', title: '' });
    for (const url of urls) this.#createTarget(url);
  }

  /** Wire to a sender; returns the receiver for the proxy's messages. */
  connect(out: (message: string) => void, onClose: () => void = () => {}): (text: string) => void {
    this.#out = out;
    this.#onClose = onClose;
    return text => this.#handle(JSON.parse(text) as Message);
  }

  /** An in-memory pipe for `CdpProxy` (`close()` = Chrome exits). */
  pipe(): CdpPipe & { close(): void } {
    const listeners: Array<(message: string) => void> = [];
    const closeListeners: Array<() => void> = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener();
    };
    const receive = this.connect(message => {
      if (!closed) queueMicrotask(() => listeners.forEach(listener => listener(message)));
    }, close);
    return {
      send: message => {
        if (!closed) queueMicrotask(() => receive(message));
      },
      onMessage: listener => void listeners.push(listener),
      onClose: listener => void closeListeners.push(listener),
      close,
    };
  }

  #emit(message: Record<string, unknown>): void {
    this.#out(JSON.stringify(message));
  }

  #event(method: string, params: Record<string, unknown>, sessionId: string): void {
    this.#emit({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  #createTarget(url: string): Target {
    const target: Target = { targetId: `T${++this.#counter}`, type: 'page', url, title: url };
    this.targets.set(target.targetId, target);
    for (const session of this.sessions.values()) {
      if (session.kind === 'browser' && this.#autoAttach.has(session.id))
        this.#attach(target, session.id);
    }
    return target;
  }

  #info(target: Target) {
    return {
      targetId: target.targetId,
      type: target.type,
      url: target.url,
      title: target.title,
      attached: true,
    };
  }

  #attach(target: Target, parent: string): Session {
    const session: Session = {
      id: `S${++this.#counter}`,
      kind: target.type === 'browser' ? 'browser' : 'page',
      targetId: target.targetId,
      parent,
    };
    this.sessions.set(session.id, session);
    this.#event(
      'Target.attachedToTarget',
      { sessionId: session.id, targetInfo: this.#info(target), waitingForDebugger: false },
      parent
    );
    return session;
  }

  #detach(sessionId: string, notify: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const child of [...this.sessions.values()])
      if (child.parent === sessionId) this.#detach(child.id, false);
    this.sessions.delete(sessionId);
    this.#autoAttach.delete(sessionId);
    if (notify)
      this.#event(
        'Target.detachedFromTarget',
        { sessionId, targetId: session.targetId },
        session.parent
      );
  }

  #handle(message: Message): void {
    this.received.push(message);
    const { id, method = '', params = {} } = message;
    const sessionId = message.sessionId ?? '';
    const reply = (result: Record<string, unknown>) =>
      this.#emit({ id, result, ...(sessionId ? { sessionId } : {}) });
    const fail = (code: number, text: string) =>
      this.#emit({ id, error: { code, message: text }, ...(sessionId ? { sessionId } : {}) });
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) return fail(-32001, 'Session with given id not found.');
    switch (method) {
      case 'Browser.getVersion':
        return reply({
          protocolVersion: '1.3',
          product: 'FakeChrome/1.0',
          revision: '@fake',
          userAgent: 'FakeChrome',
          jsVersion: '0',
        });
      case 'Browser.close':
        reply({});
        return this.#onClose();
      case 'Target.attachToBrowserTarget':
        return reply({
          sessionId: this.#attach(this.targets.get('browser') as Target, sessionId).id,
        });
      case 'Target.attachToTarget': {
        const target = this.targets.get(String(params.targetId));
        if (!target || target.type !== 'page') return fail(-32602, 'No target with given id found');
        return reply({ sessionId: this.#attach(target, sessionId).id });
      }
      case 'Target.detachFromTarget': {
        const child = this.sessions.get(String(params.sessionId));
        if (!child || child.parent !== sessionId) return fail(-32602, 'No session with given id');
        this.#detach(child.id, true);
        return reply({});
      }
      case 'Target.setAutoAttach':
        if (session?.kind === 'browser' && params.autoAttach) {
          this.#autoAttach.add(sessionId);
          for (const target of this.targets.values())
            if (target.type === 'page') this.#attach(target, sessionId);
        }
        return reply({});
      case 'Target.getTargets':
        return reply({ targetInfos: [...this.targets.values()].map(t => this.#info(t)) });
      case 'Target.createTarget':
        return reply({
          targetId: this.#createTarget(String(params.url ?? 'about:blank')).targetId,
        });
      case 'Target.closeTarget': {
        const target = this.targets.get(String(params.targetId));
        if (!target) return fail(-32602, 'No target with given id found');
        this.targets.delete(target.targetId);
        for (const s of [...this.sessions.values()])
          if (s.targetId === target.targetId) this.#detach(s.id, true);
        return reply({ success: true });
      }
      case 'Runtime.evaluate':
        if (session?.kind !== 'page') return fail(-32601, "'Runtime.evaluate' wasn't found");
        return reply({
          result: { type: 'object', value: { expression: params.expression, session: sessionId } },
        });
      case 'Fake.ping':
        // An event on the calling session, then the answer: routing specs.
        this.#event('Fake.pinged', { by: sessionId }, sessionId);
        return reply({ pong: true });
      case 'Fake.sessions':
        return reply({ sessions: [...this.sessions.values()] });
      default:
        return fail(-32601, `'${method}' wasn't found`);
    }
  }
}

/** Script mode: Chrome's fds 3 (read) and 4 (write). */
const runAsChrome = (argv: readonly string[]): void => {
  if (argv.includes('--fake-exit-at-once')) process.exit(0);
  const url = argv.filter(arg => !arg.startsWith('--')).at(-1) ?? 'about:blank';
  const chrome = new FakeChrome([url]);
  const pipe = pipeFromStreams(
    new Socket({ fd: 4, readable: false, writable: true }),
    new Socket({ fd: 3, readable: true, writable: false })
  );
  const receive = chrome.connect(
    message => pipe.send(message),
    () => process.exit(0)
  );
  pipe.onMessage(receive);
  pipe.onClose(() => process.exit(0));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAsChrome(process.argv.slice(2));
}
