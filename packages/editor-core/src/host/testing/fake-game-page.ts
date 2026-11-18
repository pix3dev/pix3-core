import { PLAY_PAGES_CHANNEL, type PageInfo, type PageRole } from '@/services/play/PlayPageLink';

/**
 * A game page on the editor link, for specs: what `@pix3/vite-plugin`'s `player/dev/editor-rpc.ts`
 * says and answers, over a real `BroadcastChannel`. `answer` decides each call (the default answers
 * `{ok: true, tool, params}`); `reload()` is a new load (bye, then hello with a new `loadId`).
 */
export interface FakeGamePage {
  info: PageInfo;
  readonly calls: { tool: string; params: Record<string, unknown>; loadId: string }[];
  answer: (tool: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  hello(): void;
  reload(changes?: Partial<PageInfo>): void;
  log(message: string): void;
  select(nodeId: string): void;
  close(): void;
}

export function fakeGamePage(role: PageRole, info: Partial<PageInfo> = {}): FakeGamePage {
  const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
  let load = 0;
  let closed = false;
  const page: FakeGamePage = {
    info: {
      role,
      loadId: `${role}-load-${load}`,
      rev: 0,
      url: `http://localhost:5173/?debug&role=${role}`,
      scene: 'scenes/main.pix3scene',
      status: 'running',
      frames: 1,
      paused: false,
      ...info,
    },
    calls: [],
    answer: (tool, params) => ({ ok: true, tool, params }),
    hello: () => channel.postMessage({ type: 'hello', page: page.info }),
    reload(changes = {}) {
      channel.postMessage({ type: 'bye', role, loadId: page.info.loadId });
      load += 1;
      page.info = { ...page.info, loadId: `${role}-load-${load}`, ...changes };
      page.hello();
    },
    log: message =>
      channel.postMessage({ type: 'log', role, loadId: page.info.loadId, at: Date.now(), message }),
    select: nodeId =>
      channel.postMessage({ type: 'select', role, loadId: page.info.loadId, nodeId }),
    close() {
      if (closed) return;
      closed = true;
      channel.postMessage({ type: 'bye', role, loadId: page.info.loadId });
      channel.close();
    },
  };
  channel.onmessage = event => {
    const frame = event.data as Record<string, unknown>;
    if (frame.type === 'who') page.hello();
    if (frame.type !== 'call' || frame.role !== role) return;
    const loadId = page.info.loadId;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    page.calls.push({ tool: String(frame.tool), params, loadId: String(frame.loadId) });
    if (frame.loadId !== loadId) {
      channel.postMessage({
        type: 'result',
        id: frame.id,
        loadId,
        value: { ok: false, reason: 'page_reloaded', detail: 'another load' },
      });
      return;
    }
    void Promise.resolve(page.answer(String(frame.tool), params)).then(value =>
      channel.postMessage({ type: 'result', id: frame.id, loadId, value })
    );
  };
  page.hello();
  return page;
}
