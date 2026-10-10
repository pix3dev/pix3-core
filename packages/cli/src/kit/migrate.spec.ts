// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import * as runtime from '@pix3/runtime';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { ensureRuntimeTypes } from '../types/runtime-types.ts';
import { USAGE } from '../usage.ts';
import { CLI_VERSION } from '../version.ts';
import { extractCoreComponents, type RuntimeLike } from './core-components.ts';
import { generateKit } from './generate.ts';
import { KIT_PROJECT_MANIFEST, readProjectKitManifest } from './install.ts';
import { kitSrcDir, repoRootOfCheckout, type KitSource } from './kit-source.ts';
import {
  formatMigrationReport,
  isRetiredPix3McpEntry,
  legacyMarkersIn,
  MIGRATE_STAGING_DIR,
  migrateKit,
} from './migrate.ts';

/**
 * `pix3 kit --migrate` (plan §A.4 step 2, `.plans/kit.md` K5): a 1.x kit → the 2.x kit, never
 * clobbering a file someone edited, and saying what it changed.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-kit-migrate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let kit: KitSource;
beforeAll(() => {
  const outDir = join(scratch, 'kit');
  const manifest = generateKit({
    repoRoot: repoRootOfCheckout(),
    kitSrcDir: kitSrcDir(),
    outDir,
    version: CLI_VERSION,
    coreComponents: extractCoreComponents(runtime as unknown as RuntimeLike),
  });
  kit = { dir: outDir, filesDir: join(outDir, 'files'), manifest };
}, 120_000);

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

const write = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const ONE_X_AGENTS =
  '<!-- Pix3 agent kit 1.6.2 -->\n# AGENTS.md\n\nThe MCP server in `.mcp.json` (`pix3 mcp --workspace`) gives you the live channel.\n';
const ONE_X_VERIFY =
  '---\nname: pix3-verify\ndescription: 1.x\n---\nRun `game_run` through `pix3 mcp`; read the merge-log.\n';

let counter = 0;
/** A starter dressed as a 1.x project: the 1.x kit files, manifest, .mcp.json, pix3Hybrid. */
const oneXProject = (
  options: { editVerify?: boolean; extraServer?: boolean; editRetired?: boolean } = {}
): string => {
  const template = listTemplates().find(t => t.id === '2d');
  if (!template) throw new Error('2d starter missing');
  const root = join(scratch, `p${++counter}`);
  createProject({ template, dir: root });
  const files: Record<string, string> = {
    'AGENTS.md': ONE_X_AGENTS,
    'CLAUDE.md': '@AGENTS.md\n',
    '.claude/skills/pix3-verify/SKILL.md': ONE_X_VERIFY,
    '.claude/skills/pix3-live/SKILL.md': 'The 1.x live channel skill.\n',
    '.claude/skills/pix3-recipes/notes.md': 'Recipe notes.\n',
  };
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  write(
    root,
    KIT_PROJECT_MANIFEST,
    `${JSON.stringify(
      {
        format: 1,
        version: '1.6.2',
        files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha256(t)])),
      },
      null,
      2
    )}\n`
  );
  // Edits made after the 1.x kit wrote them.
  if (options.editVerify) {
    write(root, '.claude/skills/pix3-verify/SKILL.md', `${ONE_X_VERIFY}\nOur team note.\n`);
  }
  if (options.editRetired) {
    write(root, '.claude/skills/pix3-recipes/notes.md', 'Recipe notes.\nOurs.\n');
  }
  const servers: Record<string, unknown> = {
    pix3: { command: 'npx', args: ['-y', '@pix3/cli@1.6.2', 'mcp', '--workspace'] },
  };
  if (options.extraServer) servers.github = { command: 'gh-mcp', args: ['--stdio'] };
  write(root, '.mcp.json', `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  const manifestPath = join(root, 'pix3project.yaml');
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace(
      /^metadata:\n/m,
      'metadata:\n  pix3Hybrid:\n    cloudProjectId: 5ca65d89-0000\n  agentKit:\n    version: 1.6.2\n    files:\n      - .mcp.json\n      - AGENTS.md\n'
    )
  );
  return root;
};

describe('pix3 kit --migrate', () => {
  it('is a flag of pix3 kit', () => {
    expect(USAGE).toMatch(/pix3 kit \[--update\]\s+.*\n\s+\[--migrate\]/);
  });

  it('recognises the 1.x pix3 mcp server and nothing else', () => {
    expect(
      isRetiredPix3McpEntry({
        command: 'npx',
        args: ['-y', '@pix3/cli@1.6.2', 'mcp', '--workspace'],
      })
    ).toBe(true);
    expect(
      isRetiredPix3McpEntry({
        command: 'node',
        args: ['/home/me/pix3/packages/cli/src/index.ts', 'mcp', '--workspace'],
      })
    ).toBe(true);
    expect(isRetiredPix3McpEntry({ command: 'pix3', args: ['mcp'] })).toBe(true);
    // 2.x's own server and anyone else's stay.
    expect(
      isRetiredPix3McpEntry({
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@1.10.1', '--browserUrl=http://127.0.0.1:9333'],
      })
    ).toBe(false);
    expect(isRetiredPix3McpEntry({ command: 'npx', args: ['some-mcp', 'mcp'] })).toBe(false);
    expect(
      isRetiredPix3McpEntry({ command: 'npx', args: ['-y', '@pix3/cli@2.0.0', 'check'] })
    ).toBe(false);
  });

  it('migrates an untouched 1.x kit: mcp server, retired files, pix3Hybrid out, 2.x kit in', () => {
    const root = oneXProject();
    const report = migrateKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });

    expect(report.from).toBe('1.6.2');
    // .mcp.json had only the 1.x server: gone.
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(report.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.mcp.json', action: 'removed' }),
        expect.objectContaining({ path: '.claude/skills/pix3-live/SKILL.md', action: 'removed' }),
        expect.objectContaining({
          path: '.claude/skills/pix3-recipes/notes.md',
          action: 'removed',
        }),
        expect.objectContaining({ path: 'pix3project.yaml', action: 'removed' }),
      ])
    );
    expect(existsSync(join(root, '.claude/skills/pix3-live'))).toBe(false); // empty folder pruned
    // Unedited 1.x kit files became the 2.x ones.
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(
      readFileSync(join(kit.filesDir, 'AGENTS.md'), 'utf8')
    );
    expect(readFileSync(join(root, '.claude/skills/pix3-verify/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(kit.filesDir, '.claude/skills/pix3-verify/SKILL.md'), 'utf8')
    );
    expect(existsSync(join(root, '.claude/skills/pix3-editor/SKILL.md'))).toBe(true);
    const manifest = parse(readFileSync(join(root, 'pix3project.yaml'), 'utf8')) as {
      metadata: Record<string, unknown> & { agentKit: { version: string; files: string[] } };
    };
    expect(manifest.metadata.pix3Hybrid).toBeUndefined();
    expect(manifest.metadata.agentKit.version).toBe(CLI_VERSION);
    expect(manifest.metadata.agentKit.files).not.toContain('.mcp.json');
    expect(manifest.metadata.projectId).toBeDefined(); // the rest of metadata kept
    expect(readProjectKitManifest(root)?.version).toBe(CLI_VERSION);
    expect(Object.keys(readProjectKitManifest(root)?.files ?? {})).not.toContain(
      '.claude/skills/pix3-live/SKILL.md'
    );
    // What to do next: the 2.x agent config, the global Codex table.
    const todo = report.instructions.join('\n');
    expect(todo).toContain('npx pix3 agent-setup');
    expect(todo).toContain('~/.codex/config.toml');
    const text = formatMigrationReport(report, root);
    expect(text).toContain(`Pix3 kit migration 1.6.2 → ${CLI_VERSION}`);
    expect(text).toContain('mcpServers.pix3 (npx -y @pix3/cli@1.6.2 mcp --workspace)');
    expect(text).toContain('cloudProjectId');

    // Idempotent.
    const again = migrateKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(again.steps).toEqual([]);
    expect(again.kit.files.every(f => f.action === 'unchanged')).toBe(true);
    expect(formatMigrationReport(again, root)).toContain('nothing of the 1.x kit left to remove');
  }, 60_000);

  it('never clobbers an edit: other servers stay, edited files are kept and flagged', () => {
    const root = oneXProject({ editVerify: true, extraServer: true, editRetired: true });
    const verifyBefore = readFileSync(join(root, '.claude/skills/pix3-verify/SKILL.md'), 'utf8');
    const report = migrateKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });

    // .mcp.json keeps the other server.
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['github']);
    // The edited 1.x skill is left byte for byte, flagged, and the 2.x text staged beside.
    expect(readFileSync(join(root, '.claude/skills/pix3-verify/SKILL.md'), 'utf8')).toBe(
      verifyBefore
    );
    const staged = join(root, MIGRATE_STAGING_DIR, '.claude/skills/pix3-verify/SKILL.md');
    expect(readFileSync(staged, 'utf8')).toBe(
      readFileSync(join(kit.filesDir, '.claude/skills/pix3-verify/SKILL.md'), 'utf8')
    );
    expect(report.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.claude/skills/pix3-verify/SKILL.md',
          action: 'staged',
          detail: expect.stringContaining('`pix3 mcp`'),
        }),
        expect.objectContaining({ path: '.claude/skills/pix3-recipes/notes.md', action: 'kept' }),
      ])
    );
    // The edited retired file is kept.
    expect(readFileSync(join(root, '.claude/skills/pix3-recipes/notes.md'), 'utf8')).toContain(
      'Ours.'
    );
    expect(report.instructions.join('\n')).toContain(
      'Merge .claude/skills/pix3-verify/SKILL.md by hand'
    );
    expect(formatMigrationReport(report, root)).toContain('STILL 1.x');
  }, 60_000);

  it('an edited 1.x AGENTS.md stays; the 2.x kit goes beside it and the report says so', () => {
    const root = oneXProject();
    write(root, 'AGENTS.md', `${ONE_X_AGENTS}\n## Our rules\n\nCommit small.\n`);
    const report = migrateKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('Commit small.');
    expect(existsSync(join(root, 'AGENTS.pix3.md'))).toBe(true);
    expect(report.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'AGENTS.md', action: 'kept' })])
    );
    expect(report.instructions.join('\n')).toContain('Remove the 1.x kit text from AGENTS.md');
  }, 60_000);

  it('the 2.x kit itself carries none of the 1.x markers', () => {
    for (const file of kit.manifest.files) {
      expect(legacyMarkersIn(readFileSync(join(kit.filesDir, file), 'utf8')), file).toEqual([]);
    }
  });

  const deepCore = join(repoRootOfCheckout(), '..', 'DeepCore');
  it.skipIf(!existsSync(join(deepCore, 'pix3project.yaml')))(
    'a copy of DeepCore (1.6.2 kit): .mcp.json, pix3Hybrid and the 1.x kit text go, its own files stay',
    () => {
      const copy = join(scratch, 'DeepCore');
      cpSync(deepCore, copy, {
        recursive: true,
        filter: source => {
          const rel = relative(deepCore, source).split(sep)[0];
          return rel !== '.git' && rel !== 'node_modules';
        },
      });
      const own = ['AGENTS.md', 'tsconfig.json', 'package.json', 'vite.config.ts'].map(file => [
        file,
        existsSync(join(copy, file)) ? sha256(readFileSync(join(copy, file))) : null,
      ]);
      const report = migrateKit(copy, kit);
      for (const [file, hash] of own) {
        if (hash)
          expect(sha256(readFileSync(join(copy, file as string))), file as string).toBe(hash);
      }
      expect(report.from).toBe('1.6.2');
      const mcpLeft = existsSync(join(copy, '.mcp.json'))
        ? (JSON.parse(readFileSync(join(copy, '.mcp.json'), 'utf8')) as {
            mcpServers?: Record<string, unknown>;
          })
        : null;
      expect(Object.values(mcpLeft?.mcpServers ?? {}).some(isRetiredPix3McpEntry)).toBe(false);
      const manifest = parse(readFileSync(join(copy, 'pix3project.yaml'), 'utf8')) as {
        metadata: Record<string, unknown> & { agentKit: { version: string } };
      };
      expect(manifest.metadata.pix3Hybrid).toBeUndefined();
      expect(manifest.metadata.agentKit.version).toBe(CLI_VERSION);
      // Every kit file is now the 2.x text, or flagged as edited 1.x text with the 2.x staged.
      for (const file of kit.manifest.files) {
        if (file === 'CLAUDE.md' || file === 'tsconfig.json') continue;
        const target = file === 'AGENTS.md' ? 'AGENTS.pix3.md' : file;
        const text = readFileSync(join(copy, target), 'utf8');
        const expected = readFileSync(join(kit.filesDir, file), 'utf8');
        if (text.includes(expected.split('\n')[1] ?? expected)) continue;
        expect(
          report.steps.some(step => step.path === target && step.action === 'staged'),
          target
        ).toBe(true);
      }
      expect(formatMigrationReport(report, copy)).toContain('1.6.2 →');
    },
    120_000
  );
});
