import { SceneManager, type RunOverrides } from '@pix3/runtime';

import { inject, injectable } from '@/fw/di';
import { selectObject } from '@/features/selection/SelectObjectCommand';
import { resolveCommandDispatcher } from '@/services/core/CommandDispatcher';
import { LoggingService } from '@/services/core/LoggingService';
import { appState } from '@/state';

/**
 * The editor's end of the link to the game's pages (plan play-in-page D6–D8): a `BroadcastChannel`
 * RPC to the pages the editor opened — the human's Play window (`designer`) and the agent's page
 * (`agent`) — addressed by role and `loadId`. The page's end is `@pix3/vite-plugin`'s
 * `player/dev/editor-rpc.ts`; keep the frames in step.
 *
 * The editor holds no play state (D4): what it knows of a page is the last `hello` it said. A page
 * says `hello {page}` as soon as it starts loading (`status: 'booting'`), again when it is ready
 * ({@link isReady}) and to `who`, `bye {reloading?}` on `pagehide`; a call carries the `loadId` it
 * was meant for, and a call whose page went away (or reloaded) is answered `page_reloaded`, never
 * by another document.
 *
 * The pages are opened with `noopener` (S5b, {@link pageWindowFeatures}): each runs in a renderer
 * process of its own, so a game busy rendering does not stall the editor or the other page. The
 * editor keeps no `Window` for them; loading another URL and closing go through the link
 * (`navigate`, `close`), and a page opened in a click before the flush waits at a gate
 * ({@link openGate}) for the flush's outcome.
 */

/** Keep in step with `PLAY_PAGES_CHANNEL` in the plugin's `player/dev/editor-rpc.ts`. */
export const PLAY_PAGES_CHANNEL = 'pix3-play-pages';

export type PageRole = 'designer' | 'agent';

export interface PageInfo {
  readonly role: PageRole;
  readonly loadId: string;
  /** The file revision the dev server served the page at (D6); null without the editor. */
  readonly rev: number | null;
  readonly url: string;
  readonly scene: string | null;
  readonly status: string;
  readonly frames: number;
  readonly paused: boolean;
  readonly pausedBy?: 'pix3_game_run';
}

/** A runtime error a page reported, for the Logs panel and `pix3_errors`. */
export interface PageError {
  readonly at: number;
  readonly origin: PageRole;
  readonly loadId: string;
  readonly message: string;
  readonly where: string | null;
}

export type PageAnswer = Record<string, unknown>;

/**
 * A run of the game's page (D1, D5): `<base>?debug&role=…` — `mute` on the agent's page — with the
 * scene and the test run's seed and config (`?run=`) a load starts with.
 */
