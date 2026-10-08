import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createServer, type ViteDevServer } from 'vite';
import { WebSocket } from 'ws';

import { pix3, type Pix3Options } from '../index.ts';

/** A throwaway project on disk with a real Vite dev server running `pix3()` on a free port. */
export interface TestProject {
  readonly root: string;
  readonly server: ViteDevServer;
  readonly origin: string;
  readonly port: number;
  write(path: string, content: string): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A mutation with the headers the editor sends. */
  mutate(path: string, init: RequestInit & { writer?: string }): Promise<Response>;
  connectTab(tabId: string): Promise<FakeTab>;
  close(): Promise<void>;
}

/** A WebSocket client speaking the editor page's side of `/__pix3/ws`. */
export interface FakeTab {
  readonly welcome: Record<string, unknown>;
  readonly frames: Record<string, unknown>[];
  /** Answer every request of `kind` with what `answer` returns. */
  onRequest(
    kind: string,
    answer: (
      request: Record<string, unknown>
    ) => Record<string, unknown> | Promise<Record<string, unknown>>
  ): void;
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>;
  close(): void;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

export const startProject = async (
  files: Record<string, string> = {},
  options: Pix3Options = {}
): Promise<TestProject> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-plugin-')));
  const write = (path: string, content: string): void => {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write('index.html', '<!doctype html><script type="module" src="/src/main.ts"></script>\n');
  for (const [path, content] of Object.entries(files)) write(path, content);

  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [pix3(options)],
    // The temp project has no node_modules; nothing here needs pre-bundling.
    optimizeDeps: { noDiscovery: true },
    server: { port, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const tabs: WebSocket[] = [];

  const connectTab = async (tabId: string): Promise<FakeTab> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__pix3/ws`);
    tabs.push(socket);
    const frames: Record<string, unknown>[] = [];
    const answers = new Map<string, (request: Record<string, unknown>) => unknown>();
    const waiters: {
      predicate: (frame: Record<string, unknown>) => boolean;
      resolve: (f: Record<string, unknown>) => void;
    }[] = [];
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
      if (frame.type === 'request') {
        const answer = answers.get(String(frame.kind));
        if (!answer) return;
        void Promise.resolve(answer(frame)).then(body =>
          socket.send(JSON.stringify({ type: 'reply', id: frame.id, ...(body as object) }))
        );
      }
    });
    const waitFor = (
      predicate: (frame: Record<string, unknown>) => boolean,
      timeoutMs = 5_000
    ): Promise<Record<string, unknown>> => {
      const seen = frames.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a frame')),
          timeoutMs
        );
        waiters.push({
          predicate,
          resolve: frame => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    };
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', tabId }));
    const welcome = await waitFor(frame => frame.type === 'welcome');
    return {
      welcome,
      frames,
      onRequest: (kind, answer) => answers.set(kind, answer),
      waitFor,
      close: () => socket.close(),
    };
  };

  return {
    root,
    server,
    origin,
    port,
    write,
    fetch: (path, init) => fetch(`${origin}${path}`, init),
    mutate: (path, { writer, ...init }) => {
      const headers = new Headers(init.headers);
      headers.set('X-Pix3', '1');
      if (writer) headers.set('X-Pix3-Writer', writer);
      return fetch(`${origin}${path}`, { ...init, headers });
    },
    connectTab,
    close: async () => {
      for (const socket of tabs) socket.terminate();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
