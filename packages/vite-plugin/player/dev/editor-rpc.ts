import { newLoadId } from '../load-id';

/**
 * The game page's end of the editor ↔ page link (plan play-in-page D8): a `BroadcastChannel` on
 * this origin, addressed by the page's role and `loadId`. A page the editor opened carries
 * `?role=designer` (the human's Play window) or `?role=agent` (the agent's page). The editor's end
 * is `packages/editor-core/src/services/play/PlayPageLink.ts` — keep the frames in step.
 *
 * The editor opens these pages with `noopener` (S5b): each runs in a renderer process of its own,
 * so a busy game does not stall the editor or the other page — and the editor holds no handle on
 * the window. Everything it does to a page (load another URL, close it) goes through this link.
 * So the link opens early, before the game's modules have loaded: the plugin injects
 * `player/dev/page-link.ts` into the page's HTML ({@link openPageLink}), and the debug overlay
 * hands it the booted page ({@link PageLink.attach}).
 *
 * - `hello {page}` as soon as the link opens (`status: 'booting'`), again once the game has booted
 *   (or failed) and the test tools are loaded — the editor's readiness barrier (D6) — and in answer
 *   to `who`; `bye {reloading?}` on `pagehide`. `page` carries `loadId` (new on every load) and
 *   `rev` (the file revision the server stamped into this page).
 * - `call {id, role, loadId, tool, params}` → `result {id, loadId, value}`. A call for this role
 *   but another `loadId` answers `page_reloaded`: the page it was meant for is gone. `status`,
 *   `navigate`, `close` and `front` work while booting; the rest wait for the booted page.
 * - `wait {gate}` → `gate {gate, go}`: a page opened with `?gate=` (the human's Play, opened in the
 *   click before the editor's flush) boots only on `go: true` and closes itself on `go: false`.
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
  /** `booting` until the game has booted (or failed) and the test tools are in. */
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

/** What the debug overlay holds of the link once the page is attached. */
export interface EditorRpc {
  readonly role: PageRole;
  info(): PageInfo;
  /** Tell the editor to select `nodeId` (the Scene tab's "Show in editor"). */
  select(nodeId: string): void;
  dispose(): void;
}

/** The link as it opens, before the game has booted. */
export interface PageLink {
  readonly role: PageRole;
  /** This load's id: the player takes it for `__PIX3_PLAYER__.loadId`. */
  readonly loadId: string;
  /** Resolves when the editor lets this load boot (`?gate=`); null for a page without a gate. */
  readonly gate: Promise<void> | null;
  /** Hand over the booted page: its state, the debug session's controls, its tools. */
  attach(page: RpcPage): EditorRpc;
  dispose(): void;
}