export const gamePageUrl = (
  base: string,
  role: PageRole,
  scene: string | null,
  run: RunOverrides | null = null
): string => {
  const params = ['debug', `role=${role}`];
  if (role === 'agent') params.push('mute');
  if (scene) {
    const path = scene.replace(/^res:\/\//i, '').replace(/^\/+/, '');
    params.push(`scene=${encodeURIComponent(path)}`);
  }
  if (run) params.push(`run=${encodeURIComponent(JSON.stringify(run))}`);
  return new URL(`${base}?${params.join('&')}`, window.location.origin).href;
};

/**
 * `window.open` features: a popup the size of the project's viewport, scaled down to fit the
 * screen (D2), opened `noopener` — Chrome gives a page without an opener a renderer process of
 * its own (S5b), and `window.open` returns null for it.
 */
export const pageWindowFeatures = (
  viewport: { width: number; height: number } | null | undefined
): string => {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return 'popup,noopener';
  const room = { width: screen.availWidth * 0.9, height: screen.availHeight * 0.9 };
  const scale = Math.min(1, room.width / viewport.width, room.height / viewport.height);
  return `popup,noopener,width=${Math.round(viewport.width * scale)},height=${Math.round(viewport.height * scale)}`;
};

/** A page that has booted the game (or failed to) and loaded its tools: what calls may wait for. */
export const isReady = (page: PageInfo): boolean => page.status !== 'booting';

/**
 * How long a page `window.open` asked for gets to say its first hello (the page's early link
 * speaks right after the HTML, long before the game has loaded). No hello by then: the browser
 * blocked the window — with `noopener` there is no other sign of it. Hello normally comes ~0.4 s
 * after the open; 5 s leaves room for a browser behind an SSH port forward.
 */
export const OPEN_WAIT_MS = 5_000;

/** The agent's page closes after this long without a call (never during one, D7). */
const AGENT_IDLE_MS = 10 * 60_000;
const MAX_ERRORS = 100;
/** A decided gate is kept this long for a page that asks late (it retries every second). */
const GATE_KEEP_MS = 60_000;

const isRole = (value: unknown): value is PageRole => value === 'designer' || value === 'agent';

const refusal = (reason: string, detail: string): PageAnswer => ({ ok: false, reason, detail });

interface Pending {
  readonly role: PageRole;
  readonly loadId: string;
  readonly settle: (answer: PageAnswer) => void;
}

@injectable()
export class PlayPageLink {
  @inject(LoggingService)
  private readonly logging!: LoggingService;

  @inject(SceneManager)
  private readonly scenes!: SceneManager;

  private channel: BroadcastChannel | null = null;
  private readonly pages = new Map<PageRole, PageInfo>();
  private readonly pending = new Map<string, Pending>();
  private readonly changeListeners = new Set<() => void>();
  private readonly errorList: PageError[] = [];
  private syncRev = -1;
  /** When a page went away without being closed from here — a reload, most likely. */
  private readonly left = new Map<PageRole, number>();
  /** Loads closed from here ({@link close}): their `bye` is not a reload. */
  private readonly closing = new Set<string>();
  private nextCall = 0;
  private control: Promise<unknown> = Promise.resolve();
  private agentCalls = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pages opened in a click and waiting for the flush: `go` once it is decided. */
  private readonly gates = new Map<string, { role: PageRole; at: number; go: boolean | null }>();

  /** Open the channel and ask the pages already open (an editor reload finds them again). */
  start(): () => void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return () => undefined;
    const channel = new BroadcastChannel(PLAY_PAGES_CHANNEL);
    this.channel = channel;
    channel.onmessage = event => this.receive(event.data);
    channel.postMessage({ type: 'who' });
    return () => this.dispose();
  }

  dispose(): void {
    this.channel?.close();
    this.channel = null;
    this.pages.clear();
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.settle(refusal('no_game_page', 'The editor link closed.'));
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.left.clear();
    this.closing.clear();
    this.gates.clear();
    this.errorList.length = 0;
    this.syncRev = -1;
  }

  /** The page of `role` as its last `hello` described it, or null. */
  page(role: PageRole): PageInfo | null {
    return this.pages.get(role) ?? null;
  }

  /**
   * Ask every page to say hello again and give them `ms` to answer; the pages known then,
   * designer first (fresh `paused`, `frames`). A page that does not answer in time is kept: a
   * page busy booting or rendering in software answers late, and only its `bye` says it is gone.
   */
  async discover(ms = 300): Promise<PageInfo[]> {
    if (!this.channel) return [];
    this.channel.postMessage({ type: 'who' });
    await new Promise(resolve => setTimeout(resolve, ms));
    return (['designer', 'agent'] as const).flatMap(role => this.pages.get(role) ?? []);
  }

  /** Call `listener` on every hello / bye (a page opened, reloaded or went away). */
  onPagesChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Resolves true once `condition()` holds (checked now and on every hello / bye), false at `timeoutMs`. */
  until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise(resolve => {
      const check = (): void => {
        if (!condition()) return;
        done(true);
      };
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.changeListeners.delete(check);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.changeListeners.add(check);
    });
  }

  /**
   * Call `tool` on the page of `role` as it is now. Never throws: no page → `no_game_page`; the
   * page reloaded or went away before answering → `page_reloaded`; no answer in `timeoutMs` →
   * `no_game_page`.
   */
  call(
    role: PageRole,
    tool: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<PageAnswer> {
    const page = this.pages.get(role);
    if (!this.channel || !page) {
      return Promise.resolve(refusal('no_game_page', `No ${role} page is open.`));
    }
    // Unique across editor tabs too: every tab hears every answer.
    const id = `${(this.nextCall += 1)}-${Math.random().toString(36).slice(2)}`;
    if (role === 'agent') this.noteAgentCall(+1);
    return new Promise<PageAnswer>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          refusal(
            'no_game_page',
            `The ${role} page did not answer "${tool}" within ${timeoutMs} ms.`
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        role,
        loadId: page.loadId,
        settle: answer => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      this.channel?.postMessage({ type: 'call', id, role, loadId: page.loadId, tool, params });
    }).finally(() => {
      if (role === 'agent') this.noteAgentCall(-1);
    });
  }

  /**
   * Close the page of `role` (Stop, the agent's `stop`, the idle timeout). A window that closes
   * may never get its `bye` out (headless Chrome drops it) and a window closed by hand may not
   * either, so the page is forgotten here whether it agreed or did not answer at all; one that
   * stays open after all says hello to the next `who`.
   */
  async close(role: PageRole): Promise<PageAnswer> {
    const page = this.pages.get(role);
    if (page) this.closing.add(page.loadId);
    const answer = await this.call(role, 'close');
    if (page) this.leave(role, page.loadId, false);
    return answer;
  }

  /**
   * True when the page of `role` went away within `ms` without being closed from here (Vite's
   * full reload after a sync, a reload by hand) and has not said hello again yet.
   */
  isReloading(role: PageRole, ms: number): boolean {
    const at = this.left.get(role);
    return at !== undefined && !this.pages.has(role) && Date.now() - at <= ms;
  }

  /**
   * A gate for a page of `role` about to be opened before the flush that must precede its load:
   * the page (`?gate=<id>`) waits for {@link releaseGate} — boots on `go`, closes itself without.
   */
  openGate(role: PageRole): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.gates.set(id, { role, at: Date.now(), go: null });
    return id;
  }

  releaseGate(id: string, go: boolean): void {
    const gate = this.gates.get(id);
    if (!gate) return;
    gate.go = go;
    this.channel?.postMessage({ type: 'gate', gate: id, go });
    setTimeout(() => this.gates.delete(id), GATE_KEEP_MS);
  }

  /** True while a page of `role` opened in the last {@link OPEN_WAIT_MS} has not said hello yet. */
  isOpening(role: PageRole): boolean {
    if (this.pages.has(role)) return false;
    const since = Date.now() - OPEN_WAIT_MS;
    return [...this.gates.values()].some(
      gate => gate.role === role && gate.at >= since && gate.go !== false
    );
  }

  /** Run control actions (start, restart, stop) one after another (D8). */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.control.then(work, work);
    this.control = run.catch(() => undefined);
    return run;
  }

  /** The revision of the last `pix3_sync`: a page older than it is stale (D6). */
  noteSync(rev: number): void {
    this.syncRev = Math.max(this.syncRev, rev);
  }

  get lastSyncRev(): number {
    return this.syncRev;
  }

  /** True when `page` read the files at least as new as the last sync. */
  isFresh(page: PageInfo): boolean {
    return page.rev === null || page.rev >= this.syncRev;
  }

  errors(since?: number): PageError[] {
    return typeof since === 'number'
      ? this.errorList.filter(e => e.at > since)
      : [...this.errorList];
  }

  clearErrors(): void {
    this.errorList.length = 0;
  }

  private receive(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const frame = data as Record<string, unknown>;
    switch (frame.type) {
      case 'hello': {
        const page = frame.page as PageInfo | undefined;
        if (!page || !isRole(page.role) || typeof page.loadId !== 'string') return;
        const previous = this.pages.get(page.role);
        this.pages.set(page.role, page);
        this.left.delete(page.role);
        // A new agent page starts its idle clock (an open by `window.open` made no call).
        if (page.role === 'agent') this.noteAgentCall(0);
        if (previous && previous.loadId !== page.loadId) this.dropCalls(page.role, previous.loadId);
        break;
      }
      case 'bye':
        if (isRole(frame.role)) {
          this.leave(frame.role, String(frame.loadId), frame.reloading as boolean | undefined);
        }
        return;
      case 'result': {
        const call = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
        if (!call) return;
        this.pending.delete(frame.id as string);
        call.settle((frame.value ?? refusal('error', 'The page answered nothing.')) as PageAnswer);
        return;
      }
      case 'log': {
        if (!isRole(frame.role)) return;
        const error: PageError = {
          at: typeof frame.at === 'number' ? frame.at : Date.now(),
          origin: frame.role,
          loadId: String(frame.loadId),
          message: String(frame.message),
          where: typeof frame.where === 'string' ? frame.where : null,
        };
        this.errorList.push(error);
        if (this.errorList.length > MAX_ERRORS) this.errorList.shift();
        this.logging.error(`[${error.origin} page] ${error.message}`, {
          where: error.where,
          loadId: error.loadId,
        });
        return;
      }
      case 'wait': {
        const gate = typeof frame.gate === 'string' ? this.gates.get(frame.gate) : undefined;
        if (gate && gate.go !== null) {
          this.channel?.postMessage({ type: 'gate', gate: frame.gate, go: gate.go });
        }
        return;
      }
      case 'select':
        if (typeof frame.nodeId === 'string') void this.select(frame.nodeId);
        return;
      default:
        return;
    }
    for (const listener of [...this.changeListeners]) listener();
  }

  /**
   * The load `loadId` of `role` is gone. `reloading: false` = its window closed (the page knows; a
   * page that cannot tell says nothing): nothing will say hello again, so nobody waits for it.
   */
  private leave(role: PageRole, loadId: string, reloading: boolean | undefined): void {
    if (this.pages.get(role)?.loadId !== loadId) return;
    this.pages.delete(role);
    const closedHere = this.closing.delete(loadId);
    if (!closedHere && reloading !== false) this.left.set(role, Date.now());
    this.dropCalls(role, loadId);
    for (const listener of [...this.changeListeners]) listener();
  }

  /** Calls meant for a document that is gone answer `page_reloaded`. */
  private dropCalls(role: PageRole, loadId: string): void {
    for (const [id, call] of this.pending) {
      if (call.role !== role || call.loadId !== loadId) continue;
      this.pending.delete(id);
      call.settle(
        refusal(
          'page_reloaded',
          `The ${role} page went away or reloaded (load ${loadId}) before it answered; a script or bot policy change reloads it.`
        )
      );
    }
  }

  /** "Show in editor" on a page: select the node here and bring this window forward. */
  private async select(nodeId: string): Promise<void> {
    const activeId = appState.scenes.activeSceneId;
    if (!activeId || !this.scenes.getSceneGraph(activeId)?.nodeMap.has(nodeId)) {
      this.logging.info(`"${nodeId}" (shown from the game page) is not in the active scene.`);
      return;
    }
    await resolveCommandDispatcher().execute(selectObject(nodeId));
    window.focus();
  }

  /** The agent's page closes when idle (D7) — never while a call to it is in flight. */
  private noteAgentCall(delta: number): void {
    this.agentCalls += delta;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.agentCalls > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.agentCalls === 0 && appState.project.host.writer !== 'other') {
        void this.close('agent');
      }
    }, AGENT_IDLE_MS);
  }
}
