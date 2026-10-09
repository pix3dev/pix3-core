// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseArgs, pix3Entry } from './create.js';

const BIN = fileURLToPath(new URL('../index.js', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'create-pix3-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The bin as `npm create pix3` runs it: no TTY (stdin is a pipe), so nothing is asked. */
const create = (args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd: scratch, encoding: 'utf8', input: '' });

describe('create-pix3 arguments', () => {
  it('reads dir, --template / -t / --2d / --3d, --name, --yes', () => {
    expect(parseArgs(['game', '--template', '3d', '--yes'])).toEqual({
      dir: 'game',
      template: '3d',
      yes: true,
      help: false,
    });
    expect(parseArgs(['-t=2d', '--name=My Game', 'x'])).toMatchObject({
      dir: 'x',
      template: '2d',
      name: 'My Game',
    });
    expect(parseArgs(['--3d'])).toMatchObject({ template: '3d' });
    expect(() => parseArgs(['a', 'b'])).toThrow(/unknown argument "b"/);
  });

  it('runs the pix3 CLI from its sources in a checkout', () => {
    expect(pix3Entry()).toMatch(/packages[\\/]cli[\\/]src[\\/]index\.ts$/);
  });
});

describe('npm create pix3', () => {
  for (const template of ['2d', '3d']) {
    it(`--template ${template}: an empty ${template} project with the agent kit`, () => {
      const result = create([`game-${template}`, '--template', template, '--name', 'Game']);
      expect(result.stderr).not.toMatch(/error/i);
      expect(result.status).toBe(0);
      const dir = join(scratch, `game-${template}`);
      expect(result.stdout).toContain(`Created Game (Empty ${template.toUpperCase()}) in ${dir}`);
      expect(result.stdout).toContain('npm run dev');
      for (const file of [
        'package.json',
        'vite.config.ts',
        'index.html',
        'src/main.ts',
        'tsconfig.json',
        '.gitignore',
        'scenes/main.pix3scene',
        'AGENTS.md',
        'CLAUDE.md',
      ]) {
        expect(existsSync(join(dir, file)), file).toBe(true);
      }
      const manifest = parse(readFileSync(join(dir, 'pix3project.yaml'), 'utf8')) as {
        projectType: string;
        defaultExportScenePath: string;
        metadata: { templateId: string; agentKit?: unknown };
      };
      expect(manifest).toMatchObject({
        projectType: template,
        defaultExportScenePath: 'scenes/main.pix3scene',
        metadata: { templateId: template, agentKit: expect.anything() },
      });
    }, 120_000);
  }

  it('--yes without a template takes 2d and the default folder', () => {
    const result = create(['--yes']);
    expect(result.status).toBe(0);
    const manifest = parse(
      readFileSync(join(scratch, 'pix3-game', 'pix3project.yaml'), 'utf8')
    ) as { projectType: string };
    expect(manifest.projectType).toBe('2d');
  }, 120_000);

  it('refuses a template that is not a starter', () => {
    const result = create(['x', '--template', 'tapper', '--yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"tapper" is not a starter (2d, 3d)');
    expect(existsSync(join(scratch, 'x'))).toBe(false);
  });
});
