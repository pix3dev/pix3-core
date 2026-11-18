/**
 * The game page's end of the editor ↔ page link (plan play-in-page D8, behind the editor's
 * `playHost: 'page'` setting): a `BroadcastChannel` on this origin, addressed by the page's role
 * and `loadId`. A page the editor opened carries `?role=designer` (the human's Play window) or
 * `?role=agent` (the agent's page); the debug overlay installs this link for it. The editor's end
 * is `packages/editor-core/src/services/play/PlayPageLink.ts` — keep the frames in step.
 *
 * - `hello {page}` once the game has booted (or failed) and the test tools are loaded, and again
 *   in answer to the editor's `who`; `bye` on `pagehide`. `page` carries `loadId` (new on every
 *   load) and `rev` (the file revision the server stamped into this page): the editor's readiness
 *   barrier (D6).
 * - `call {id, role, loadId, tool, params}` → `result {id, loadId, value}`. A call for this role
 *   but another `loadId` answers `page_reloaded`: the page it was meant for is gone.
 * - `log` — a runtime error on this page, for the editor's Logs; `select` — "Show in editor".
 *
 * The page enforces nothing about who may drive it: the editor refuses control of the human's page
 * (`not_your_page`) before anything is sent.
 */

/** Keep in step with `PLAY_PAGES_CHANNEL` in editor-core's `PlayPageLink.ts`. */
export const PLAY_PAGES_CHANNEL = 'pix3-play-pages';

export type PageRole = 'designer' | 'agent';

/** What a page says about itself in `hello` and the `status` tool. */
export interface PageInfo {
  readonly role: PageRole;
  readonly loadId: string;
  readonly rev: number | null;
  readonly url: string;
  readonly scene: string | null;
  readonly status: string;
  readonly frames: number;
  readonly paused: boolean;
  /** Set while the pause is the one a `game_run` left on its outcome frame. */
  readonly pausedBy?: 'pix3_game_run';
}

/** The page as the link sees it: the player's state and the debug session's controls. */
export interface RpcPage {
  readonly state: {
    readonly loadId: string;
    readonly rev: number | null;
    readonly status: string;
    readonly frames: number;
    readonly scene: string | null;
    readonly runner: { readonly paused: boolean; resume(): void } | null;
    tools?: { call(name: string, params?: unknown): Promise<unknown> };
    loadTools?: () => Promise<boolean>;
  };
  readonly debug: {
    readonly paused: boolean;
    pause(): void;
    resume(): void;
    onError(listener: (error: { message: string; where: string | null }) => void): () => void;
  };
}

/** The page tools a call may name besides the link's own (`status`, `navigate`, …). */
const TEST_TOOLS = new Set(['game_run', 'game_controls', 'game_cancel', 'live_node', 'live_find']);

const refuse = (reason: string, detail: string) => ({ ok: false, reason, detail });

const isRole = (value: unknown): value is PageRole => value === 'designer' || value === 'agent';

/** The role in this page's URL (`?role=`), or null when the editor did not open it. */
export const pageRole = (search: string): PageRole | null => {
  const role = new URLSearchParams(search).get('role');
  return isRole(role) ? role : null;
};

const BOOT_POLL_MS = 100;

export interface EditorRpc {
  readonly role: PageRole;
  info(): PageInfo;
  /** Tell the editor to select `nodeId` (the Scene tab's "Show in editor"). */
  select(nodeId: string): void;
  dispose(): void;
}

/** Open the link for a page of `role`. Null without `BroadcastChannel`. */
export function installEditorRpc(
  page: RpcPage,
  role: PageRole,
  win: Window = window
): EditorRpc | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
  const { state, debug } = page;
  let pausedByRun = false;
  let ready = false;

  const info = (): PageInfo => {
    const runPaused = state.runner?.paused ?? false;
    if (!runPaused) pausedByRun = false;
    return {
      role,
      loadId: state.loadId,
      rev: state.rev,
      url: win.location.href,
      scene: state.scene,
      status: state.status,
      frames: state.frames,
      paused: runPaused || debug.paused,
      ...(pausedByRun ? { pausedBy: 'pix3_game_run' as const } : {}),
    };
  };
  const post = (frame: Record<string, unknown>): void => channel.postMessage(frame);
  const hello = (): void => post({ type: 'hello', page: info() });

  const later = (work: () => void): void => void setTimeout(work, 0);

  const run = async (tool: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (tool) {
      case 'status':
        return { ok: true, page: info() };
      case 'navigate':
        if (typeof params.url !== 'string') return refuse('invalid_params', 'navigate takes {url}');
        // Answer first: the document that would answer is about to go.
        later(() => win.location.replace(params.url as string));
        return { ok: true };
      case 'close':
        later(() => win.close());
        return { ok: true };
      case 'front':
        win.focus();
        return { ok: true, page: info() };
      case 'pause':
        debug.pause();
        return { ok: true, page: info() };
      case 'resume':
        if (state.runner?.paused) state.runner.resume();
        pausedByRun = false;
        debug.resume();
        return { ok: true, page: info() };
    }
    if (!TEST_TOOLS.has(tool)) return refuse('unknown_tool', `No page tool "${tool}".`);
    if (!state.tools) await state.loadTools?.();
    if (!state.tools)
      return refuse('no_tools', 'The page has no test tools (is @pix3/editor-core installed?).');
    const before = state.runner?.paused ?? false;
    const value = await state.tools.call(tool, params);
    if (tool === 'game_run' && !before && state.runner?.paused) pausedByRun = true;
    return value;
  };

  channel.onmessage = event => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'who') {
      if (ready) hello();
      return;
    }
    if (data.type !== 'call' || data.role !== role || typeof data.id !== 'string') return;
    const answer = (value: unknown): void =>
      post({ type: 'result', id: data.id, loadId: state.loadId, value });
    if (data.loadId !== state.loadId) {
      answer(
        refuse('page_reloaded', `The ${role} page was reloaded (it is now load ${state.loadId}).`)
      );
      return;
    }
    const params = (data.params ?? {}) as Record<string, unknown>;
    run(String(data.tool), params).then(answer, (error: unknown) =>
      answer(refuse('error', error instanceof Error ? error.message : String(error)))
    );
  };

  const disposeErrors = debug.onError(error =>
    post({
      type: 'log',
      role,
      loadId: state.loadId,
      at: Date.now(),
      message: error.message,
      where: error.where,
    })
  );
  const onPageHide = (): void => post({ type: 'bye', role, loadId: state.loadId });
  win.addEventListener('pagehide', onPageHide);

  // Ready once the game booted (or failed) and the test tools are in: then a call never races
  // the boot, and `hello` is the barrier the editor waits for.
  let disposed = false;
  const whenBooted = (): void => {
    if (disposed) return;
    if (state.status === 'booting') {
      setTimeout(whenBooted, BOOT_POLL_MS);
      return;
    }
    void (state.loadTools?.() ?? Promise.resolve(false))
      .catch(() => false)
      .then(() => {
        if (disposed) return;
        ready = true;
        hello();
      });
  };
  whenBooted();

  return {
    role,
    info,
    select: nodeId => post({ type: 'select', role, loadId: state.loadId, nodeId }),
    dispose() {
      disposed = true;
      disposeErrors();
      win.removeEventListener('pagehide', onPageHide);
      channel.close();
    },
  };
}
