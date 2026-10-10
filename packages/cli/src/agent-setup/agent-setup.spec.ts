// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readCdpToken } from '../editor/cdp-token.ts';
import { writeChromeState } from '../editor/chrome-state.ts';
import { parseAgentSetupArgs, runAgentSetupCli } from './command.ts';
import {
  checkAgentConfig,
  CHROME_DEVTOOLS_MCP_VERSION,
  CODEX_CONFIG_FILE,
  codexTable,
  installAgentConfig,
  mcpLaunch,
  renderCodexConfig,
} from './config.ts';

/**
 * `pix3 agent-setup` (plan §D.6, §D.5): the pinned chrome-devtools-mcp entry for Claude Code
 * (`.mcp.json`) and Codex (`.codex/config.toml`) pointed at the CDP proxy with the token,
 * idempotent, drift reported and fixed only with `--repair` (the P1 `--browserUrl` entry among
 * them), other content of both files kept, the token never printed.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-agent-setup-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const TOKEN = 't'.repeat(43);
const linux = { platform: 'linux' as const, token: TOKEN };
/** Never the real ~/.pix3: the command creates the token there. */
const HOME_ENV = { PIX3_HOME: join(scratch, 'home-default') };

let counter = 0;
const project = (): string => {
  const root = join(scratch, `p${++counter}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
  return root;
};

const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');
const actions = (outcomes: ReturnType<typeof installAgentConfig>) =>
  Object.fromEntries(outcomes.map(o => [o.target, o.action]));

describe('the launch', () => {
  it('is npx with the pinned version, the 3p flag, the proxy and the token; cmd /c on Windows', () => {
    expect(mcpLaunch(9333, TOKEN, 'linux')).toEqual({
      command: 'npx',
      args: [
        '-y',
        `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
        '--categoryExperimentalThirdParty=true',
        '--experimentalVision=true',
        '--wsEndpoint=ws://127.0.0.1:9333/pix3',
        `--wsHeaders={"Authorization":"Bearer ${TOKEN}"}`,
      ],
    });
    // chrome-devtools-mcp 1.10.1 parses --wsHeaders as a JSON object.
    const headers = mcpLaunch(9333, TOKEN, 'linux').args.at(-1) as string;
    expect(JSON.parse(headers.slice('--wsHeaders='.length))).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
    const windows = mcpLaunch(9335, TOKEN, 'win32');
    expect(windows.command).toBe('cmd');
    expect(windows.args.slice(0, 3)).toEqual(['/c', 'npx', '-y']);
    expect(CHROME_DEVTOOLS_MCP_VERSION).toBe('1.10.1');
  });
});

