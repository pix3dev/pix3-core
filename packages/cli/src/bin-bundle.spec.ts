// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHROME_DEVTOOLS_MCP_VERSION } from './agent-setup/config.ts';
import { COMMAND_USAGE, USAGE } from './usage.ts';
import {
  expandRuntimeTypes,
  packRuntimeTypes,
  RUNTIME_TYPES_FORMAT,
} from './types/runtime-types.ts';

/**
 * The published bin is one esbuild bundle (`scripts/build-bin.mjs`). Built here into the layout
 * the tarball has — `<pkg>/package.json` + `<pkg>/dist/index.js` — outside the repo, so nothing
 * can resolve from the monorepo's `node_modules`.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url));
interface PackageJson {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
}
const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

let pkg: string;
let bin: string;

beforeAll(() => {
  pkg = mkdtempSync(join(tmpdir(), 'pix3-cli-bin-'));
  mkdirSync(join(pkg, 'dist'));
  copyFileSync(join(packageDir, 'package.json'), join(pkg, 'package.json'));
  bin = join(pkg, 'dist', 'index.js');
  const build = spawnSync(
    process.execPath,
    [
      join(packageDir, 'scripts', 'build-bin.mjs'),
      '--outfile',
      bin,
      '--metafile',
      join(pkg, 'meta.json'),
    ],
    { encoding: 'utf8' }
  );
  expect(build.status, build.stderr).toBe(0);
}, 60_000);

afterAll(() => rmSync(pkg, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], {
    cwd: pkg,
    encoding: 'utf8',
    // PIX3_HOME: `agent-setup` creates the CDP token, never in the real ~/.pix3.
    env: { ...process.env, PIX3_CLI_DEV: '0', PIX3_HOME: join(pkg, 'pix3-home') },
  });

describe('single-file bin', () => {
  it('prints the version of its package.json, which is the lockstep root version', () => {
    const version = readJson(join(packageDir, 'package.json')).version;
    expect(version).toBe(readJson(join(packageDir, '..', '..', 'package.json')).version);
    const result = run('--version');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it('every command the entry dispatches has its own help, printed by --help, -h and pix3 help', () => {
    // The dispatcher's cases (but the hidden `__chrome-owner`) are exactly the help table's keys.
    const entry = readFileSync(join(packageDir, 'src', 'index.ts'), 'utf8');
    const dispatched = [
      ...entry.slice(entry.indexOf('const dispatch')).matchAll(/^\s+case '([a-z][\w-]*)':/gm),
    ].map(match => match[1]);
    expect(dispatched.sort()).toEqual(Object.keys(COMMAND_USAGE).sort());
    for (const [command, usage] of Object.entries(COMMAND_USAGE)) {
      expect(usage, command).toMatch(new RegExp(`^Usage: pix3 ${command}\\b`));
      expect(USAGE, command).toContain(`pix3 ${command}`);
      for (const argv of [
        [command, '--help'],
        [command, '-h'],
        ['help', command],
        ['--help', command],
      ]) {
        const result = run(...argv);
        expect(result.status, `${argv.join(' ')}: ${result.stderr}`).toBe(0);
        expect(result.stdout.startsWith(usage), argv.join(' ')).toBe(true);
      }
    }
    // validate's help lists its codes; check's, the ones it adds.
    expect(run('validate', '--help').stdout).toContain('E_LOCALE_SCRIPT_KEY');
    expect(run('help', 'check').stdout).toContain('E_RUNTIME_VERSION');
    // The overview, and a topic that is not a command.
    expect(run('help')).toMatchObject({ status: 0, stdout: USAGE });
    expect(run('--help')).toMatchObject({ status: 0, stdout: USAGE });
    const unknown = run('help', 'serve');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown command "serve"');
  }, 60_000); // ~50 runs of the bin

  it('agent-setup writes the pinned chrome-devtools-mcp launch', () => {
    const project = join(pkg, 'proj');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'pix3project.yaml'), 'version: 1.0.0\n');
    const result = run('agent-setup', 'claude', '--project', project);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`);
    const config = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(config.mcpServers['pix3-browser'].args).toContain(
      '--categoryExperimentalThirdParty=true'
    );
    // The proxy launch: the `--config` file of the bin's home holds the endpoint and the token.
    const token = readFileSync(join(pkg, 'pix3-home', 'cdp-token'), 'utf8').trim();
    const configPath = join(pkg, 'pix3-home', 'cdp-mcp.json');
    expect(config.mcpServers['pix3-browser'].args.at(-1)).toBe(`--config=${configPath}`);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      wsEndpoint: 'ws://127.0.0.1:9333/pix3',
      wsHeaders: JSON.stringify({ Authorization: `Bearer ${token}` }),
    });
    expect(readFileSync(join(project, '.mcp.json'), 'utf8')).not.toContain(token);
  });

  it('runs the Chrome owner, with ws bundled', () => {
    // Bad options: the owner says so and exits 2 — proof the hidden command and `ws` load.
    const result = run('__chrome-owner', 'not-json');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('bad options');
  });

  it('needs no runtime dependencies', () => {
    expect(readJson(join(packageDir, 'package.json')).dependencies ?? {}).toEqual({});
    // What esbuild left as a run-time import: only Node built-ins and the optional externals.
    const meta = JSON.parse(readFileSync(join(pkg, 'meta.json'), 'utf8')) as {
      outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    const bare = new Set(
      Object.values(meta.outputs)
        .flatMap(output => output.imports)
        .filter(entry => entry.external === true && !entry.path.startsWith('node:'))
        .map(entry => entry.path)
    );
    const allowed = new Set(['esbuild', 'typescript']);
    for (const spec of bare) {
      if (allowed.has(spec) || builtinModules.includes(spec.split('/')[0])) continue;
      throw new Error(`the bin still imports "${spec}" at run time`);
    }
  });
});

describe('runtime types archive (the published form of runtime-types/)', () => {
  it('round-trips a tree through one file, and reuses an expansion with the same stamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'pix3-rt-archive-'));
    try {
      const tree = join(root, 'tree');
      mkdirSync(join(tree, '@types', 'three', 'src'), { recursive: true });
      writeFileSync(
        join(tree, '@types', 'three', 'src', 'a.d.ts'),
        'export declare const a: 1; // ü\n'
      );
      writeFileSync(join(tree, '@types', 'three', 'LICENSE'), 'MIT\n');
      const manifest = {
        format: RUNTIME_TYPES_FORMAT,
        cliVersion: '9.9.9',
        runtimeVersion: '9.9.9',
        threeTypesVersion: '0.1.0',
        sourceStamp: 'f'.repeat(64),
        builtAt: '2026-01-01T00:00:00.000Z',
      };
      writeFileSync(join(tree, 'manifest.json'), JSON.stringify(manifest));
      const archive = join(root, 'dist', 'runtime-types.json');
      expect(packRuntimeTypes(tree, archive).files).toBe(2);

      const out = join(root, 'expanded');
      const first = expandRuntimeTypes(archive, out);
      expect(first?.dir).toBe(out);
      expect(first?.manifest).toEqual(manifest);
      expect(readFileSync(join(out, '@types', 'three', 'src', 'a.d.ts'), 'utf8')).toContain('ü');
      expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toEqual(manifest);

      writeFileSync(join(out, 'marker'), '');
      expandRuntimeTypes(archive, out);
      expect(readFileSync(join(out, 'marker'), 'utf8')).toBe(''); // not rewritten
      expect(expandRuntimeTypes(join(root, 'missing.json'), out)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
