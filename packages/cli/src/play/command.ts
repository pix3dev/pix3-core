import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { resolveEsbuild, withCommandBundle } from '../package-root.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { findChrome, needsNoSandbox, describeChromeNotFound } from '../editor/chrome.ts';
import { readDevInfo } from '../editor/dev-server.ts';
import { PipeChrome, type CdpEvent } from './chrome-pipe.ts';

/**
 * `pix3 play` — the game's own page (the dev server, or a built `dist/index.html` as it ships) in
 * a private headless Chrome at a phone's size, optionally driven by a bot policy: what the editor
 * does for a scene, done to the real page — the build included. No editor, no MCP, no human.
 */

interface PlayArgs {
  readonly target?: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scene?: string;
  readonly bot?: string;
  readonly seconds: number;
  readonly screenshot?: string;
  /** Where `bot.screenshot(name)` pictures go (default beside --screenshot, else .pix3/screenshots). */
  readonly shots?: string;
  readonly json: boolean;
  readonly project?: string;
}

const DEFAULT_SIZE = { width: 390, height: 844 };

const parsePlayArgs = (argv: readonly string[]): PlayArgs | { error: string } | 'help' => {
  let target: string | undefined;
  let width = DEFAULT_SIZE.width;
  let height = DEFAULT_SIZE.height;
  let scale = 3;
  let scene: string | undefined;
  let bot: string | undefined;
  let seconds: number | undefined;
  let screenshot: string | undefined;
  let shots: string | undefined;
  let json = false;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg];
    const value = (): string | undefined => inline ?? argv[++i];
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--json') json = true;
    else if (flag === '--size') {
      const match = /^(\d+)x(\d+)$/.exec(value() ?? '');
      if (!match) return { error: '--size takes WIDTHxHEIGHT in CSS px, e.g. --size 390x844' };
      width = Number(match[1]);
      height = Number(match[2]);
    } else if (flag === '--scale') scale = Number(value());
    else if (flag === '--scene') scene = value();
    else if (flag === '--bot') bot = value();
    else if (flag === '--seconds') seconds = Number(value());
    else if (flag === '--screenshot') screenshot = value();
    else if (flag === '--shots') shots = value();
    else if (flag === '--project') project = value();
    else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (target === undefined) target = arg;
    else return { error: `one target at a time (got ${target} and ${arg})` };
  }
  if (!Number.isFinite(scale) || scale <= 0) return { error: '--scale takes a positive number' };
  const budget = seconds ?? (bot ? 60 : 3);
  if (!Number.isFinite(budget) || budget <= 0)
    return { error: '--seconds takes a positive number' };
  return {
    target,
    width,
    height,
    scale,
    scene,
    bot,
    seconds: budget,
    screenshot,
    shots,
    json,
    project,
  };
};