describe('installAgentConfig', () => {
  it('writes both files into a fresh project, then reports them unchanged', () => {
    const root = project();
    expect(actions(installAgentConfig(root, linux))).toEqual({
      claude: 'written',
      codex: 'written',
    });
    const claude = JSON.parse(read(root, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(claude.mcpServers['pix3-browser']).toEqual(mcpLaunch(9333, TOKEN, 'linux'));
    expect(read(root, CODEX_CONFIG_FILE)).toBe(codexTable(mcpLaunch(9333, TOKEN, 'linux')));
    expect(read(root, CODEX_CONFIG_FILE)).toContain('tool_timeout_sec = 300');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('startup_timeout_sec = 20');
    const before = [read(root, '.mcp.json'), read(root, CODEX_CONFIG_FILE)];
    expect(actions(installAgentConfig(root, linux))).toEqual({
      claude: 'unchanged',
      codex: 'unchanged',
    });
    expect([read(root, '.mcp.json'), read(root, CODEX_CONFIG_FILE)]).toEqual(before);
    expect(existsSync(join(root, '.mcp.json.bak'))).toBe(false);
  });

  it('keeps other servers and other TOML tables, byte for byte', () => {
    const root = project();
    writeFileSync(
      join(root, '.mcp.json'),
      '{\n  "mcpServers": { "other": { "command": "x", "args": [] } },\n  "note": 1\n}\n'
    );
    mkdirSync(join(root, '.codex'));
    const toml =
      '# my codex\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "o4-mini"\n';
    writeFileSync(join(root, CODEX_CONFIG_FILE), toml);
    installAgentConfig(root, linux);
    const claude = JSON.parse(read(root, '.mcp.json')) as {
      mcpServers: Record<string, unknown>;
      note: number;
    };
    expect(Object.keys(claude.mcpServers).sort()).toEqual(['other', 'pix3-browser']);
    expect(claude.note).toBe(1);
    const codex = read(root, CODEX_CONFIG_FILE);
    expect(codex.startsWith(toml)).toBe(true);
    expect(codex).toContain('[mcp_servers.pix3-browser]');
    expect(codex.split('[mcp_servers.pix3-browser]')).toHaveLength(2);
  });

  it('replaces our table in the middle of a file and nothing else', () => {
    const launch = mcpLaunch(9333, TOKEN, 'linux');
    const existing =
      'model = "o3"\n\n[mcp_servers.pix3-browser]\ncommand = "old"\nargs = []\n\n[profiles.fast]\nmodel = "o4-mini"\n';
    const rendered = renderCodexConfig(existing, launch);
    expect(rendered).toBe(
      `model = "o3"\n\n${codexTable(launch)}\n[profiles.fast]\nmodel = "o4-mini"\n`
    );
  });

  it('reports drift without touching the file; --repair rewrites it with a .bak copy', () => {
    const root = project();
    installAgentConfig(root, linux);
    // Drift: another version in .mcp.json, another port in the TOML.
    const claudeDrift = read(root, '.mcp.json').replace(CHROME_DEVTOOLS_MCP_VERSION, '1.9.0');
    writeFileSync(join(root, '.mcp.json'), claudeDrift);
    const codexDrift = read(root, CODEX_CONFIG_FILE).replace('9333', '9339');
    writeFileSync(join(root, CODEX_CONFIG_FILE), codexDrift);
    const report = installAgentConfig(root, linux);
    expect(actions(report)).toEqual({ claude: 'drift', codex: 'drift' });
    expect(report.find(o => o.target === 'claude')?.current).toContain('1.9.0');
    expect(read(root, '.mcp.json')).toBe(claudeDrift);
    expect(read(root, CODEX_CONFIG_FILE)).toBe(codexDrift);

    const repaired = installAgentConfig(root, { ...linux, repair: true });
    expect(actions(repaired)).toEqual({ claude: 'repaired', codex: 'repaired' });
    expect(read(root, '.mcp.json.bak')).toBe(claudeDrift);
    expect(read(root, `${CODEX_CONFIG_FILE}.bak`)).toBe(codexDrift);
    expect(read(root, '.mcp.json')).toContain(CHROME_DEVTOOLS_MCP_VERSION);
    expect(read(root, CODEX_CONFIG_FILE)).toContain('9333');
    expect(actions(installAgentConfig(root, linux))).toEqual({
      claude: 'unchanged',
      codex: 'unchanged',
    });
  });

  it('a port other than 9333 lands in both files', () => {
    const root = project();
    installAgentConfig(root, { ...linux, port: 9335 });
    expect(read(root, '.mcp.json')).toContain('--wsEndpoint=ws://127.0.0.1:9335/pix3');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('--wsEndpoint=ws://127.0.0.1:9335/pix3');
  });

  it('a P1 entry (--browserUrl, no token) is drift until --repair migrates it', () => {
    const root = project();
    const p1 = mcpLaunch(9333, TOKEN, 'linux')
      .args.slice(0, 4)
      .concat('--browserUrl=http://127.0.0.1:9333');
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'pix3-browser': { command: 'npx', args: p1 } } })
    );
    expect(checkAgentConfig(root, { port: 9333, token: TOKEN, platform: 'linux' })).toEqual([
      '.mcp.json',
    ]);
    const report = installAgentConfig(root, { ...linux, targets: ['claude'] });
    expect(report[0]).toMatchObject({
      action: 'drift',
      current: expect.stringContaining('--browserUrl='),
    });
    installAgentConfig(root, { ...linux, targets: ['claude'], repair: true });
    expect(read(root, '.mcp.json')).not.toContain('--browserUrl');
    expect(checkAgentConfig(root, { port: 9333, token: TOKEN, platform: 'linux' })).toEqual([]);
    // Another token (the file was deleted and made anew) is drift too.
    expect(
      checkAgentConfig(root, { port: 9333, token: 'u'.repeat(43), platform: 'linux' })
    ).toEqual(['.mcp.json']);
  });
});

