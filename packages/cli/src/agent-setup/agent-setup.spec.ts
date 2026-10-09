// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { writeChromeState } from '../editor/chrome-state.ts';
import { parseAgentSetupArgs, runAgentSetupCli } from './command.ts';
import {
  CHROME_DEVTOOLS_MCP_VERSION,
  CODEX_CONFIG_FILE,
  codexTable,
  installAgentConfig,
  mcpLaunch,
  renderCodexConfig,
} from './config.ts';

/**
 * `pix3 agent-setup` (plan §D.6): the pinned chrome-devtools-mcp entry for Claude Code
 * (`.mcp.json`) and Codex (`.codex/config.toml`), idempotent, drift reported and fixed only
 * with `--repair`, other content of both files kept.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-agent-setup-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
  it('is npx with the pinned version, the 3p flag and the browser URL; cmd /c on Windows', () => {
    expect(mcpLaunch(9333, 'linux')).toEqual({
      command: 'npx',
      args: [
        '-y',
        `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
        '--categoryExperimentalThirdParty=true',
        '--experimentalVision=true',
        '--browserUrl=http://127.0.0.1:9333',
      ],
    });
    const windows = mcpLaunch(9335, 'win32');
    expect(windows.command).toBe('cmd');
    expect(windows.args.slice(0, 3)).toEqual(['/c', 'npx', '-y']);
    expect(CHROME_DEVTOOLS_MCP_VERSION).toBe('1.10.1');
  });
});

describe('installAgentConfig', () => {
  it('writes both files into a fresh project, then reports them unchanged', () => {
    const root = project();
    expect(actions(installAgentConfig(root))).toEqual({ claude: 'written', codex: 'written' });
    const claude = JSON.parse(read(root, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(claude.mcpServers['pix3-browser']).toEqual(mcpLaunch(9333, 'linux'));
    expect(read(root, CODEX_CONFIG_FILE)).toBe(codexTable(mcpLaunch(9333, 'linux')));
    expect(read(root, CODEX_CONFIG_FILE)).toContain('tool_timeout_sec = 300');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('startup_timeout_sec = 20');
    const before = [read(root, '.mcp.json'), read(root, CODEX_CONFIG_FILE)];
    expect(actions(installAgentConfig(root))).toEqual({ claude: 'unchanged', codex: 'unchanged' });
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
    installAgentConfig(root, { platform: 'linux' });
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
    const launch = mcpLaunch(9333, 'linux');
    const existing =
      'model = "o3"\n\n[mcp_servers.pix3-browser]\ncommand = "old"\nargs = []\n\n[profiles.fast]\nmodel = "o4-mini"\n';
    const rendered = renderCodexConfig(existing, launch);
    expect(rendered).toBe(
      `model = "o3"\n\n${codexTable(launch)}\n[profiles.fast]\nmodel = "o4-mini"\n`
    );
  });

  it('reports drift without touching the file; --repair rewrites it with a .bak copy', () => {
    const root = project();
    installAgentConfig(root, { platform: 'linux' });
    // Drift: another version in .mcp.json, another port in the TOML.
    const claudeDrift = read(root, '.mcp.json').replace(CHROME_DEVTOOLS_MCP_VERSION, '1.9.0');
    writeFileSync(join(root, '.mcp.json'), claudeDrift);
    const codexDrift = read(root, CODEX_CONFIG_FILE).replace('9333', '9339');
    writeFileSync(join(root, CODEX_CONFIG_FILE), codexDrift);
    const report = installAgentConfig(root, { platform: 'linux' });
    expect(actions(report)).toEqual({ claude: 'drift', codex: 'drift' });
    expect(report.find(o => o.target === 'claude')?.current).toContain('1.9.0');
    expect(read(root, '.mcp.json')).toBe(claudeDrift);
    expect(read(root, CODEX_CONFIG_FILE)).toBe(codexDrift);

    const repaired = installAgentConfig(root, { platform: 'linux', repair: true });
    expect(actions(repaired)).toEqual({ claude: 'repaired', codex: 'repaired' });
    expect(read(root, '.mcp.json.bak')).toBe(claudeDrift);
    expect(read(root, `${CODEX_CONFIG_FILE}.bak`)).toBe(codexDrift);
    expect(read(root, '.mcp.json')).toContain(CHROME_DEVTOOLS_MCP_VERSION);
    expect(read(root, CODEX_CONFIG_FILE)).toContain('9333');
    expect(actions(installAgentConfig(root, { platform: 'linux' }))).toEqual({
      claude: 'unchanged',
      codex: 'unchanged',
    });
  });

  it('a port other than 9333 lands in both files', () => {
    const root = project();
    installAgentConfig(root, { port: 9335, platform: 'linux' });
    expect(read(root, '.mcp.json')).toContain('--browserUrl=http://127.0.0.1:9335');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('--browserUrl=http://127.0.0.1:9335');
  });
});

describe('pix3 agent-setup', () => {
  const io = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
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
  });

  it('takes the port pix3 editor recorded, and refuses outside a project', async () => {
    const env = { PIX3_HOME: join(scratch, 'home') };
    writeChromeState({ port: 9337, profile: '/p', startedAt: 'now' }, env);
    const root = project();
    const run = io(root, env);
    expect(await runAgentSetupCli(['codex'], run.io)).toBe(0);
    expect(run.out()).toContain('127.0.0.1:9337');
    expect(run.out()).toContain('the port pix3 editor recorded');
    expect(read(root, CODEX_CONFIG_FILE)).toContain('--browserUrl=http://127.0.0.1:9337');
    const outside = io(scratch, env);
    expect(await runAgentSetupCli([], outside.io)).toBe(2);
    expect(outside.err()).toContain('pix3project.yaml');
  });
});
