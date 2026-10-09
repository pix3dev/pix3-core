// @vitest-environment node
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';

import { pix3, type Pix3Options } from '../index.ts';
import { DOT_PNG, FIXTURE_FILES, writeFixtureProject } from '../test-support/build-fixture.ts';
import { readBuildRecord } from './record.ts';

/**
 * `vite build` with `pix3()` on the fixture project (plan §B.6): the single-file html, the zip,
 * `build: false`, the strip decisions and the option handling — judged by what lands in
 * `dist/` and `.pix3/build.json`, not by the plugin's own log.
 */

const roots: string[] = [];
const BUILD_TIMEOUT_MS = 120_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.PIX3_NO_SYNC;
});

const project = (files = FIXTURE_FILES): string => {
  const root = writeFixtureProject(files);
  roots.push(root);
  return root;
};

const runBuild = async (root: string, options: Pix3Options = {}): Promise<string> => {
  await viteBuild({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [pix3(options)],
  });
  return join(root, 'dist');
};

const html = (dist: string): string => readFileSync(join(dist, 'index.html'), 'utf8');

describe('build: html (single file)', () => {
  it(
    'produces one classic-script index.html with the assets embedded and unmentioned modules stubbed',
    async () => {
      const root = project();
      const dist = await runBuild(root);
      const page = html(dist);

      // One file: no chunks, no assets beside it.
      expect(readdirSync(dist)).toEqual(['index.html']);
      // Classic script (DeepCore's compatibility rewrite), at the end of body, no ESM residue.
      expect(page).not.toMatch(/type="module"/);
      expect(page).not.toMatch(/crossorigin/);
      expect(page).not.toMatch(/import\.meta/);
      expect(page.indexOf('<div id="app">')).toBeLessThan(page.lastIndexOf('<script'));
      expect(page).toContain('</script>\n</body>');
      // The assets: the scene as text and the sprite as base64; nothing else from the root.
      expect(page).toContain('"scenes/main.pix3scene"');
      expect(page).toContain(DOT_PNG.toString('base64'));
      expect(page).not.toContain('not shipped');
      // Strip: what the scene names stays, what nothing mentions is a stub (the throw survives
      // minification; the stub's comment does not).
      expect(page).toContain('Slider2D was stripped from this build');
      expect(page).toContain('NetworkService was stripped from this build');
      expect(page).not.toContain('ColorRect2D was stripped');
      expect(page).not.toContain('Label2D was stripped');
      // No PostProcess node: `postprocessing` resolved to the stub, not inlined.
      expect(page).toContain('postprocessing was stripped from this build');
      expect(page).not.toContain('EffectComposer.prototype');
      // The player's manifest from pix3project.yaml.
      expect(page).toContain('"scenes/main.pix3scene"');
      expect(page).toMatch(/width:640,height:360|"width":640,"height":360/);

      const record = readBuildRecord(root);
      expect(record?.format).toBe('html');
      expect(record?.path).toBe(join(dist, 'index.html'));
      expect(record?.bytes).toBe(Buffer.byteLength(page));
      expect(record?.entryScene).toBe('scenes/main.pix3scene');
      expect(record?.assets).toBe(2);
      expect(record?.stripped).toContain('nodes/2D/UI/Slider2D');
      expect(record?.stripped).toContain('net/NetworkService');
      expect(record?.stripped).not.toContain('nodes/2D/ColorRect2D');
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'keeps a module a script mentions, and strips nothing with strip: false',
    async () => {
      const root = project({
        ...FIXTURE_FILES,
        'scripts/UsesTween.ts':
          "import { Script } from '@pix3/runtime';\nexport class UsesTween extends Script {\n  onStart(): void { void this.scene?.tween; }\n}\n",
      });
      await runBuild(root);
      let record = readBuildRecord(root);
      expect(record?.stripped).not.toContain('core/TweenApi');
      expect(record?.stripped).toContain('nodes/2D/UI/Slider2D');

      await runBuild(root, { strip: false });
      record = readBuildRecord(root);
      expect(record?.stripped).toEqual([]);
      expect(html(join(root, 'dist'))).not.toContain('was stripped from this build');
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'boots the entry scene from the option or pix3project.yaml',
    async () => {
      const root = project({
        ...FIXTURE_FILES,
        'scenes/other.pix3scene': FIXTURE_FILES['scenes/main.pix3scene'],
        'scenes/ui/overlay.pix3scene': FIXTURE_FILES['scenes/main.pix3scene'],
      });
      await runBuild(root);
      expect(readBuildRecord(root)?.entryScene).toBe('scenes/main.pix3scene');
      // A `scenes/ui/` overlay is a prefab: shipped (embedded), never navigable. (The scene list
      // itself is constant-folded away once the entry is known, so it is not in the bundle.)
      expect(html(join(root, 'dist'))).toMatch(/[`"']scenes\/ui\/overlay\.pix3scene[`"']/);
      expect(html(join(root, 'dist'))).toMatch(/[`"']scenes\/other\.pix3scene[`"']/);

      await runBuild(root, { entryScene: 'res://scenes/other.pix3scene' });
      expect(readBuildRecord(root)?.entryScene).toBe('scenes/other.pix3scene');
    },
    BUILD_TIMEOUT_MS
  );
});

describe('build: zip', () => {
  it(
    'archives the plain build with the assets beside index.html, nothing inlined',
    async () => {
      const root = project();
      const dist = await runBuild(root, { build: 'zip' });
      const record = readBuildRecord(root);
      expect(record?.format).toBe('zip');
      expect(record?.path).toBe(join(dist, 'Fixture Game.zip'));
      const entries = unzipSync(new Uint8Array(readFileSync(record?.path as string)));
      const names = Object.keys(entries).sort();
      expect(names).toContain('index.html');
      expect(names).toContain('scenes/main.pix3scene');
      expect(names).toContain('sprites/dot.png');
      expect(names.some(name => name.endsWith('.js'))).toBe(true);
      expect(names).not.toContain('Fixture Game.zip');
      expect(Buffer.from(entries['sprites/dot.png'])).toEqual(DOT_PNG);
      const page = Buffer.from(entries['index.html']).toString('utf8');
      // Not single-file: the script is a separate chunk, loaded by a relative URL.
      expect(page).toMatch(/<script type="module" crossorigin src="\.\/[^"]+\.js"/);
      expect(page).not.toContain(DOT_PNG.toString('base64'));
      // Strip applies to every format.
      const code = names
        .filter(name => name.endsWith('.js'))
        .map(name => Buffer.from(entries[name]).toString('utf8'))
        .join('');
      expect(code).toContain('Slider2D was stripped from this build');
    },
    BUILD_TIMEOUT_MS
  );
});

describe('build: false', () => {
  it(
    'leaves vite build alone: module script, assets dir, no record, no stubs',
    async () => {
      const root = project();
      const dist = await runBuild(root, { build: false });
      expect(readBuildRecord(root)).toBeNull();
      expect(existsSync(join(root, '.pix3', 'build.json'))).toBe(false);
      const page = html(dist);
      expect(page).toMatch(/<script type="module" crossorigin src="\/assets\//);
      const chunks = readdirSync(join(dist, 'assets')).filter(name => name.endsWith('.js'));
      expect(chunks.length).toBeGreaterThan(0);
      const code = chunks.map(name => readFileSync(join(dist, 'assets', name), 'utf8')).join('');
      expect(code).not.toContain('was stripped from this build');
      // The player's modules still generate (scene manifest, no embedded assets).
      expect(code).toContain('scenes/main.pix3scene');
    },
    BUILD_TIMEOUT_MS
  );
});
