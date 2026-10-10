import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { chooseCdpPort } from './cdp-port.ts';
import { ensureCdpToken } from './cdp-token.ts';
import {
  describeChromeNotFound,
  ensureProfileDir,
  findChrome,
  handoffArgs,
  launchDetached,
} from './chrome.ts';
import { proxyCall, startChromeOwner, stopChromeOwner } from './chrome-owner.ts';
import { readChromeState } from './chrome-state.ts';
import { findDevServer, startDevServer, stopDevServer, type DevInfo } from './dev-server.ts';
import { cdpWsEndpoint, chromeProfileDir, DEFAULT_CDP_PORT } from './paths.ts';
import { checkAgentConfig } from '../agent-setup/config.ts';

/**
 * `pix3 editor` (plan §D.3, §D.4, §D.5): the dev server from `.pix3/dev.json` (started when
 * there is none), then Chrome opening the editor as an app window — owned by a detached process
 * through `--remote-debugging-pipe` and reachable only through the token proxy
 * `ws://127.0.0.1:9333/pix3` (or the next free port, explained). Idempotent: run it again and it
 * reuses what runs.
 *
 * `--stop` ends the dev server; `--stop-chrome` ends the proxy and its Chrome. `--chrome-only`
 * opens Chrome against the recorded server only. `--no-chrome` starts the server only (CI, a
 * headless box). Under `SSH_CONNECTION` Chrome is not launched (plan §E.3: the browser is on the
 * other machine). `--cdp-port <n>` moves the port (a test harness; the MCP config must then be
 * repaired with the same port).
 */

export interface EditorIo {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The script that runs `pix3`, for the detached Chrome owner (default: `process.argv[1]`). */
  readonly entry?: string;
}

export interface EditorArgs {
  readonly projectDir?: string;
  readonly stop?: boolean;
  readonly stopChrome?: boolean;
  readonly chromeOnly?: boolean;
  readonly noChrome?: boolean;
  readonly headless?: boolean;
  readonly cdpPort?: number;
  readonly devPort?: number;
}

