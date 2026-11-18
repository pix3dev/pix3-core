import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { proxyCall } from '../editor/chrome-owner.ts';
import { readDevInfo } from '../editor/dev-server.ts';
import {
  CdpPage,
  listPages,
  resolveProxyEndpoint,
  swipeBetween,
  tapAt,
  type PageTarget,
  type ProxyEndpoint,
} from './cdp-page.ts';

/**
 * `pix3 bridge` — the editor tab's `pix3_*` tools, its screenshot and real pointer input, from the
 * command line: the same tab and token proxy the `pix3-browser` MCP server uses, for an agent that
 * cannot load that server (a subagent, CI, a session not restarted after `pix3 agent-setup`).
 *
 *   pix3 bridge pix3_sync '{"timeoutMs":15000}'      any pix3_* tool, params as JSON
 *   pix3 bridge screenshot [--target game] [--page designer|agent] [--aspect 9:16] [--out f.png]
 *   pix3 bridge tap <x> <y> | --node <id> [--touch]
 *   pix3 bridge swipe <x1> <y1> <x2> <y2> | --from <id> --to <id> [--touch] [--ms 180]
 *
 * When the editor plays on the game's own page (its `playHost: 'page'` setting, plan
 * play-in-page S4), the game is another CDP target: `screenshot` captures the page
 * `pix3_screenshot` names, `tap` / `swipe` go to the agent's page only (the human's is
 * `not_your_page`) and refuse coordinates read from another load of it (`page_reloaded`); a
 * `pix3_play start` the browser's popup blocker refused is opened with `Target.createTarget` in
 * the Chrome `pix3 editor` owns.
 */

interface Parsed {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

const parse = (argv: readonly string[]): Parsed => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags.set(name, inline);
    else if (['touch', 'json', 'help'].includes(name)) flags.set(name, true);
    else flags.set(name, argv[++i] ?? '');
  }
  return { positionals, flags };
};

const str = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** The editor tabs: the pages on this project's editor URL (dev.json), else any `/__pix3/` page. */
const findEditorPages = (pages: readonly PageTarget[], root: string | null): PageTarget[] => {
  const info = root ? readDevInfo(root) : null;
  const urls = [info?.editorUrl, info?.publicEditorUrl].filter((u): u is string => Boolean(u));
  const own = pages.filter(page => urls.some(url => page.url.startsWith(url)));
  return own.length > 0 ? own : pages.filter(page => page.url.includes('/__pix3/'));
};

/** Call one bridge tool in the page; `pix3_*` answers are JSON objects. */
const callTool = async (
  page: CdpPage,
  tool: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const expression = `(async () => {
    const bridge = window.__PIX3_DEBUG__;
    if (!bridge || typeof bridge.call !== 'function') return { ok: false, reason: 'no_bridge', detail: 'window.__PIX3_DEBUG__ is not on this page (is it the editor, and has it finished loading?)' };
    return await bridge.call(${JSON.stringify(tool)}, ${JSON.stringify(params)});
  })()`;
  // pix3_game_run waits up to 180 s of wall clock (maxWallMs) plus settle time.
  const value = await page.evaluate(expression, 240_000);
  return (value ?? { ok: false, reason: 'no_answer' }) as Record<string, unknown>;
};

/**
 * The editor tab to talk to. With a second tab open on the project, the writer (`pix3_status`
 * `writer: "self"`): a read-only tab refuses to drive the agent's game page (`not_your_page`).
 */
const openEditorPage = async (
  endpoint: ProxyEndpoint,
  editors: readonly PageTarget[]
): Promise<CdpPage> => {
  for (const target of editors.length > 1 ? editors : []) {
    const page = await CdpPage.open(endpoint, target.id);
    const status = await callTool(page, 'pix3_status', {}).catch(() => null);
    if (status?.writer === 'self') return page;
    page.close();
  }
  return CdpPage.open(endpoint, editors[0].id);
};

/** A game page as `pix3_status.play.pages` lists it (the `playHost: 'page'` setting). */
interface GamePage {
  readonly role: string;
  readonly url: string;
  readonly loadId: string;
  readonly paused?: boolean;
  readonly pausedBy?: string;
}

/** The game pages when the editor plays on the game's page, else null (the Game tab). */
const gamePages = async (editor: CdpPage): Promise<GamePage[] | null> => {
  const status = await callTool(editor, 'pix3_status', {});
  const play = status.play as { playHost?: string; pages?: GamePage[] } | undefined;
  return play?.playHost === 'page' ? (play.pages ?? []) : null;
};

/** Hide (`'hidden'`) or show again (`''`) the game page's debug overlay. */
const overlayVisibility = (visibility: '' | 'hidden'): string =>
  `document.querySelectorAll('.pix3-debug-overlay').forEach(el => { el.style.visibility = ${JSON.stringify(visibility)}; })`;

