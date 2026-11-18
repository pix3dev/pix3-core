import type { RunOverrides } from '@pix3/runtime';

import {
  errors as editorErrors,
  clearErrors as clearEditorErrors,
  type ComponentDTO,
  type LiveNodeRead,
  type NodeDTO,
  type NodeSummary,
} from '@/core/agent-introspection';
import { ServiceContainer } from '@/fw/di';
import { FlushService } from '@/services/project/FlushService';
import {
  gamePageUrl,
  PAGE_WINDOW_NAMES,
  pageWindowFeatures,
  PlayPageLink,
  type PageAnswer,
  type PageInfo,
  type PageRole,
} from '@/services/play/PlayPageLink';
import { appState } from '@/state';

import { HostService } from './HostService';

/**
 * The bridge's play tools when the game runs on its own page (plan play-in-page S4, §2.2; the
 * `playHost: 'page'` setting — `debug-bridge.ts` picks these over the in-editor ones):
 *
 * - control (`pix3_play` start/restart/stop/pause/resume, `pix3_game_run`) goes to the agent's own
 *   page `pix3-agent-play` only; aimed at the human's page it is `not_your_page` (D7). A read-only
 *   editor tab does not drive it either: the writer tab owns the agent's page.
 * - `start` / `restart` = flush + a fresh load of the page (`?run=` carries the test run) + the
 *   readiness barrier: the answer comes when the new load says hello with a revision no older
 *   than the last `pix3_sync` (D5, D6). `pix3_game_run` waits the same way when a sync reloaded
 *   the page, and ends `page_reloaded` if the page goes away under it.
 * - reads (`pix3_scene` live, `pix3_screenshot`, `pix3_errors`) take `page`; without it the human's
 *   page when it is open, else the agent's.
 */

type Params = Record<string, unknown>;

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

const link = (): PlayPageLink => service(PlayPageLink);

const refuse = (reason: string, detail: string, extra: Params = {}): PageAnswer => ({
  ok: false,
  reason,
  detail,
  ...extra,
});

/** How long a fresh load may take to say hello (a big scene on a software-rendered page is slow). */
const LOAD_WAIT_MS = 90_000;
/** A page that went away this recently (not closed by us) is taken to be reloading. */
const RELOADING_MS = 30_000;
/** How long a stale page gets to start reloading by itself (Vite's full reload after a sync). */
const RELOAD_GRACE_MS = 3_000;

const notYourPage = (): PageAnswer =>
  refuse(
    'not_your_page',
    'That is the human’s game page: read it (pix3_scene / pix3_screenshot / pix3_errors with ' +
      'page:"designer"), but start, restart, stop, pause, input and pix3_game_run go to your own ' +
      'page only — pix3_play {action:"start"} opens it.'
  );

const readOnlyTab = (): PageAnswer | null =>
  appState.project.host.writer === 'other'
    ? refuse(
        'not_your_page',
        'This editor tab is read-only: the writer tab owns the agent’s page. Use the writer tab.'
      )
    : null;

const pageRef = (page: PageInfo) => ({ role: page.role, url: page.url, loadId: page.loadId });

/**
 * The page a read goes to: `requested`, else the human's page when it is open, else the agent's
 * (D7). A refusal when the one asked for (or any) is not open.
 */
const readPage = (requested: unknown): PageInfo | PageAnswer => {
  const pages = link();
  if (requested === 'designer' || requested === 'agent') {
    return (
      pages.page(requested) ??
      refuse(
        'no_game_page',
        `No ${requested} game page is open${requested === 'agent' ? ' (pix3_play start opens it)' : ''}.`
      )
    );
  }
  return (
    pages.page('designer') ??
    pages.page('agent') ??
    refuse('no_game_page', 'No game page is open: pix3_play {action:"start"} opens yours.')
  );
};

const isPage = (value: PageInfo | PageAnswer): value is PageInfo =>
  typeof (value as PageInfo).loadId === 'string' && typeof (value as PageInfo).role === 'string';

// --- pix3_scene ---------------------------------------------------------------------------------------

/** A running node as a game answers it; `page` when it came from a game page. */
type LiveRead = LiveNodeRead & { page?: { role: string; loadId: string } };

/** Where `pix3_scene` reads the running game: the editor's play session, or a game page. */
export interface LiveSource {
  node(nodeId: string, byName: boolean): Promise<LiveRead | null>;
  /** Every live node whose name or type contains `text`. */
  find(text: string): Promise<NodeSummary[]>;
}

/** A game page's refusal (`page_reloaded`, `no_game_page`), answered as the tool's own. */
export class PageRefusal extends Error {
  constructor(readonly answer: PageAnswer) {
    super(String(answer.detail ?? answer.reason));
  }
}

