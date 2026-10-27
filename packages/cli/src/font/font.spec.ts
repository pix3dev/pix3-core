// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { cliPackageRoot } from '../package-root.ts';
import { FONT_CATALOG, fontFileName } from './catalog.ts';
import { runFontCli } from './command.ts';

/** `pix3 font add`: a face the game ships, so text does not look different per machine (game7). */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MANIFEST = `# the project's own comment
version: 1.0.0
viewportBaseSize:
  width: 1080
  height: 1920
projectType: 2d
autoloads: []
`;

const project = (manifest = MANIFEST): string => {
  const root = mkdtempSync(join(tmpdir(), 'pix3-font-'));
  roots.push(root);
  writeFileSync(join(root, 'pix3project.yaml'), manifest);
  return root;
};

const run = async (cwd: string, argv: string[]) => {
  const out = { stdout: '', stderr: '' };
  const code = await runFontCli(argv, {
    cwd,
    stdout: text => void (out.stdout += text),
    stderr: text => void (out.stderr += text),
  });
  return { code, ...out };
};

describe('pix3 font', () => {
  it('every catalog face and licence is in the package, and is a woff2', () => {
    const dir = join(cliPackageRoot(), 'fonts');
    for (const font of FONT_CATALOG) {
      expect(existsSync(join(dir, font.licenseFile)), font.licenseFile).toBe(true);
      for (const subset of font.subsets) {
        const bytes = readFileSync(join(dir, fontFileName(font, subset)));
        expect(bytes.subarray(0, 4).toString('latin1'), font.family).toBe('wOF2');
      }
    }
    const pkg = JSON.parse(readFileSync(join(cliPackageRoot(), 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('fonts');
  });

  it('add copies the faces and the licence and registers them, keeping the manifest as written', async () => {
    const root = project();
    const first = await run(root, ['add', 'nunito']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('labelFontFamily: "Nunito", labelFontWeight: 900');
    for (const file of ['nunito-900-latin.woff2', 'nunito-900-cyrillic.woff2', 'nunito-OFL.txt'])
      expect(existsSync(join(root, 'fonts', file)), file).toBe(true);
    const text = readFileSync(join(root, 'pix3project.yaml'), 'utf8');
    expect(text.startsWith("# the project's own comment\n")).toBe(true);
    const manifest = parse(text) as { fonts: { family: string; path: string; weight: number }[] };
    expect(manifest.fonts.map(face => [face.family, face.path, face.weight])).toEqual([
      ['Nunito', 'fonts/nunito-900-latin.woff2', 900],
      ['Nunito', 'fonts/nunito-900-cyrillic.woff2', 900],
    ]);

    // Again: nothing to write. A second family appends to the same list.
    expect((await run(root, ['add', 'Nunito'])).stdout).toContain('nothing written');
    expect((await run(root, ['add', 'Lilita', 'One'])).code).toBe(0);
    const after = parse(readFileSync(join(root, 'pix3project.yaml'), 'utf8')) as {
      fonts: { path: string }[];
    };
    expect(after.fonts.map(face => face.path)).toEqual([
      'fonts/nunito-900-latin.woff2',
      'fonts/nunito-900-cyrillic.woff2',
      'fonts/lilita-one-400-latin.woff2',
    ]);
  });

  it('refuses an unknown family, and a project file of the same name with other bytes', async () => {
    const root = project();
    const unknown = await run(root, ['add', 'Comic Sans']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Nunito');
    const theirs = join(root, 'fonts');
    mkdirSync(theirs);
    writeFileSync(join(theirs, 'rubik-800-latin.woff2'), 'mine');
    const clash = await run(root, ['add', 'Rubik']);
    expect(clash.code).toBe(1);
    expect(existsSync(join(theirs, 'rubik-OFL.txt'))).toBe(false);
    expect(readFileSync(join(root, 'pix3project.yaml'), 'utf8')).toBe(MANIFEST);
  });

  it('lists the families', async () => {
    const listed = await run(project(), []);
    for (const font of FONT_CATALOG) expect(listed.stdout).toContain(font.family);
  });
});
