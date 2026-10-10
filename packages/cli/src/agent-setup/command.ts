import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureCdpToken } from '../editor/cdp-token.ts';
import { readChromeState } from '../editor/chrome-state.ts';
import { proveCdpProxy } from '../editor/cdp-proof.ts';
import {
  CDP_PORT_RANGE,
  cdpWsEndpoint,
  DEFAULT_CDP_PORT,
  localMcpConfigPath,
  remoteMcpConfigPath,
} from '../editor/paths.ts';
import { findCdpForward, readRemoteCdpToken } from '../editor/remote.ts';
import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import {
  AGENT_TARGETS,
  CHROME_DEVTOOLS_MCP_VERSION,
  describeDrift,
  installAgentConfig,
  MCP_SERVER_NAME,
  mcpLaunch,
  writeMcpConfig,
  type AgentTarget,
} from './config.ts';

/**
 * `pix3 agent-setup [claude|codex] [--repair] [--cdp-port <n>] [--project <dir>]` (plan §D.6).
 * The port comes from `~/.pix3/chrome.json` when `pix3 editor` had to move off 9333, so
 * `--repair` after such a launch is what re-points the agent at the right Chrome; the token is
 * `~/.pix3/cdp-token` (created here when `pix3 editor` has not run yet). Both go to
 * chrome-devtools-mcp's `--config` file `~/.pix3/cdp-mcp.json` (0600, rewritten whenever they
 * move); the project's files name that file only. `--repair` is also the migration of a P1 entry
 * (`--browserUrl`, open debugging port) and of an earlier P2 entry (`--wsHeaders`: the token on
 * the command line and in the project file) to the `--config` launch.
 *
 * `--remote` is the agent's side of Remote SSH (plan §E.3): the proxy runs on the human's
 * machine and its port comes back here through `RemoteForward`. The token is
 * `~/.pix3/remote-cdp-token` (copied over SSH by the line `pix3 editor --url` prints there); the
 * port is `--cdp-port`, else the one of 9333–9339 that proves it knows the token (`cdp-proof.ts`
 * — the token is never sent to a port on a shared host that has not proven it). The endpoint and
 * the token go to `~/.pix3/remote-cdp.json` (0600); the project's config names only that file.
 */

export interface AgentSetupIo {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface AgentSetupArgs {
  readonly targets: readonly AgentTarget[];
  readonly repair: boolean;
  readonly projectDir?: string;
  readonly cdpPort?: number;
  readonly remote?: boolean;
}

export const parseAgentSetupArgs = (
  argv: readonly string[]
): AgentSetupArgs | { error: string } => {
  const targets: AgentTarget[] = [];
  let repair = false;
  let projectDir: string | undefined;
  let cdpPort: number | undefined;
  let remote = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repair') repair = true;
    else if (arg === '--remote') remote = true;
    else if (arg === '--project') {
      projectDir = argv[++i];
      if (!projectDir || projectDir.startsWith('-'))
        return { error: '--project needs a directory' };
    } else if (arg === '--cdp-port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) return { error: '--cdp-port needs a port' };
      cdpPort = n;
    } else if (arg === 'claude' || arg === 'codex') targets.push(arg);
    else return { error: `agent-setup takes claude or codex, not "${arg}"` };
  }
  return {
    targets: targets.length ? targets : AGENT_TARGETS,
    repair,
    projectDir,
    cdpPort,
    ...(remote ? { remote } : {}),
  };
};

