import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { cdpWsEndpoint } from '../editor/paths.ts';

/**
 * The one-time agent configuration (plan §D.6): chrome-devtools-mcp as the `pix3-browser` MCP
 * server of Codex and Claude Code, pointed at the CDP proxy `pix3 editor` runs (plan §D.5). The
 * endpoint `ws://127.0.0.1:<port>/pix3` and the bearer token of `~/.pix3/cdp-token` live in
 * chrome-devtools-mcp's `--config` file under `~/.pix3/` (0600: `cdp-mcp.json` here,
 * `remote-cdp.json` on a Remote SSH host); the project's files name that file only, so the token
 * is in no project file and on no command line (`/proc/<pid>/cmdline` is world-readable).
 * Project-level files, so a checkout carries its own setup:
 *
 * - Claude Code: `.mcp.json` → `mcpServers["pix3-browser"]` (other servers kept);
 * - Codex: `.codex/config.toml` → `[mcp_servers.pix3-browser]` (the table is replaced whole,
 *   everything else in the file stays byte for byte).
 *
 * The version is pinned (plan §D.1 «Риск экспериментального флага»): the 3p-tool category is
 * experimental and may move in a minor release; `CHROME_DEVTOOLS_MCP_VERSION` moves only after
 * the S4 run is repeated. Idempotent: an entry that already says this is `unchanged`; one that
 * differs (another version, another config file, the P1 `--browserUrl` launch, the earlier
 * `--wsHeaders` launch with the token on the command line) is `drift` and left alone until
 * `--repair`, which rewrites it after saving a `.bak` copy.
 */

export const CHROME_DEVTOOLS_MCP_VERSION = '1.10.1';
export const MCP_SERVER_NAME = 'pix3-browser';
export const CLAUDE_CONFIG_FILE = '.mcp.json';
export const CODEX_CONFIG_FILE = join('.codex', 'config.toml');
/** Codex's per-call timeout: `pix3_game_run` and a slow sync outlive the 60 s default. */
export const CODEX_TOOL_TIMEOUT_SEC = 300;
export const CODEX_STARTUP_TIMEOUT_SEC = 20;

export type AgentTarget = 'claude' | 'codex';
export const AGENT_TARGETS: readonly AgentTarget[] = ['claude', 'codex'];

/** chrome-devtools-mcp's `wsHeaders` value: JSON, as its yargs option parses it. */
export const wsHeaders = (token: string): string =>
  JSON.stringify({ Authorization: `Bearer ${token}` });

export interface McpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How chrome-devtools-mcp is started: `npx -y chrome-devtools-mcp@<pinned> …
 * --config=<~/.pix3/cdp-mcp.json>`. 1.10.1's `config` option (`build/src/config/mcp-options.js`)
 * reads a JSON object parsed with the same options and coercions as the flags; ours holds
 * `wsEndpoint` (puppeteer connects to that WebSocket only — no `/json/*` request) and
 * `wsHeaders` (sent on the upgrade; `build/src/config/browser-options.js`).
 */