declare global {
  interface Window {
    /** The link `player/dev/page-link.ts` opened while the page was loading. */
    __PIX3_PAGE_LINK__?: PageLink;
  }
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
/** A gated page asks again this often (an editor tab that was busy, or reloaded, may have missed it)… */
const GATE_RETRY_MS = 1_000;
/** …and boots anyway after this long: the editor that opened it is gone. */
const GATE_MAX_MS = 30_000;

/** Open the link for a page of `role`. Null without `BroadcastChannel`. */
export function openPageLink(
  role: PageRole,
  win: Window = window,
  loadId: string = newLoadId()
): PageLink | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
  let page: RpcPage | null = null;
  let ready = false;
  let pausedByRun = false;
  let disposed = false;
  let disposeErrors = (): void => undefined;

  const info = (): PageInfo => {
    if (!page) {
      return {
        role,
        loadId,
        rev: null,
        url: win.location.href,
        scene: null,
        status: 'booting',
        frames: 0,
        paused: false,
      };
    }
    const { state, debug } = page;
    const runPaused = state.runner?.paused ?? false;
    if (!runPaused) pausedByRun = false;
    return {
      role,
      loadId,
      rev: state.rev,
      url: win.location.href,
      scene: state.scene,
      status: ready ? state.status : 'booting',
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
        // A window opened by script may close itself, `noopener` or not.
        later(() => win.close());
        return { ok: true };
      case 'front':
        win.focus();
        return { ok: true, page: info() };
    }
    if (!page) return refuse('no_game_page', `The ${role} page is still loading the game.`);
    const { state, debug } = page;
    switch (tool) {
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

  // `?gate=<id>`: wait for the editor's word before booting; `go: false` (its flush failed — the
  // game would play older files) closes the page.
  const gateId = new URLSearchParams(win.location.search).get('gate');
  let openGate: ((go: boolean) => void) | null = null;
  const gate = gateId
    ? new Promise<void>(resolve => {
        const ask = (): void => post({ type: 'wait', gate: gateId });
        const retry = setInterval(ask, GATE_RETRY_MS);
        const giveUp = setTimeout(() => {
          console.warn('[pix3] The editor did not let this page start; starting anyway.');
          openGate?.(true);
        }, GATE_MAX_MS);
        openGate = go => {
          openGate = null;
          clearInterval(retry);
          clearTimeout(giveUp);
          if (!go) {
            win.close();
            return;
          }
          // A reload by hand must not wait at a gate nobody will open again.
          const { pathname, search, hash } = win.location;
          const rest = search.replace(/([?&])gate=[^&]*&?/, '$1').replace(/[?&]$/, '');
          win.history.replaceState(win.history.state, '', `${pathname}${rest}${hash}`);
          resolve();
        };
        ask();
      })
    : null;

  channel.onmessage = event => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'who') {
      hello();
      return;
    }
    if (data.type === 'gate') {
      if (data.gate === gateId) openGate?.(data.go === true);
      return;
    }
    if (data.type !== 'call' || data.role !== role || typeof data.id !== 'string') return;
    const answer = (value: unknown): void => post({ type: 'result', id: data.id, loadId, value });
    if (data.loadId !== loadId) {
      answer(refuse('page_reloaded', `The ${role} page was reloaded (it is now load ${loadId}).`));
      return;
    }
    const params = (data.params ?? {}) as Record<string, unknown>;
    run(String(data.tool), params).then(answer, (error: unknown) =>
      answer(refuse('error', error instanceof Error ? error.message : String(error)))
    );
  };

  // `bye {reloading}`: whether this document leaves for another load (a reload, `navigate`) or its
  // window closes — the Navigation API's `navigate` event fires for the first only. The editor
  // waits for a reloading page to come back and gives up on a closed one at once. Without the
  // API `reloading` is left out, and the editor takes the page for reloading.
  const navigation = (win as { navigation?: EventTarget }).navigation;
  let reloading = false;
  const onNavigate = (event: Event): void => {
    const destination = (event as Event & { destination?: { sameDocument?: boolean } }).destination;
    if (!destination?.sameDocument) reloading = true;
  };
  navigation?.addEventListener('navigate', onNavigate);
  const onPageHide = (): void =>
    post({ type: 'bye', role, loadId, ...(navigation ? { reloading } : {}) });
  win.addEventListener('pagehide', onPageHide);

  const dispose = (): void => {
    disposed = true;
    disposeErrors();
    win.removeEventListener('pagehide', onPageHide);
    navigation?.removeEventListener('navigate', onNavigate);
    channel.close();
  };

  const rpc: EditorRpc = {
    role,
    info,
    select: nodeId => post({ type: 'select', role, loadId, nodeId }),
    dispose,
  };

  hello();

  return {
    role,
    loadId,
    gate,
    dispose,
    attach(booted) {
      page = booted;
      disposeErrors = booted.debug.onError(error =>
        post({
          type: 'log',
          role,
          loadId,
          at: Date.now(),
          message: error.message,
          where: error.where,
        })
      );
      // Ready once the game booted (or failed) and the test tools are in: then a call never races
      // the boot, and this `hello` is the barrier the editor waits for.
      const whenBooted = (): void => {
        if (disposed) return;
        if (booted.state.status === 'booting') {
          setTimeout(whenBooted, BOOT_POLL_MS);
          return;
        }
        void (booted.state.loadTools?.() ?? Promise.resolve(false))
          .catch(() => false)
          .then(() => {
            if (disposed) return;
            ready = true;
            hello();
          });
      };
      whenBooted();
      return rpc;
    },
  };
}

/**
 * The link for a booted page of `role`: the one `page-link.ts` opened while the page loaded, else
 * a new one (a page whose HTML the plugin did not serve). Null without `BroadcastChannel`.
 */
export function installEditorRpc(
  page: RpcPage,
  role: PageRole,
  win: Window = window
): EditorRpc | null {
  const early = win.__PIX3_PAGE_LINK__;
  const link =
    early?.role === role && early.loadId === page.state.loadId
      ? early
      : openPageLink(role, win, page.state.loadId);
  return link?.attach(page) ?? null;
}