export const runAgentSetupCli = async (
  argv: readonly string[],
  io: AgentSetupIo
): Promise<number> => {
  const parsed = parseAgentSetupArgs(argv);
  if ('error' in parsed) {
    io.stderr(`pix3 agent-setup: ${parsed.error}\n`);
    return 1;
  }
  const env = io.env ?? process.env;
  const start = parsed.projectDir ? resolve(io.cwd, parsed.projectDir) : io.cwd;
  const root = parsed.projectDir ? start : findProjectRoot(start);
  if (!root || !existsSync(join(root, PROJECT_MANIFEST_FILE))) {
    io.stderr(
      `pix3 agent-setup: no ${PROJECT_MANIFEST_FILE} in ${start}${parsed.projectDir ? '' : ' or any parent folder'}. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }
  let port: number;
  let token: string;
  let configPath: string;
  if (parsed.remote) {
    const remote = await remoteEndpoint(parsed, io, env);
    if (!remote) return 1;
    ({ port, token } = remote);
    configPath = remoteMcpConfigPath(env);
  } else {
    port = parsed.cdpPort ?? readChromeState(env)?.port ?? DEFAULT_CDP_PORT;
    token = ensureCdpToken(env);
    configPath = localMcpConfigPath(env);
  }
  const configAction = writeMcpConfig(configPath, port, token);
  const launch = mcpLaunch(configPath);
  const printed = [launch.command, ...launch.args].join(' ');
  io.stdout(
    `${MCP_SERVER_NAME}: ${printed}\n` +
      `  (chrome-devtools-mcp ${CHROME_DEVTOOLS_MCP_VERSION}; ${configPath} (0600, ${configAction}) holds the endpoint ${cdpWsEndpoint(port)} — ` +
      (parsed.remote
        ? "the SSH forward of your machine's CDP proxy"
        : `the CDP proxy of pix3 editor${port !== DEFAULT_CDP_PORT ? ', the port it recorded' : ''}`) +
      ' — and its token; no token in the project or on a command line)\n'
  );
  const outcomes = installAgentConfig(root, {
    targets: parsed.targets,
    configPath,
    repair: parsed.repair,
  });
  let drift = false;
  for (const outcome of outcomes) {
    const label = outcome.target === 'claude' ? 'Claude Code' : 'Codex';
    switch (outcome.action) {
      case 'written':
        io.stdout(`  ${label}: wrote ${outcome.file}\n`);
        break;
      case 'unchanged':
        io.stdout(`  ${label}: ${outcome.file} is up to date\n`);
        break;
      case 'repaired':
        io.stdout(`  ${label}: repaired ${outcome.file} (previous copy in ${outcome.backup})\n`);
        break;
      case 'drift':
        drift = true;
        io.stdout(
          `  ${label}: ${outcome.file} has a different ${MCP_SERVER_NAME} entry${describeDrift(outcome.current)} — run \`pix3 agent-setup --repair\` to rewrite it\n`
        );
        break;
    }
  }
  const changed =
    configAction === 'updated' ||
    outcomes.some(o => o.action === 'written' || o.action === 'repaired');
  if (changed) {
    io.stdout(
      '\nA Codex or Claude Code session that is already running does not see the change: start a new thread.\n'
    );
  }
  if (parsed.targets.includes('codex')) {
    io.stdout(
      'Codex reads .codex/config.toml of a trusted project; for one global entry instead: copy the table into ~/.codex/config.toml.\n' +
        'Codex’s sandbox must allow the MCP process to reach 127.0.0.1 — approve it once when asked; nothing here changes sandbox settings.\n'
    );
  }
  if (parsed.targets.includes('claude')) {
    io.stdout(
      `Claude Code picks .mcp.json up from the project (approve it when asked); for every project instead: \`claude mcp add --scope user ${MCP_SERVER_NAME} -- ${printed}\`.\n`
    );
  }
  return drift ? 1 : 0;
};

/**
 * Remote SSH: the token copied from the human's machine and the forwarded port that proves it
 * knows that token. Null after printing why not.
 */
const remoteEndpoint = async (
  parsed: AgentSetupArgs,
  io: AgentSetupIo,
  env: NodeJS.ProcessEnv
): Promise<{ port: number; token: string } | null> => {
  const token = readRemoteCdpToken(env);
  if (!token) {
    io.stderr(
      'pix3 agent-setup --remote: no ~/.pix3/remote-cdp-token here. On your machine, run\n' +
        '  npx @pix3/cli editor --chrome-only --url <the editor address VS Code forwarded>\n' +
        'and the ssh line it prints (it copies the token here over SSH; never paste the token by hand).\n'
    );
    return null;
  }
  if (parsed.cdpPort) {
    const proven = await proveCdpProxy(parsed.cdpPort, token);
    if (proven.kind !== 'ours') {
      io.stdout(
        `  Port ${parsed.cdpPort} does not answer with the proof of the token now (${proven.kind === 'closed' ? 'nothing listens' : proven.detail}); written anyway — it must once the SSH session is up.\n`
      );
    }
    return { port: parsed.cdpPort, token };
  }
  const forward = await findCdpForward(token);
  if (forward.live === null) {
    io.stderr(
      `pix3 agent-setup --remote: no port of ${DEFAULT_CDP_PORT}–${DEFAULT_CDP_PORT + CDP_PORT_RANGE} on this host proves it knows the token.\n` +
        forward.taken.map(t => `  ${t.detail}\n`).join('') +
        'Is the SSH session up with the RemoteForward line `pix3 editor` prints here, and `pix3 editor --chrome-only` running on your machine? ' +
        'Or pass --cdp-port <the RemoteForward port>.\n'
    );
    return null;
  }
  return { port: forward.live, token };
};