describe('pix3 agent-setup', () => {
  const io = (cwd: string, env: NodeJS.ProcessEnv = HOME_ENV) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { cwd, env, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
      out: () => out.join(''),
      err: () => err.join(''),
    };
  };

  it('parses targets and flags', () => {
    expect(parseAgentSetupArgs([])).toMatchObject({ targets: ['claude', 'codex'], repair: false });
    expect(parseAgentSetupArgs(['codex', '--repair', '--cdp-port', '9336'])).toMatchObject({
      targets: ['codex'],
      repair: true,
      cdpPort: 9336,
    });
    expect(parseAgentSetupArgs(['gemini'])).toEqual({ error: expect.stringContaining('gemini') });
  });

  it('writes one target, is idempotent, exits 1 on drift and 0 after --repair', async () => {
    const root = project();
    const first = io(root);
    expect(await runAgentSetupCli(['claude'], first.io)).toBe(0);
    expect(first.out()).toContain('wrote .mcp.json');
    expect(first.out()).toContain('new thread');
    expect(existsSync(join(root, CODEX_CONFIG_FILE))).toBe(false);
    const again = io(root);
    expect(await runAgentSetupCli(['claude'], again.io)).toBe(0);
    expect(again.out()).toContain('up to date');
    expect(again.out()).not.toContain('new thread');
    writeFileSync(join(root, '.mcp.json'), read(root, '.mcp.json').replace('9333', '9334'));
    const drift = io(root);
    expect(await runAgentSetupCli(['claude'], drift.io)).toBe(1);
    expect(drift.out()).toContain('--repair');
    const repair = io(root);
    expect(await runAgentSetupCli(['claude', '--repair'], repair.io)).toBe(0);
    expect(repair.out()).toContain('repaired .mcp.json');
    // The token is in the file, never in what the command prints.
    const token = readCdpToken(HOME_ENV) as string;
    expect(read(root, '.mcp.json')).toContain(`Bearer ${token}`);
    for (const run of [first, again, drift, repair]) {
      expect(run.out()).not.toContain(token);
    }
    expect(first.out()).toContain('<token of ~/.pix3/cdp-token>');
  });

  it('warns when git would commit a file that carries the token', async () => {
    const root = project();
    const git = spawnSync('git', ['init', '-q'], { cwd: root });
    if (git.error || git.status !== 0) return; // no git here
    const bare = io(root);
    expect(await runAgentSetupCli(['claude'], bare.io)).toBe(0);
    expect(bare.out()).toContain("carries this machine's CDP token");
    writeFileSync(join(root, '.gitignore'), '.mcp.json\n');
    const ignored = io(root);
    expect(await runAgentSetupCli(['claude'], ignored.io)).toBe(0);
    expect(ignored.out()).not.toContain('CDP token and git');
  });

  it('names a P1 entry as such', async () => {
    const root = project();
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'pix3-browser': { command: 'npx', args: ['--browserUrl=http://127.0.0.1:9333'] },
        },
      })
    );
    const run = io(root);
    expect(await runAgentSetupCli(['claude'], run.io)).toBe(1);
    expect(run.out()).toContain('the P1 launch');
  });

  it('takes the port pix3 editor recorded, and refuses outside a project', async () => {
    const env = { PIX3_HOME: join(scratch, 'home') };
    writeChromeState({ port: 9337, profile: '/p', startedAt: 'now' }, env);
    const root = project();
    const run = io(root, env);
    expect(await runAgentSetupCli(['codex'], run.io)).toBe(0);
    expect(run.out()).toContain('ws://127.0.0.1:9337/pix3');
    expect(run.out()).toContain('the port pix3 editor recorded');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('--wsEndpoint=ws://127.0.0.1:9337/pix3');
    const outside = io(scratch, env);
    expect(await runAgentSetupCli([], outside.io)).toBe(2);
    expect(outside.err()).toContain('pix3project.yaml');
  });
});