export const parseEditorArgs = (argv: readonly string[]): EditorArgs | { error: string } => {
  const out: {
    -readonly [K in keyof EditorArgs]: EditorArgs[K];
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | { error: string } => {
      const next = argv[++i];
      return next === undefined || next.startsWith('-') ? { error: `${arg} needs a value` } : next;
    };
    const port = (): number | { error: string } => {
      const raw = value();
      if (typeof raw !== 'string') return raw;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : { error: `${arg} needs a port` };
    };
    switch (arg) {
      case '--stop':
        out.stop = true;
        break;
      case '--stop-chrome':
        out.stopChrome = true;
        break;
      case '--chrome-only':
        out.chromeOnly = true;
        break;
      case '--no-chrome':
        out.noChrome = true;
        break;
      case '--headless':
        out.headless = true;
        break;
      case '--project': {
        const v = value();
        if (typeof v !== 'string') return v;
        out.projectDir = v;
        break;
      }
      case '--cdp-port': {
        const v = port();
        if (typeof v !== 'number') return v;
        out.cdpPort = v;
        break;
      }
      case '--port': {
        const v = port();
        if (typeof v !== 'number') return v;
        out.devPort = v;
        break;
      }
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  return out;
};

const projectRootOf = (io: EditorIo, args: EditorArgs): string | null => {
  const start = args.projectDir ? resolve(io.cwd, args.projectDir) : io.cwd;
  const root = args.projectDir ? start : findProjectRoot(start);
  return root && existsSync(join(root, PROJECT_MANIFEST_FILE)) ? root : null;
};

export const runEditorCli = async (argv: readonly string[], io: EditorIo): Promise<number> => {
  const parsed = parseEditorArgs(argv);
  if ('error' in parsed) {
    io.stderr(`pix3 editor: ${parsed.error}\n`);
    return 1;
  }
  const env = io.env ?? process.env;
  if (parsed.stopChrome) {
    // Not a project matter: one Chrome and proxy serve every project of the user.
    const state = readChromeState(env);
    if (!state?.ownerPid) {
      io.stdout('No Chrome owner recorded in ~/.pix3/chrome.json.\n');
      return 0;
    }
    const stopped = await stopChromeOwner(state.ownerPid);
    io.stdout(
      stopped
        ? `Stopped Chrome and its CDP proxy on port ${state.port} (owner pid ${state.ownerPid}).\n`
        : `The Chrome owner recorded (pid ${state.ownerPid}) is not running or did not stop.\n`
    );
    return 0;
  }
  const root = projectRootOf(io, parsed);
  if (!root) {
    io.stderr(
      `pix3 editor: no ${PROJECT_MANIFEST_FILE} in ${parsed.projectDir ? resolve(io.cwd, parsed.projectDir) : io.cwd}${parsed.projectDir ? '' : ' or any parent folder'}. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }

  if (parsed.stop) {
    const result = stopDevServer(root);
    io.stdout(
      result.stopped
        ? `Stopped the dev server (pid ${result.pid}).\n`
        : result.pid === null
          ? 'No dev server recorded in .pix3/dev.json.\n'
          : `The dev server recorded in .pix3/dev.json (pid ${result.pid}) is already gone; record removed.\n`
    );
    return 0;
  }

  // 1. The dev server.
  let info: DevInfo;
  const found = await findDevServer(root);
  if (found.status === 'live') {
    info = found.info;
    io.stdout(`Dev server: ${info.url} (pid ${info.pid}, reused)\n`);
  } else if (parsed.chromeOnly) {
    io.stderr(
      found.status === 'stale'
        ? `pix3 editor: .pix3/dev.json points at ${found.info.url}, which does not answer; start the dev server (\`npm run dev\` or \`pix3 editor\` without --chrome-only).\n`
        : 'pix3 editor: no .pix3/dev.json — start the dev server first (`npm run dev` or `pix3 editor` without --chrome-only).\n'
    );
    return 1;
  } else {
    if (found.status === 'stale') {
      io.stdout(`Dev server recorded at ${found.info.url} does not answer; starting a new one.\n`);
    }
    try {
      info = await startDevServer(root, { port: parsed.devPort });
    } catch (error) {
      io.stderr(`pix3 editor: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    io.stdout(`Dev server: ${info.url} (pid ${info.pid}, started; log in .pix3/dev.log)\n`);
  }
  io.stdout(`Editor:     ${info.editorUrl}\n`);

  // 2. Chrome.
  if (parsed.noChrome) return 0;
  if (env.SSH_CONNECTION && !parsed.headless && !env.PIX3_CHROME) {
    io.stdout(
      'SSH session: Chrome is not launched here (the browser belongs to the machine with the screen). ' +
        'On that machine: forward the dev server port and run `pix3 editor --chrome-only`. An agent here ' +
        'driving that Chrome (its CDP proxy forwarded back, with its ~/.pix3/cdp-token) is not supported yet.\n'
    );
    return 0;
  }
  const launch = findChrome(env);
  if (!launch) {
    io.stderr(`pix3 editor: ${describeChromeNotFound()}\n`);
    return 1;
  }
  const token = ensureCdpToken(env);
  const recorded = readChromeState(env);
  const preferred = parsed.cdpPort ?? DEFAULT_CDP_PORT;
  let choice;
  try {
    choice = await chooseCdpPort({ preferred, recordedPort: recorded?.port ?? null, token });
  } catch (error) {
    io.stderr(`pix3 editor: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const skipped of choice.skipped) io.stdout(`Port ${skipped.port}: ${skipped.detail}\n`);
  if (choice.state.kind === 'legacy') {
    io.stderr(
      `pix3 editor: port ${choice.port} is ${choice.state.browser} started by an earlier pix3 editor with an open ` +
        'debugging port and no token — any local process can drive it. Close that Chrome (every window of the ' +
        `Pix3 profile ${recorded?.profile ?? chromeProfileDir(env)}) and run pix3 editor again: Chrome now runs ` +
        'behind the token proxy.\n'
    );
    return 1;
  }
  const profile =
    recorded?.profile && choice.state.kind === 'ours' ? recorded.profile : ensureProfileDir(env);
  if (choice.state.kind === 'ours') {
    // Our Chrome with this editor already open: nothing to launch (a second window on the same
    // URL would be a second editor tab competing for the writer). Otherwise: a window in the
    // running Chrome — handed over by a short launch of the same profile, or (headless, no
    // windows) a new tab through the proxy.
    const alreadyOpen = choice.state.pages.some(url => url.startsWith(info.editorUrl));
    if (!alreadyOpen) {
      try {
        if (parsed.headless) {
          await proxyCall(choice.port, token, 'Target.createTarget', { url: info.editorUrl });
        } else {
          launchDetached(launch, handoffArgs({ url: info.editorUrl, profile }));
        }
      } catch (error) {
        io.stderr(
          `pix3 editor: could not open the editor in the running Chrome: ${(error as Error).message}\n`
        );
        return 1;
      }
    }
    io.stdout(
      `Chrome:     ${choice.state.browser} already behind ${cdpWsEndpoint(choice.port)}; ${alreadyOpen ? 'the editor tab is open there' : 'opened the editor in a new window'}.\n`
    );
  } else {
    try {
      await startChromeOwner({
        entry: io.entry ?? process.argv[1],
        env,
        chrome: launch.path,
        port: choice.port,
        profile,
        url: info.editorUrl,
        headless: parsed.headless,
      });
    } catch (error) {
      io.stderr(`pix3 editor: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    io.stdout(
      `Chrome:     launched behind the CDP proxy ${cdpWsEndpoint(choice.port)} (token in ~/.pix3/cdp-token; profile ${profile})\n`
    );
  }
  if (choice.port !== preferred) {
    io.stdout(
      `Port ${preferred} was taken, using ${choice.port}: run \`pix3 agent-setup --repair\` so chrome-devtools-mcp ` +
        'points at it. A Codex or Claude Code session that is already running keeps the old port — restart it or start a new thread.\n'
    );
  } else {
    const stale = checkAgentConfig(root, { port: choice.port, token });
    if (stale.length) {
      io.stdout(
        `${stale.join(' and ')} ${stale.length > 1 ? 'have' : 'has'} a pix3-browser entry that does not reach this Chrome ` +
          '(an older launch, another port or token): run `pix3 agent-setup --repair`, then start a new agent thread.\n'
      );
    }
  }
  return 0;
};