const NO_GAME: LiveSource = { node: async () => null, find: async () => [] };

/**
 * The running game `pix3_scene` reads (D7): the page `requested`, else the human's page when it
 * is open, else the agent's; with none open the scene reads as outside play. Throws
 * {@link PageRefusal} when the page asked for is not open.
 */
export const pageLiveSource = (requested: unknown): LiveSource => {
  const page = readPage(requested);
  if (!isPage(page)) {
    if (requested === undefined) return NO_GAME;
    throw new PageRefusal(page);
  }
  const call = async (tool: string, params: Params): Promise<PageAnswer> => {
    const answer = await link().call(page.role, tool, params);
    if (answer.ok === false && answer.reason !== 'not_found') throw new PageRefusal(answer);
    return answer;
  };
  return {
    async node(nodeId, byName) {
      const answer = await call('live_node', { nodeId, byName });
      if (answer.ok === false) return null;
      return {
        dto: answer.node as NodeDTO,
        screen: (answer.screen as LiveRead['screen']) ?? null,
        components: answer.components as ComponentDTO[],
        page: { role: page.role, loadId: page.loadId },
      };
    },
    async find(text) {
      return (await call('live_find', { text })).matches as NodeSummary[];
    },
  };
};

// --- pix3_play --------------------------------------------------------------------------------------

/** The agent's last start: a restart loads the same scene with the same test run. */
let lastStart: { scene: string | null; run: RunOverrides | null } | null = null;

const activeScene = (): string | null => {
  const id = appState.scenes.activeSceneId;
  return (id && appState.scenes.descriptors[id]?.filePath) || null;
};

/** Why `run` is not `{seed?: integer, config?: {nodeId: {componentId: {…}}}}`, or null. */
export const runOverridesProblem = (run: RunOverrides): string | null => {
  if (run.seed !== undefined && !Number.isInteger(run.seed)) return 'run.seed must be an integer';
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (run.config === undefined) return null;
  if (!isObject(run.config)) return 'run.config must be {"<nodeId>": {"<componentId>": {…}}}';
  for (const [nodeId, components] of Object.entries(run.config)) {
    if (!isObject(components)) return `run.config["${nodeId}"] must map component ids to config`;
    for (const [componentId, values] of Object.entries(components)) {
      if (!isObject(values)) return `run.config["${nodeId}"]["${componentId}"] must be an object`;
    }
  }
  return null;
};

/** Open `url` in the agent's window, or load it in the agent's page when one is open. */
const loadAgentPage = async (url: string, current: PageInfo | null): Promise<PageAnswer | null> => {
  if (current) {
    const navigated = await link().call('agent', 'navigate', { url });
    if (navigated.ok !== false) return null;
  }
  const opened = window.open(
    url,
    PAGE_WINDOW_NAMES.agent,
    pageWindowFeatures(appState.project.manifest?.viewportBaseSize)
  );
  return opened
    ? null
    : refuse(
        'popup_blocked',
        `The browser blocked the agent's game window. Open ${url} in a new tab (chrome-devtools-mcp new_page; \`pix3 bridge\` does it by itself in the Chrome \`pix3 editor\` started), then call pix3_play again.`,
        { url }
      );
};

const startAgentPage = async (params: Params, restart: boolean): Promise<PageAnswer> => {
  const problem = params.run === undefined ? null : runOverridesProblem(params.run as RunOverrides);
  if (problem) return refuse('invalid_params', problem);
  const run = params.run as RunOverrides | undefined;
  const scenePath = typeof params.scenePath === 'string' ? params.scenePath : undefined;
  const start = {
    scene: scenePath ?? (restart && lastStart ? lastStart.scene : activeScene()),
    run: run ?? (restart && lastStart ? lastStart.run : null),
  };
  const flushed = await service(FlushService).flushDirty(10_000);
  if (!flushed.ok) {
    return refuse(
      'flush_failed',
      `The editor could not write its unsaved edits (${String(flushed.reason)}), so the page would play an older file; nothing was started. pix3_status / pix3_sync say more.`,
      { flush: flushed }
    );
  }
  lastStart = start;
  const pages = link();
  const current = pages.page('agent');
  const url = gamePageUrl(service(HostService).info.base, 'agent', start.scene, start.run);
  const blocked = await loadAgentPage(url, current);
  if (blocked) return blocked;
  const ready = await pages.until(() => {
    const page = pages.page('agent');
    return !!page && page.loadId !== current?.loadId && pages.isFresh(page);
  }, LOAD_WAIT_MS);
  const page = pages.page('agent');
  if (!ready || !page) {
    return refuse(
      'no_game_page',
      `The agent's page (${url}) did not report ready within ${LOAD_WAIT_MS / 1000} s.`
    );
  }
  if (page.status === 'failed') {
    return refuse(
      'refused',
      'The game failed to boot on the agent page: pix3_errors {page:"agent"} says why.',
      { page: pageRef(page) }
    );
  }
  return { ok: true, page: { ...pageRef(page), rev: page.rev, scene: page.scene } };
};