/** The page to open: an explicit URL or file, `dist`, else the running dev server, else `dist`. */
const resolveTarget = (
  args: PlayArgs,
  root: string | null,
  cwd: string
): string | { error: string } => {
  const withScene = (url: string): string =>
    args.scene
      ? `${url}${url.includes('?') ? '&' : '?'}scene=${encodeURIComponent(args.scene)}`
      : url;
  const dist = root ? join(root, 'dist', 'index.html') : null;
  if (args.target && /^(https?|file):/.test(args.target)) return withScene(args.target);
  if (args.target && args.target !== 'dist' && args.target !== 'dev') {
    const file = isAbsolute(args.target) ? args.target : resolve(cwd, args.target);
    const html = file.endsWith('.html') ? file : join(file, 'index.html');
    return existsSync(html) ? pathToFileURL(html).href : { error: `${html} does not exist` };
  }
  if (args.target !== 'dist') {
    const info = root ? readDevInfo(root) : null;
    if (info) return withScene(`${info.publicUrl ?? info.url}?clean`);
    if (args.target === 'dev') {
      return {
        error: 'no dev server is running for this project (`npm run dev`, or `npx pix3 editor`)',
      };
    }
  }
  if (dist && existsSync(dist)) {
    if (args.scene) return { error: '--scene needs the dev server: a build boots its entry scene' };
    return pathToFileURL(dist).href;
  }
  return {
    error:
      'nothing to play: no dev server is running and there is no dist/index.html (`npm run build`)',
  };
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface PlayReport {
  readonly url: string;
  readonly size: string;
  readonly status: string;
  readonly frames: number;
  readonly errors: string[];
  readonly bot?: Record<string, unknown>;
  readonly game: unknown;
  readonly screenshot?: string;
  /** The pictures the policy took with `bot.screenshot(name)`, in order. */
  readonly screenshots?: readonly { name: string; frame: number; path: string }[];
}

/** How often the CLI asks the page whether the policy is done or wants a picture. */
const POLL_MS = 50;

export const runPlayCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parsePlayArgs(argv);
  if (parsed === 'help') {
    io.stdout(COMMAND_USAGE.play);
    return 0;
  }
  if ('error' in parsed) {
    io.stderr(`pix3 play: ${parsed.error}\n\n${COMMAND_USAGE.play}`);
    return 2;
  }
  const args = parsed;
  const env = io.env ?? process.env;
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  const url = resolveTarget(args, root, io.cwd);
  if (typeof url !== 'string') {
    io.stderr(`pix3 play: ${url.error}\n`);
    return 2;
  }
  let policyScript: string | null = null;
  if (args.bot) {
    const file = join(root ?? io.cwd, 'design', 'tests', 'bots', `${args.bot}.ts`);
    const esbuild = resolveEsbuild();
    if (!existsSync(file)) {
      io.stderr(`pix3 play: no bot policy ${file}\n`);
      return 2;
    }
    if (!esbuild) {
      io.stderr(
        'pix3 play: esbuild is not installed (npm install), so the policy cannot compile\n'
      );
      return 2;
    }
    try {
      policyScript = await (await import('./bundle.ts')).compilePolicy(esbuild, file);
    } catch (error) {
      io.stderr(`pix3 play: the policy does not compile: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const chromePath = findChrome(env);
  if (!chromePath) {
    io.stderr(`pix3 play: ${describeChromeNotFound()}\n`);
    return 2;
  }

  const chrome = PipeChrome.launch(chromePath.path, {
    noSandbox: needsNoSandbox(chromePath.path, env),
  });
  const errors: string[] = [];
  try {
    const session = await chrome.openPage();
    chrome.onEvent((event: CdpEvent) => {
      if (event.sessionId !== session) return;
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
        };
        errors.push(details.exception?.description ?? details.text ?? 'an uncaught exception');
      } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        const parts = (event.params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        errors.push(parts.map(part => String(part.value ?? part.description ?? '')).join(' '));
      }
    });
    await chrome.send('Runtime.enable', {}, session);
    await chrome.send(
      'Emulation.setDeviceMetricsOverride',
      { width: args.width, height: args.height, deviceScaleFactor: args.scale, mobile: true },
      session
    );
    await chrome.send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
      session
    );
    await chrome.send('Page.enable', {}, session);
    await chrome.send('Page.navigate', { url }, session);

    // Booted when the player says so (`__PIX3_PLAYER__.status`), within 20 s.
    let status = 'booting';
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      await sleep(200);
      status = String(
        (await chrome
          .evaluate(session, 'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.status : "no-player"')
          .catch(() => 'loading')) ?? 'loading'
      );
      if (status === 'running' || status === 'failed') break;
    }

    let botReport: Record<string, unknown> | undefined;
    const shots: { name: string; frame: number; path: string }[] = [];
    if (status === 'running' && policyScript !== null && args.bot) {
      const host = await withCommandBundle(
        'play',
        'page-bot-host.js',
        async outdir => (await import('./bundle.ts')).buildPlayBundle(outdir),
        async dir => (await import('./bundle.ts')).readPlayHost(dir)
      );
      await chrome.evaluate(session, host);
      await chrome.evaluate(session, policyScript);
      await chrome.evaluate(
        session,
        `window.__PIX3_PAGE_BOT_HOST__.startPageBot(${JSON.stringify(args.bot)}, window.__PIX3_BOT_POLICY__), true`
      );
      // One evaluate per poll: whether the policy is done, and the next picture it asked for
      // (`bot.screenshot`) — the page holds the game paused on that frame until `resume()`.
      const shotDir = resolve(
        io.cwd,
        args.shots ??
          join(
            args.screenshot
              ? dirname(args.screenshot)
              : join(root ?? io.cwd, '.pix3', 'screenshots'),
            `play-${Date.now()}`
          )
      );
      for (const deadline = Date.now() + args.seconds * 1000; Date.now() < deadline; ) {
        await sleep(POLL_MS);
        const poll = (await chrome.evaluate(
          session,
          '(() => { const b = window.__PIX3_PAGE_BOT__; return { finished: b.finished, shot: b.takeShot() }; })()'
        )) as { finished?: boolean; shot?: { name: string; frame: number } | null } | null;
        if (poll?.shot) {
          const shot = (await chrome.send(
            'Page.captureScreenshot',
            { format: 'png' },
            session
          )) as {
            data?: string;
          };
          const path = join(shotDir, `${poll.shot.name}.png`);
          mkdirSync(shotDir, { recursive: true });
          writeFileSync(path, Buffer.from(shot.data ?? '', 'base64'));
          shots.push({ name: poll.shot.name, frame: poll.shot.frame, path });
          await chrome.evaluate(session, 'window.__PIX3_PAGE_BOT__.resume()');
          continue;
        }
        if (poll?.finished) break;
      }
      botReport = (await chrome.evaluate(session, 'window.__PIX3_PAGE_BOT__.stop()')) as Record<
        string,
        unknown
      >;
    } else if (status === 'running') {
      await sleep(args.seconds * 1000);
    }

    const frames = Number(
      (await chrome.evaluate(
        session,
        'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.frames : 0'
      )) ?? 0
    );
    const playerErrors = ((await chrome.evaluate(
      session,
      'window.__PIX3_PLAYER__ ? window.__PIX3_PLAYER__.errors : []'
    )) ?? []) as string[];
    for (const error of playerErrors) if (!errors.includes(error)) errors.push(error);
    const game = await chrome
      .evaluate(
        session,
        'window.__PIX3_GAME_DEBUG__ && window.__PIX3_GAME_DEBUG__.snapshot ? JSON.parse(JSON.stringify(window.__PIX3_GAME_DEBUG__.snapshot())) : null'
      )
      .catch(() => null);

    let screenshotPath: string | undefined;
    if (args.screenshot) {
      const shot = (await chrome.send('Page.captureScreenshot', { format: 'png' }, session)) as {
        data?: string;
      };
      screenshotPath = resolve(io.cwd, args.screenshot);
      mkdirSync(dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, Buffer.from(shot.data ?? '', 'base64'));
    }

    const report: PlayReport = {
      url,
      size: `${args.width}x${args.height}@${args.scale}x`,
      status,
      frames,
      errors,
      ...(botReport ? { bot: botReport } : {}),
      game,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(shots.length > 0 ? { screenshots: shots } : {}),
    };
    const done = botReport?.done as { pass?: boolean; reason?: string } | undefined;
    const botFailed =
      botReport !== undefined && (done?.pass !== true || botReport.error !== undefined);
    if (args.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else io.stdout(formatPlayHuman(report));
    return status !== 'running' || errors.length > 0 || botFailed ? 1 : 0;
  } catch (error) {
    io.stderr(`pix3 play: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await chrome.close();
  }
};

const formatPlayHuman = (report: PlayReport): string => {
  const lines = [
    `${report.url} at ${report.size}: ${report.status}, ${report.frames} frame(s)`,
    ...report.errors.map(error => `  error: ${error}`),
  ];
  if (report.bot) {
    const done = report.bot.done as { pass?: boolean; reason?: string; frame?: number } | undefined;
    const crash = report.bot.error as { message?: string } | undefined;
    lines.push(
      crash
        ? `bot ${String(report.bot.name)}: CRASHED — ${crash.message ?? ''}`
        : done
          ? `bot ${String(report.bot.name)}: ${done.pass ? 'PASS' : 'FAIL'} at frame ${done.frame} — ${done.reason}`
          : `bot ${String(report.bot.name)}: no verdict in the time given (${String(report.bot.frames)} ticks, ${String(report.bot.sent)} action(s))`
    );
    const log = (report.bot.log as Array<{ frame: number; kind: string; message: string }>) ?? [];
    for (const entry of log.slice(-12))
      lines.push(`  [${entry.frame}] ${entry.kind}: ${entry.message}`);
  }
  if (report.game !== null && report.game !== undefined) {
    lines.push(`game: ${JSON.stringify(report.game)}`);
  }
  if (report.screenshot) lines.push(`screenshot: ${report.screenshot}`);
  for (const shot of report.screenshots ?? [])
    lines.push(`screenshot ${shot.name} (frame ${shot.frame}): ${shot.path}`);
  return `${lines.join('\n')}\n`;
};
