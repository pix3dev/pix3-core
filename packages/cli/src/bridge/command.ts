import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';
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
 *   pix3 bridge screenshot [--target game] [--aspect 9:16] [--out f.png]
 *   pix3 bridge tap <x> <y> | --node <id> [--touch]
 *   pix3 bridge swipe <x1> <y1> <x2> <y2> | --from <id> --to <id> [--touch] [--ms 180]
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

/** The editor tab: the page on this project's editor URL (dev.json), else any `/__pix3/` page. */
const findEditorPage = (pages: readonly PageTarget[], root: string | null): PageTarget | null => {
  const info = root ? readDevInfo(root) : null;
  const urls = [info?.editorUrl, info?.publicEditorUrl].filter((u): u is string => Boolean(u));
  return (
    pages.find(page => urls.some(url => page.url.startsWith(url))) ??
    pages.find(page => page.url.includes('/__pix3/')) ??
    null
  );
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
  // pix3_game_run waits up to 60 s of wall clock (maxWallMs) plus settle time.
  const value = await page.evaluate(expression, 120_000);
  return (value ?? { ok: false, reason: 'no_answer' }) as Record<string, unknown>;
};

/** The page CSS px of a node's origin, from `pix3_scene {nodeId}` (`screen`). */
const screenOfNode = async (
  page: CdpPage,
  nodeId: string
): Promise<{ x: number; y: number } | string> => {
  const answer = await callTool(page, 'pix3_scene', { nodeId });
  if (answer.ok === false) return `pix3_scene ${nodeId}: ${String(answer.detail ?? answer.reason)}`;
  const screen = answer.screen as { x: number; y: number } | null | undefined;
  return screen ?? `"${nodeId}" has no screen position (is the scene open, or the game playing?)`;
};

/** How long a changed Game tab frame takes to re-fit before the screenshot. */
const ASPECT_SETTLE_MS = 250;

/**
 * A tap or swipe into a paused game reaches a frozen frame — `pix3_game_run` leaves play paused on
 * its outcome — and nothing answers it until play resumes (core-tests/game8). Said, not fixed: the
 * pause may be the point (a screenshot of the judged frame).
 */
const warnIfPaused = async (page: CdpPage, io: CliIo, command: string): Promise<void> => {
  const play = await callTool(page, 'pix3_play', { action: 'status' });
  if (play.ok !== false && play.status === 'paused') {
    io.stderr(
      `pix3 bridge ${command}: the game is paused (pix3_game_run leaves it paused on its outcome frame), so nothing reacts until it resumes: pix3 bridge play '{"action":"resume"}'.\n`
    );
  }
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
  const target = findEditorPage(pages, root);
  if (!target) {
    io.stderr(
      `pix3 bridge: Chrome has no editor tab (${pages.length} page(s) open). Run \`npx pix3 editor\`: it opens one.\n`
    );
    return 2;
  }
  const page = await CdpPage.open(endpoint, target.id);
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
      const front = await callTool(page, 'pix3_screenshot', { target: surface });
      if (front.ok === false) {
        io.stderr(`pix3 bridge screenshot: ${String(front.detail ?? front.reason)}\n`);
        return 1;
      }
      const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as {
        data?: string;
      };
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
    if (command === 'tap') {
      const node = str(parsed, 'node');
      const point = node ? await screenOfNode(page, node) : numbers(rest.slice(0, 2));
      if (typeof point === 'string' || !point || (Array.isArray(point) && point.length < 2)) {
        io.stderr(
          `pix3 bridge tap: ${typeof point === 'string' ? point : 'give <x> <y> (page CSS px) or --node <id>'}\n`
        );
        return 2;
      }
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      await warnIfPaused(page, io, 'tap');
      await tapAt(page, x, y, { touch });
      io.stdout(`tapped (${Math.round(x)}, ${Math.round(y)})${touch ? ' with a touch' : ''}\n`);
      return 0;
    }
    if (command === 'swipe') {
      const fromNode = str(parsed, 'from');
      const toNode = str(parsed, 'to');
      let from: { x: number; y: number };
      let to: { x: number; y: number };
      if (fromNode && toNode) {
        const a = await screenOfNode(page, fromNode);
        const b = await screenOfNode(page, toNode);
        if (typeof a === 'string' || typeof b === 'string') {
          io.stderr(`pix3 bridge swipe: ${typeof a === 'string' ? a : b}\n`);
          return 2;
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
      await warnIfPaused(page, io, 'swipe');
      const ms = Number(str(parsed, 'ms') ?? 180);
      await swipeBetween(page, from, to, { touch, durationMs: Number.isFinite(ms) ? ms : 180 });
      io.stdout(
        `swiped (${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(to.x)}, ${Math.round(to.y)})\n`
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
    const answer = await callTool(page, tool, params);
    io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
    return answer.ok === false ? 1 : 0;
  } catch (error) {
    io.stderr(`pix3 bridge: ${(error as Error).message}\n`);
    return 1;
  } finally {
    page.close();
  }
};
