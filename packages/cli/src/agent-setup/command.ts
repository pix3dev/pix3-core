import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureCdpToken } from '../editor/cdp-token.ts';
import { readChromeState } from '../editor/chrome-state.ts';
import { cdpWsEndpoint, DEFAULT_CDP_PORT } from '../editor/paths.ts';
import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import {
  AGENT_TARGETS,
  CHROME_DEVTOOLS_MCP_VERSION,
  installAgentConfig,
  isP1Entry,
  MCP_SERVER_NAME,
  mcpLaunch,
  TOKEN_PLACEHOLDER,
  type AgentTarget,
} from './config.ts';

/**
 * `pix3 agent-setup [claude|codex] [--repair] [--cdp-port <n>] [--project <dir>]` (plan §D.6).
 * The port comes from `~/.pix3/chrome.json` when `pix3 editor` had to move off 9333, so
 * `--repair` after such a launch is what re-points the agent at the right Chrome; the token is
 * `~/.pix3/cdp-token` (created here when `pix3 editor` has not run yet). `--repair` is also the
 * migration of a P1 entry (`--browserUrl`, open debugging port) to the proxy launch.
 */

/** True when git ignores `file` in `root`; null when that cannot be told (no git, no repo). */
const gitIgnores = (root: string, file: string): boolean | null => {
  const result = spawnSync('git', ['check-ignore', '-q', file], { cwd: root, stdio: 'ignore' });
  if (result.error) return null;
  return result.status === 0 ? true : result.status === 1 ? false : null;
};

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
}

export const parseAgentSetupArgs = (
  argv: readonly string[]
): AgentSetupArgs | { error: string } => {
  const targets: AgentTarget[] = [];
  let repair = false;
  let projectDir: string | undefined;
  let cdpPort: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repair') repair = true;
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
  return { targets: targets.length ? targets : AGENT_TARGETS, repair, projectDir, cdpPort };
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
  const port = parsed.cdpPort ?? readChromeState(env)?.port ?? DEFAULT_CDP_PORT;
  const token = ensureCdpToken(env);
  const outcomes = installAgentConfig(root, {
    targets: parsed.targets,
    port,
    token,
    repair: parsed.repair,
  });
  // Printed with the token masked: this output lands in agent transcripts and terminal logs.
  const printed = [
    mcpLaunch(port, TOKEN_PLACEHOLDER).command,
    ...mcpLaunch(port, TOKEN_PLACEHOLDER).args,
  ].join(' ');
  io.stdout(
    `${MCP_SERVER_NAME}: ${printed}\n` +
      `  (chrome-devtools-mcp ${CHROME_DEVTOOLS_MCP_VERSION}, the CDP proxy ${cdpWsEndpoint(port)}${port !== DEFAULT_CDP_PORT ? ' — the port pix3 editor recorded' : ''})\n`
  );
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
          `  ${label}: ${outcome.file} has a different ${MCP_SERVER_NAME} entry${outcome.current && isP1Entry(outcome.current) ? ' (the P1 launch: --browserUrl at an open debugging port, no token)' : ''} — run \`pix3 agent-setup --repair\` to rewrite it\n`
        );
        break;
    }
  }
  const exposed = outcomes
    .filter(o => o.action === 'written' || o.action === 'repaired' || o.action === 'unchanged')
    .map(o => o.file)
    .filter(file => gitIgnores(root, file) === false);
  if (exposed.length) {
    io.stdout(
      `  ${exposed.join(' and ')} ${exposed.length > 1 ? 'carry' : 'carries'} this machine's CDP token and git does not ignore ${exposed.length > 1 ? 'them' : 'it'}: add ${exposed.join(', ')} to .gitignore.\n`
    );
  }
  const changed = outcomes.some(o => o.action === 'written' || o.action === 'repaired');
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
      `Claude Code picks .mcp.json up from the project (approve it when asked); for every project instead: \`claude mcp add --scope user ${MCP_SERVER_NAME} -- ${printed}\` with the token put in.\n`
    );
  }
  return drift ? 1 : 0;
};