export const pagePlay = async (params: Params): Promise<PageAnswer> => {
  const action = params.action as string;
  if (action === 'status') return { ok: true, ...(await pagePlayStatus()) };
  if (params.page === 'designer') return notYourPage();
  const readOnly = readOnlyTab();
  if (readOnly) return readOnly;
  return link().serial(async () => {
    switch (action) {
      case 'start':
      case 'restart':
        return startAgentPage(params, action === 'restart');
      case 'stop':
        lastStart = null;
        return link().close('agent');
      default:
        return link().call('agent', action);
    }
  });
};

// --- pix3_game_run ----------------------------------------------------------------------------------

/**
 * The agent's page, as fresh as the last sync (D6): a sync that changed a script or a policy makes
 * Vite reload the page, so a page older than the sync gets {@link RELOAD_GRACE_MS} to start
 * reloading and the load's time to say hello. A page that does not reload by itself (a scene or an
 * asset changed) is `page_stale`: the run would test the files as they were.
 */
const freshAgentPage = async (): Promise<PageInfo | PageAnswer> => {
  const pages = link();
  // Mid-reload (the sync's full reload took the old load away, the new one is still booting).
  if (pages.isReloading('agent', RELOADING_MS)) {
    await pages.until(() => pages.page('agent') !== null, LOAD_WAIT_MS);
  }
  const current = pages.page('agent');
  if (!current) {
    return refuse('no_game_page', 'Your game page is not open: pix3_play {action:"start"} first.');
  }
  if (pages.isFresh(current)) return current;
  const moved = () => pages.page('agent')?.loadId !== current.loadId;
  if (!(await pages.until(moved, RELOAD_GRACE_MS))) {
    return refuse(
      'page_stale',
      `Your game page was loaded at rev ${current.rev}, before the last pix3_sync (rev ${pages.lastSyncRev}), and a scene or asset change does not reload it: pix3_play {action:"restart"}, then run.`
    );
  }
  await pages.until(() => {
    const page = pages.page('agent');
    return !!page && pages.isFresh(page);
  }, LOAD_WAIT_MS);
  const page = pages.page('agent');
  return page && pages.isFresh(page)
    ? page
    : refuse('no_game_page', 'Your game page reloaded after the sync and did not report ready.');
};

export const pageGameRun = async (params: Params): Promise<PageAnswer> => {
  if (params.page === 'designer') return notYourPage();
  const readOnly = readOnlyTab();
  if (readOnly) return readOnly;
  const page = await freshAgentPage();
  if (!isPage(page)) return page;
  const { page: _page, ...spec } = params;
  const wallMs =
    (typeof spec.maxWallMs === 'number' ? spec.maxWallMs : 20_000) +
    (typeof spec.settleMs === 'number' ? spec.settleMs : 0);
  const answer = await link().call('agent', 'game_run', spec, wallMs + 30_000);
  return answer.ok === false ? answer : { ...answer, page: pageRef(page) };
};

// --- pix3_screenshot, pix3_errors, pix3_status ------------------------------------------------------

export const pageScreenshot = async (params: Params): Promise<PageAnswer> => {
  const page = readPage(params.page);
  if (!isPage(page)) return page;
  // Bringing it forward is a courtesy (`pix3 bridge` does it through CDP anyway): a page busy
  // rendering may answer late, and the screenshot does not wait for it — only for a reload.
  const front = await link().call(page.role, 'front', {}, 2_000);
  if (front.reason === 'page_reloaded') return front;
  return { ok: true, target: 'game', page: pageRef(page), next: 'take_screenshot' };
};

export const pageErrors = (params: Params): PageAnswer => {
  const since = typeof params.since === 'number' ? params.since : undefined;
  const wanted = params.page as PageRole | undefined;
  const all = [
    ...editorErrors(since).map(error => ({ ...error, origin: 'editor' as const })),
    ...link().errors(since),
  ]
    .filter(error => wanted === undefined || error.origin === wanted)
    .sort((a, b) => a.at - b.at);
  if (params.clear === true) {
    clearEditorErrors();
    link().clearErrors();
  }
  return { ok: true, count: all.length, errors: all };
};

/** `pix3_status.play` on the page host: the pages that answer, no owner (D4, D7). */
export const pagePlayStatus = async (): Promise<PageAnswer> => ({
  playHost: 'page',
  pages: await link().discover(),
});