/** The CDP target of a game page: its exact URL, else any page of that role. */
const targetOfPage = (targets: readonly PageTarget[], page: { url: string; role: string }) =>
  targets.find(target => target.url === page.url) ??
  targets.find(target => new URL(target.url).searchParams.get('role') === page.role) ??
  null;

/** A point where input goes, with the load the coordinates were read from (page host only). */
interface InputPoint {
  readonly x: number;
  readonly y: number;
  readonly loadId?: string;
}

/** The page CSS px of a node's origin, from `pix3_scene {nodeId}` (`screen`). */
const screenOfNode = async (
  page: CdpPage,
  nodeId: string,
  onPage: boolean
): Promise<InputPoint | string> => {
  const answer = await callTool(
    page,
    'pix3_scene',
    onPage ? { nodeId, page: 'agent' } : { nodeId }
  );
  if (answer.ok === false) return `pix3_scene ${nodeId}: ${String(answer.detail ?? answer.reason)}`;
  const screen = answer.screen as { x: number; y: number } | null | undefined;
  const at = answer.page as { loadId?: string } | undefined;
  if (onPage && !at) return `"${nodeId}" is not in your running game (pix3_play start first?)`;
  return screen
    ? { ...screen, loadId: at?.loadId }
    : `"${nodeId}" has no screen position (is the scene open, or the game playing?)`;
};

/** How long `Target.createTarget`'s page may take to tell the editor it is ready. */
const NEW_PAGE_WAIT_MS = 90_000;

/**
 * `pix3_play start|restart` answered `popup_blocked` (D9): in the Chrome `pix3 editor` owns, open
 * the URL as a new target and wait for the editor to see the page; elsewhere (a forwarded Chrome
 * over SSH) the refusal stands — it carries the URL.
 */
const openBlockedPage = async (
  endpoint: ProxyEndpoint,
  editor: CdpPage,
  answer: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  if (answer.reason !== 'popup_blocked' || typeof answer.url !== 'string') return answer;
  if (endpoint.kind !== 'local') return answer;
  await proxyCall(endpoint.port, endpoint.token, 'Target.createTarget', { url: answer.url });
  const deadline = Date.now() + NEW_PAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const agent = (await gamePages(editor))?.find(page => page.role === 'agent');
    if (agent) return { ok: true, page: agent, opened: 'Target.createTarget' };
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return {
    ...answer,
    detail: `${String(answer.detail)} (Target.createTarget opened it, but it never reported ready)`,
  };
};

/** How long a changed Game tab frame takes to re-fit before the screenshot. */
const ASPECT_SETTLE_MS = 250;

/**
 * A tap or swipe into a paused game reaches a frozen frame, and nothing answers it until play
 * resumes (core-tests/game8). The pause `pix3_game_run` leaves on its outcome frame is lifted here,
 * before the input, and said so — game18 spent a swipe on it and read the warning after the fact.
 * A pause someone asked for (the Pause button, `pix3_play pause`) stays: it is said, not undone.
 */
const releaseRunPause = async (
  page: CdpPage,
  io: CliIo,
  command: string,
  agent: GamePage | null
): Promise<void> => {
  const play = agent
    ? { status: agent.paused ? 'paused' : 'playing', pausedBy: agent.pausedBy }
    : await callTool(page, 'pix3_play', { action: 'status' });
  if (play.ok === false || play.status !== 'paused') return;
  if (play.pausedBy === 'pix3_game_run') {
    const resumed = await callTool(page, 'pix3_play', { action: 'resume' });
    io.stderr(
      resumed.ok === false
        ? `pix3 bridge ${command}: the game is paused on a pix3_game_run outcome frame and would not resume (${String(resumed.detail ?? resumed.reason)}), so nothing reacts to this input.\n`
        : `pix3 bridge ${command}: resumed the game pix3_game_run had left paused on its outcome frame.\n`
    );
    return;
  }
  io.stderr(
    `pix3 bridge ${command}: the game is paused (someone pressed Pause, or pix3_play pause), so nothing reacts until it resumes: pix3 bridge play '{"action":"resume"}'.\n`
  );
};

const numbers = (values: readonly string[]): number[] | null => {
  const parsed = values.map(Number);
  return parsed.every(Number.isFinite) ? parsed : null;
};