export const mcpLaunch = (
  configPath: string,
  platform: NodeJS.Platform = process.platform
): McpLaunch => {
  const npx = [
    'npx',
    '-y',
    `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
    '--categoryExperimentalThirdParty=true',
    // `click_at {x, y}`: input at the coordinates `pix3_scene` returns as `screen` (the 1.x
    // `game_input` has no bridge counterpart; the page's own input is the honest one).
    '--experimentalVision=true',
    `--config=${configPath}`,
  ];
  // Windows: `npx` is a .cmd shim, which a spawned MCP process cannot execute directly.
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', ...npx] }
    : { command: npx[0], args: npx.slice(1) };
};

const readText = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

const mcpConfigText = (port: number, token: string): string =>
  `${JSON.stringify({ wsEndpoint: cdpWsEndpoint(port), wsHeaders: wsHeaders(token) }, null, 2)}\n`;

export type McpConfigFileAction = 'written' | 'updated' | 'unchanged';

/**
 * chrome-devtools-mcp's `--config` file (`~/.pix3/cdp-mcp.json`, or `remote-cdp.json` for Remote
 * SSH): ours alone, so rewritten whole when the port or the token moved; mode 0600 (a wider file
 * is narrowed).
 */
export const writeMcpConfig = (path: string, port: number, token: string): McpConfigFileAction => {
  const text = mcpConfigText(port, token);
  const existing = readText(path);
  if (existing !== text) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return existing === null ? 'written' : existing === text ? 'unchanged' : 'updated';
};

/** True when the `--config` file at `path` reaches the proxy on `port` with `token`. */
export const mcpConfigReaches = (path: string, port: number, token: string): boolean =>
  readText(path) === mcpConfigText(port, token);

// --- Claude Code: .mcp.json --------------------------------------------------------------------

type Json = Record<string, unknown>;

const parseJsonObject = (text: string | null): Json => {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
};

export const claudeEntry = (launch: McpLaunch): Json => ({
  command: launch.command,
  args: [...launch.args],
});

/** `.mcp.json` with our server set; everything else as it was. */
export const renderClaudeConfig = (existing: string | null, launch: McpLaunch): string => {
  const base = parseJsonObject(existing);
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
      ? (base.mcpServers as Json)
      : {};
  return `${JSON.stringify(
    { ...base, mcpServers: { ...servers, [MCP_SERVER_NAME]: claudeEntry(launch) } },
    null,
    2
  )}\n`;
};

/** The server entry `.mcp.json` has now, or null. */
export const readClaudeEntry = (existing: string | null): Json | null => {
  const servers = parseJsonObject(existing).mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  const entry = (servers as Json)[MCP_SERVER_NAME];
  return entry && typeof entry === 'object' ? (entry as Json) : null;
};

// --- Codex: .codex/config.toml ------------------------------------------------------------------

const tomlString = (value: string): string => JSON.stringify(value);

export const codexTable = (launch: McpLaunch): string =>
  [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    '',
  ].join('\n');

const TABLE_HEADER = new RegExp(
  `^\\[mcp_servers\\.${MCP_SERVER_NAME.replace(/-/g, '\\-')}\\]\\s*$`
);
const ANY_HEADER = /^\s*\[/;

/** Lines of the file that are our table (header to the next header), or null. */
const findCodexTable = (lines: readonly string[]): { start: number; end: number } | null => {
  const start = lines.findIndex(line => TABLE_HEADER.test(line.trim()));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !ANY_HEADER.test(lines[end])) end++;
  return { start, end };
};

/** The text of our table as the file has it (whitespace-normalised), or null. */
export const readCodexTable = (existing: string | null): string | null => {
  if (!existing) return null;
  const lines = existing.split('\n');
  const range = findCodexTable(lines);
  if (!range) return null;
  return normaliseToml(lines.slice(range.start, range.end).join('\n'));
};

export const normaliseToml = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .join('\n');

/** `.codex/config.toml` with our table replaced (or appended); every other byte stays. */
export const renderCodexConfig = (existing: string | null, launch: McpLaunch): string => {
  const table = codexTable(launch);
  if (!existing) return table;
  const lines = existing.split('\n');
  const range = findCodexTable(lines);
  if (!range) {
    const separator = existing.endsWith('\n') ? (existing.endsWith('\n\n') ? '' : '\n') : '\n\n';
    return `${existing}${separator}${table}`;
  }
  // Keep a blank line between our table and the next header, as the file had it.
  const tail = lines.slice(range.end);
  const before = lines.slice(0, range.start).join('\n');
  const after = tail.join('\n');
  return `${before ? `${before}\n` : ''}${table}${after ? `${after.startsWith('\n') ? '' : '\n'}${after}` : ''}`;
};

// --- install ------------------------------------------------------------------------------------

export type ConfigAction = 'written' | 'unchanged' | 'drift' | 'repaired';

export interface ConfigOutcome {
  readonly target: AgentTarget;
  readonly file: string;
  readonly action: ConfigAction;
  /** The `.bak` copy made before a repair. */
  readonly backup?: string;
  /** What the file has instead, for a `drift` report. */
  readonly current?: string;
}

export interface InstallAgentConfigOptions {
  readonly targets?: readonly AgentTarget[];
  /** chrome-devtools-mcp's `--config` file the entries name (`localMcpConfigPath`, …). */
  readonly configPath: string;
  readonly repair?: boolean;
  readonly platform?: NodeJS.Platform;
}

const writeAtomic = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

const fileOf = (target: AgentTarget): string =>
  target === 'claude' ? CLAUDE_CONFIG_FILE : CODEX_CONFIG_FILE;

/** Write (or check, or repair) the config of each target in `root`. */
const currentAndExpected = (target: AgentTarget, existing: string | null, launch: McpLaunch) => {
  const expected =
    target === 'claude' ? JSON.stringify(claudeEntry(launch)) : normaliseToml(codexTable(launch));
  const entry = target === 'claude' ? readClaudeEntry(existing) : null;
  const current =
    target === 'claude' ? (entry ? JSON.stringify(entry) : null) : readCodexTable(existing);
  return { current, expected };
};

/** True when an entry is the P1 launch: `--browserUrl` at an open debugging port, no token. */
export const isP1Entry = (current: string): boolean => current.includes('--browserUrl=');

/** True when an entry carries the token on its command line (`--wsHeaders`, before `--config`). */
export const isTokenOnCommandLine = (current: string): boolean => current.includes('--wsHeaders');

/** What a drifted entry is, when it is one of our own earlier launches; '' otherwise. */
export const describeDrift = (current: string | undefined): string =>
  !current
    ? ''
    : isP1Entry(current)
      ? ' (the P1 launch: --browserUrl at an open debugging port, no token)'
      : isTokenOnCommandLine(current)
        ? ' (an earlier launch with the CDP token on its command line and in this file)'
        : '';

/**
 * What does not reach the proxy on `port` with `token` — `pix3 editor` names it: a project
 * file (of `targets`) whose `pix3-browser` entry exists and differs from the launch, or the
 * `--config` file such an entry names when it holds another port or token. A missing entry is
 * not stale: the project may not use that agent.
 */
export const checkAgentConfig = (
  root: string,
  options: {
    port: number;
    token: string;
    configPath: string;
    targets?: readonly AgentTarget[];
    platform?: NodeJS.Platform;
  }
): string[] => {
  const launch = mcpLaunch(options.configPath, options.platform);
  const stale: string[] = [];
  let names = false;
  for (const target of options.targets ?? AGENT_TARGETS) {
    const { current, expected } = currentAndExpected(
      target,
      readText(join(root, fileOf(target))),
      launch
    );
    if (current !== null && current !== expected) stale.push(fileOf(target));
    if (current === expected) names = true;
  }
  if (names && !mcpConfigReaches(options.configPath, options.port, options.token)) {
    stale.push(options.configPath);
  }
  return stale;
};

export const installAgentConfig = (
  root: string,
  options: InstallAgentConfigOptions
): ConfigOutcome[] => {
  const launch = mcpLaunch(options.configPath, options.platform);
  const outcomes: ConfigOutcome[] = [];
  for (const target of options.targets ?? AGENT_TARGETS) {
    const file = fileOf(target);
    const path = join(root, file);
    const existing = readText(path);
    const { current, expected } = currentAndExpected(target, existing, launch);
    const render = target === 'claude' ? renderClaudeConfig : renderCodexConfig;
    if (current === null) {
      writeAtomic(path, render(existing, launch));
      outcomes.push({ target, file, action: 'written' });
    } else if (current === expected) {
      outcomes.push({ target, file, action: 'unchanged' });
    } else if (options.repair) {
      const backup = `${path}.bak`;
      copyFileSync(path, backup);
      writeAtomic(path, render(existing, launch));
      outcomes.push({ target, file, action: 'repaired', backup: `${file}.bak` });
    } else {
      outcomes.push({ target, file, action: 'drift', current });
    }
  }
  return outcomes;
};
