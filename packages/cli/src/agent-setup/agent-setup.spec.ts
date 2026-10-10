// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CdpProxy } from '../editor/cdp-proxy.ts';
import { ensureCdpToken, readCdpToken } from '../editor/cdp-token.ts';
import { FakeChrome } from '../editor/fake-chrome.ts';
import { localMcpConfigPath, remoteCdpTokenPath, remoteMcpConfigPath } from '../editor/paths.ts';
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
  writeMcpConfig,
} from './config.ts';

/**
 * `pix3 agent-setup` (plan §D.6, §D.5): the pinned chrome-devtools-mcp entry for Claude Code
 * (`.mcp.json`) and Codex (`.codex/config.toml`) naming the 0600 `--config` file under
 * `~/.pix3/` that holds the proxy's endpoint and token, idempotent, drift reported and fixed
 * only with `--repair` (the P1 `--browserUrl` entry and the P2 `--wsHeaders` entry among them),
 * other content of both files kept, the token never printed nor in a project file.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-agent-setup-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const TOKEN = 't'.repeat(43);
const CONFIG = join(scratch, 'home-default', 'cdp-mcp.json');
const linux = { platform: 'linux' as const, configPath: CONFIG };
/** The P2 entry (before `--config`): the token on the command line and in the project file. */
const p2Args = (port: number, token: string) => [
  ...mcpLaunch(CONFIG, 'linux').args.slice(0, -1),
  `--wsEndpoint=ws://127.0.0.1:${port}/pix3`,
  `--wsHeaders={"Authorization":"Bearer ${token}"}`,
];
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
  it('is npx with the pinned version, the 3p flag and the --config file; cmd /c on Windows', () => {
    expect(mcpLaunch(CONFIG, 'linux')).toEqual({
      command: 'npx',
      args: [
        '-y',
        `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
        '--categoryExperimentalThirdParty=true',
        '--experimentalVision=true',
        `--config=${CONFIG}`,
      ],
    });
    const windows = mcpLaunch(CONFIG, 'win32');
    expect(windows.command).toBe('cmd');
    expect(windows.args.slice(0, 3)).toEqual(['/c', 'npx', '-y']);
    expect(CHROME_DEVTOOLS_MCP_VERSION).toBe('1.10.1');
  });

  it('the --config file: endpoint + token header as 1.10.1 parses them, 0600, rewritten when they move', () => {
    const path = join(scratch, 'cfg', 'cdp-mcp.json');
    expect(writeMcpConfig(path, 9333, TOKEN)).toBe('written');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    expect(parsed).toEqual({
      wsEndpoint: 'ws://127.0.0.1:9333/pix3',
      wsHeaders: JSON.stringify({ Authorization: `Bearer ${TOKEN}` }),
    });
    // chrome-devtools-mcp 1.10.1 parses wsHeaders as a JSON object.
    expect(JSON.parse(parsed.wsHeaders)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(writeMcpConfig(path, 9333, TOKEN)).toBe('unchanged');
    expect(writeMcpConfig(path, 9335, TOKEN)).toBe('updated');
    expect(readFileSync(path, 'utf8')).toContain('ws://127.0.0.1:9335/pix3');
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
      expect(writeMcpConfig(path, 9335, TOKEN)).toBe('unchanged');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
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
    expect(claude.mcpServers['pix3-browser']).toEqual(mcpLaunch(CONFIG, 'linux'));
    expect(read(root, CODEX_CONFIG_FILE)).toBe(codexTable(mcpLaunch(CONFIG, 'linux')));
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
    const launch = mcpLaunch(CONFIG, 'linux');
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
    // Drift: another version in .mcp.json, another config file in the TOML.
    const claudeDrift = read(root, '.mcp.json').replace(CHROME_DEVTOOLS_MCP_VERSION, '1.9.0');
    writeFileSync(join(root, '.mcp.json'), claudeDrift);
    const codexDrift = read(root, CODEX_CONFIG_FILE).replace('cdp-mcp.json', 'other.json');
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
    expect(read(root, CODEX_CONFIG_FILE)).toContain('cdp-mcp.json');
    expect(actions(installAgentConfig(root, linux))).toEqual({
      claude: 'unchanged',
      codex: 'unchanged',
    });
  });

  it('a P1 entry (--browserUrl, no token) is drift until --repair migrates it', () => {
    const root = project();
    const p1 = mcpLaunch(CONFIG, 'linux')
      .args.slice(0, 4)
      .concat('--browserUrl=http://127.0.0.1:9333');
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'pix3-browser': { command: 'npx', args: p1 } } })
    );
    const check = { port: 9333, token: TOKEN, configPath: CONFIG, platform: 'linux' as const };
    expect(checkAgentConfig(root, check)).toEqual(['.mcp.json']);
    const report = installAgentConfig(root, { ...linux, targets: ['claude'] });
    expect(report[0]).toMatchObject({
      action: 'drift',
      current: expect.stringContaining('--browserUrl='),
    });
    installAgentConfig(root, { ...linux, targets: ['claude'], repair: true });
    expect(read(root, '.mcp.json')).not.toContain('--browserUrl');
    // The entry is right; the --config file it names is missing, then holds another port or
    // another token (the token file was deleted and made anew): stale until it is rewritten.
    rmSync(CONFIG, { force: true });
    expect(checkAgentConfig(root, check)).toEqual([CONFIG]);
    writeMcpConfig(CONFIG, 9334, TOKEN);
    expect(checkAgentConfig(root, check)).toEqual([CONFIG]);
    writeMcpConfig(CONFIG, 9333, 'u'.repeat(43));
    expect(checkAgentConfig(root, check)).toEqual([CONFIG]);
    writeMcpConfig(CONFIG, 9333, TOKEN);
    expect(checkAgentConfig(root, check)).toEqual([]);
  });

  it('a P2 entry (--wsHeaders: the token on the command line) is drift until --repair migrates it', () => {
    const root = project();
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'pix3-browser': { command: 'npx', args: p2Args(9333, TOKEN) } },
      })
    );
    mkdirSync(join(root, '.codex'));
    writeFileSync(
      join(root, CODEX_CONFIG_FILE),
      codexTable({ command: 'npx', args: p2Args(9333, TOKEN) })
    );
    writeMcpConfig(CONFIG, 9333, TOKEN);
    const check = { port: 9333, token: TOKEN, configPath: CONFIG, platform: 'linux' as const };
    expect(checkAgentConfig(root, check)).toEqual(['.mcp.json', CODEX_CONFIG_FILE]);
    expect(actions(installAgentConfig(root, linux))).toEqual({ claude: 'drift', codex: 'drift' });
    expect(actions(installAgentConfig(root, { ...linux, repair: true }))).toEqual({
      claude: 'repaired',
      codex: 'repaired',
    });
    for (const file of ['.mcp.json', CODEX_CONFIG_FILE]) {
      expect(read(root, file)).not.toContain(TOKEN);
      expect(read(root, file)).not.toContain('--wsHeaders');
      expect(read(root, file)).toContain(`--config=${CONFIG}`);
      // The .bak keeps what was there — the token too; it is the user's to delete.
      expect(read(root, `${file}.bak`)).toContain(TOKEN);
    }
    expect(checkAgentConfig(root, check)).toEqual([]);
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
    writeFileSync(
      join(root, '.mcp.json'),
      read(root, '.mcp.json').replace('cdp-mcp.json', 'other.json')
    );
    const drift = io(root);
    expect(await runAgentSetupCli(['claude'], drift.io)).toBe(1);
    expect(drift.out()).toContain('--repair');
    const repair = io(root);
    expect(await runAgentSetupCli(['claude', '--repair'], repair.io)).toBe(0);
    expect(repair.out()).toContain('repaired .mcp.json');
    // The token is in the 0600 --config file, never in the project nor in what is printed.
    const token = readCdpToken(HOME_ENV) as string;
    const config = localMcpConfigPath(HOME_ENV);
    expect(read(root, '.mcp.json')).toContain(`--config=${config}`);
    expect(read(root, '.mcp.json')).not.toContain(token);
    expect(readFileSync(config, 'utf8')).toContain(`Bearer ${token}`);
    if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o600);
    for (const run of [first, again, drift, repair]) {
      expect(run.out()).not.toContain(token);
    }
  });

  it('names a P2 entry (the token on the command line) as such; --repair migrates it', async () => {
    const root = project();
    const token = ensureCdpToken(HOME_ENV);
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'pix3-browser': { command: 'npx', args: p2Args(9333, token) } },
      })
    );
    const run = io(root);
    expect(await runAgentSetupCli(['claude'], run.io)).toBe(1);
    expect(run.out()).toContain('the CDP token on its command line');
    const repair = io(root);
    expect(await runAgentSetupCli(['claude', '--repair'], repair.io)).toBe(0);
    expect(read(root, '.mcp.json')).not.toContain(token);
    expect(repair.out()).not.toContain(token);
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
    expect(run.out()).toContain('the port it recorded');
    expect(read(root, CODEX_CONFIG_FILE)).toContain(`--config=${localMcpConfigPath(env)}`);
    expect(readFileSync(localMcpConfigPath(env), 'utf8')).toContain('ws://127.0.0.1:9337/pix3');
    // pix3 editor moved again: the --config file follows, the project files stay as they are.
    writeChromeState({ port: 9338, profile: '/p', startedAt: 'now' }, env);
    const moved = io(root, env);
    expect(await runAgentSetupCli(['codex'], moved.io)).toBe(0);
    expect(moved.out()).toContain('updated');
    expect(moved.out()).toContain('new thread');
    expect(moved.out()).toContain('is up to date');
    expect(readFileSync(localMcpConfigPath(env), 'utf8')).toContain('ws://127.0.0.1:9338/pix3');
    const outside = io(scratch, env);
    expect(await runAgentSetupCli([], outside.io)).toBe(2);
    expect(outside.err()).toContain('pix3project.yaml');
  });

  it('--remote: the token copied over SSH, the port that proves it, the endpoint in a 0600 --config file', async () => {
    const env = { PIX3_HOME: join(scratch, 'home-remote') };
    const root = project();
    const none = io(root, env);
    expect(await runAgentSetupCli(['claude', '--remote'], none.io)).toBe(1);
    expect(none.err()).toContain('no ~/.pix3/remote-cdp-token');

    // The human's proxy, as its SSH forward shows it here.
    const proxy = new CdpProxy({ pipe: new FakeChrome().pipe(), token: TOKEN });
    const port = await proxy.listen(0);
    try {
      mkdirSync(env.PIX3_HOME, { recursive: true });
      writeFileSync(remoteCdpTokenPath(env), `${TOKEN}\n`, { mode: 0o600 });
      const run = io(root, env);
      expect(
        await runAgentSetupCli(['claude', 'codex', '--remote', '--cdp-port', String(port)], run.io),
        run.err()
      ).toBe(0);
      expect(run.out()).not.toContain('does not answer');
      const config = remoteMcpConfigPath(env);
      expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
        wsEndpoint: `ws://127.0.0.1:${port}/pix3`,
        wsHeaders: JSON.stringify({ Authorization: `Bearer ${TOKEN}` }),
      });
      if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o600);
      // The project's files and the output name the config file, never the token.
      for (const text of [read(root, '.mcp.json'), read(root, CODEX_CONFIG_FILE), run.out()]) {
        expect(text).toContain(`--config=${config}`);
        expect(text).not.toContain(TOKEN);
      }
      // A local entry is drift for a remote setup (and back): --repair switches.
      const local = io(root, HOME_ENV);
      expect(await runAgentSetupCli(['claude'], local.io)).toBe(1);
      const again = io(root, env);
      expect(
        await runAgentSetupCli(['claude', '--remote', '--cdp-port', String(port)], again.io)
      ).toBe(0);
      expect(again.out()).toContain('up to date');

      // A port that does not prove the token: written, with a warning (the session may be down).
      const wrong = io(root, env);
      writeFileSync(remoteCdpTokenPath(env), `${'u'.repeat(43)}\n`);
      expect(
        await runAgentSetupCli(
          ['claude', '--remote', '--cdp-port', String(port), '--repair'],
          wrong.io
        )
      ).toBe(0);
      expect(wrong.out()).toContain('does not answer with the proof of the token');
    } finally {
      await proxy.close();
    }
  });
});