export const runBridgeCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parse(argv);
  const [command, ...rest] = parsed.positionals;
  if (parsed.flags.has('help') || !command) {
    io.stdout(COMMAND_USAGE.bridge);
    return command || parsed.flags.has('help') ? 0 : 2;
  }
  const env = io.env ?? process.env;
  const endpoint: ProxyEndpoint | null = resolveProxyEndpoint(env);
  if (!endpoint) {
    io.stderr(
      'pix3 bridge: no editor Chrome to talk to — run `npx pix3 editor` (or `--headless` on a box with no screen) first.\n'
    );
    return 2;
  }
  const root = str(parsed, 'project')
    ? resolve(io.cwd, str(parsed, 'project') as string)
    : findProjectRoot(io.cwd);
  let pages: PageTarget[];
  try {
    pages = await listPages(endpoint);
  } catch (error) {
    io.stderr(
      `pix3 bridge: the CDP proxy on port ${endpoint.port} (${endpoint.kind}) does not answer: ${(error as Error).message}. Run \`npx pix3 editor\` again.\n`
    );
    return 2;
  }
  const editors = findEditorPages(pages, root);
  if (editors.length === 0) {
    io.stderr(
      `pix3 bridge: Chrome has no editor tab (${pages.length} page(s) open). Run \`npx pix3 editor\`: it opens one.\n`
    );
    return 2;
  }
  const page = await openEditorPage(endpoint, editors);
  // tap / swipe on the page host: the agent's game page, not the editor tab.
  let agentPage: GamePage | null = null;
  let inputPage = page;
  try {
    const touch = parsed.flags.has('touch');
    if (command === 'screenshot') {
      const surface = str(parsed, 'target') ?? 'game';
      const aspect = str(parsed, 'aspect');
      if (aspect !== undefined) {
        // The Game tab's frame (pix3_play `aspect`): a phone-shaped shot from the editor.
        const set = await callTool(page, 'pix3_play', { action: 'status', aspect });
        if (set.ok === false) {
          io.stderr(`pix3 bridge screenshot --aspect: ${String(set.detail ?? set.reason)}\n`);
          return 2;
        }
        // The tab re-fits its frame on the next animation frame.
        await new Promise(resolve => setTimeout(resolve, ASPECT_SETTLE_MS));
      }
      const which = str(parsed, 'page');
      const front = await callTool(page, 'pix3_screenshot', {
        target: surface,
        ...(which ? { page: which } : {}),
      });
      if (front.ok === false) {
        io.stderr(`pix3 bridge screenshot: ${String(front.detail ?? front.reason)}\n`);
        return 1;
      }
      // On the page host the game is its own target: capture the page the editor named.
      const gamePage = front.page as { url: string; role: string } | undefined;
      const gameTarget = gamePage ? targetOfPage(pages, gamePage) : null;
      if (gamePage && !gameTarget) {
        io.stderr(
          `pix3 bridge screenshot: no browser target for the ${gamePage.role} page ${gamePage.url}\n`
        );
        return 1;
      }
      const shooter = gameTarget ? await CdpPage.open(endpoint, gameTarget.id) : page;
      let shot: { data?: string };
      try {
        // A target in the background paints no frame to capture (headless: none at all) — with
        // a game page open the editor tab is one of two.
        await shooter.send('Page.bringToFront');
        // The game as it plays: the page's collapsed debug overlay sits over its top HUD.
        if (shooter !== page) await shooter.evaluate(overlayVisibility('hidden')).catch(() => null);
        shot = (await shooter.send('Page.captureScreenshot', { format: 'png' })) as {
          data?: string;
        };
      } finally {
        if (shooter !== page) {
          await shooter.evaluate(overlayVisibility('')).catch(() => null);
          shooter.close();
        }
      }
      const out = resolve(
        io.cwd,
        str(parsed, 'out') ??
          join(root ?? io.cwd, '.pix3', 'screenshots', `${surface}-${Date.now()}.png`)
      );
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(shot.data ?? '', 'base64'));
      io.stdout(`${out}\n`);
      return 0;
    }
    if (command === 'render') {
      // pix3_render_model with the sheet as a data URL, written to a PNG.
      const params: Record<string, unknown> = { image: true };
      for (const key of ['node', 'views', 'lights', 'background'] as const) {
        const value = str(parsed, key);
        if (value !== undefined) params[key === 'node' ? 'nodeId' : key] = value;
      }
      if (str(parsed, 'size') !== undefined) params.size = Number(str(parsed, 'size'));
      const answer = await callTool(page, 'pix3_render_model', params);
      if (answer.ok === false) {
        io.stderr(`pix3 bridge render: ${String(answer.detail ?? answer.reason)}\n`);
        return 1;
      }
      const { image, ...info } = answer;
      const out = resolve(
        io.cwd,
        str(parsed, 'out') ??
          join(root ?? io.cwd, '.pix3', 'renders', `editor-${str(parsed, 'node') ?? 'scene'}.png`)
      );
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        Buffer.from(String(image).replace(/^data:image\/png;base64,/, ''), 'base64')
      );
      io.stdout(`${out}\n${JSON.stringify(info, null, 2)}\n`);
      return 0;
    }
    if (command === 'tap' || command === 'swipe') {
      if (str(parsed, 'page') === 'designer') {
        io.stderr(
          `pix3 bridge ${command}: not_your_page — the human's game page is read-only for you; input goes to your own page.\n`
        );
        return 2;
      }
      const onPage = await gamePages(page);
      const agent = onPage?.find(game => game.role === 'agent') ?? null;
      if (onPage && !agent) {
        io.stderr(
          `pix3 bridge ${command}: no_game_page — pix3_play {"action":"start"} opens your game page first.\n`
        );
        return 2;
      }
      const target = agent ? targetOfPage(pages, agent) : null;
      if (agent && !target) {
        io.stderr(`pix3 bridge ${command}: no browser target for your game page ${agent.url}\n`);
        return 2;
      }
      inputPage = target ? await CdpPage.open(endpoint, target.id) : page;
      agentPage = agent;
    }
    /** Coordinates read from another load of the page would land somewhere else. */
    const sameLoad = async (points: readonly InputPoint[]): Promise<string | null> => {
      const wanted = points.find(point => point.loadId)?.loadId;
      if (!wanted || inputPage === page) return null;
      const loadId = await inputPage.evaluate(
        'window.__PIX3_PLAYER__ && window.__PIX3_PLAYER__.loadId'
      );
      return loadId === wanted
        ? null
        : 'page_reloaded — your game page reloaded after the node was read; read it again.';
    };
    if (command === 'tap') {
      const node = str(parsed, 'node');
      const point = node
        ? await screenOfNode(page, node, agentPage !== null)
        : numbers(rest.slice(0, 2));
      if (typeof point === 'string' || !point || (Array.isArray(point) && point.length < 2)) {
        io.stderr(
          `pix3 bridge tap: ${typeof point === 'string' ? point : 'give <x> <y> (page CSS px) or --node <id>'}\n`
        );
        return 2;
      }
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      const moved = Array.isArray(point) ? null : await sameLoad([point]);
      if (moved) {
        io.stderr(`pix3 bridge tap: ${moved}\n`);
        return 1;
      }
      await releaseRunPause(page, io, 'tap', agentPage);
      await tapAt(inputPage, x, y, { touch });
      io.stdout(`tapped (${Math.round(x)}, ${Math.round(y)})${touch ? ' with a touch' : ''}\n`);
      return 0;
    }
    if (command === 'swipe') {
      const fromNode = str(parsed, 'from');
      const toNode = str(parsed, 'to');
      let from: InputPoint;
      let to: InputPoint;
      if (fromNode && toNode) {
        const a = await screenOfNode(page, fromNode, agentPage !== null);
        const b = await screenOfNode(page, toNode, agentPage !== null);
        if (typeof a === 'string' || typeof b === 'string') {
          io.stderr(`pix3 bridge swipe: ${typeof a === 'string' ? a : b}\n`);
          return 2;
        }
        const moved = await sameLoad([a, b]);
        if (moved) {
          io.stderr(`pix3 bridge swipe: ${moved}\n`);
          return 1;
        }
        from = a;
        to = b;
      } else {
        const values = numbers(rest.slice(0, 4));
        if (!values || values.length < 4) {
          io.stderr(
            'pix3 bridge swipe: give <x1> <y1> <x2> <y2> (page CSS px) or --from <id> --to <id>\n'
          );
          return 2;
        }
        from = { x: values[0], y: values[1] };
        to = { x: values[2], y: values[3] };
      }
      await releaseRunPause(page, io, 'swipe', agentPage);
      const ms = Number(str(parsed, 'ms') ?? 180);
      await swipeBetween(inputPage, from, to, {
        touch,
        durationMs: Number.isFinite(ms) ? ms : 180,
      });
      io.stdout(
        `swiped (${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(to.x)}, ${Math.round(to.y)})${touch ? ' with a touch' : ''}\n`
      );
      return 0;
    }
    // Anything else is a tool name: `pix3_sync`, `pix3_scene`, … (`sync` works too).
    const tool = command.startsWith('pix3_') ? command : `pix3_${command}`;
    let params: Record<string, unknown> = {};
    if (rest[0] !== undefined) {
      try {
        const value = JSON.parse(rest[0]) as unknown;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
        params = value as Record<string, unknown>;
      } catch {
        io.stderr(
          `pix3 bridge ${tool}: params must be one JSON object, e.g. '{"timeoutMs":15000}'\n`
        );
        return 2;
      }
    }
    let answer = await callTool(page, tool, params);
    if (tool === 'pix3_play') answer = await openBlockedPage(endpoint, page, answer);
    io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
    return answer.ok === false ? 1 : 0;
  } catch (error) {
    io.stderr(`pix3 bridge: ${(error as Error).message}\n`);
    return 1;
  } finally {
    if (inputPage !== page) inputPage.close();
    page.close();
  }
};
