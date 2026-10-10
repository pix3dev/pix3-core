// @vitest-environment node
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';

import { pix3, type Pix3Options } from '../index.ts';
import {
  DOT_PNG,
  FIXTURE_FILES,
  NAMED_IMPORT_LIB,
  NAMESPACE_IMPORT_LIB,
  UNDECLARED_IMPORT_LIB,
  usesLibScript,
  writeFixtureProject,
  type FixtureProjectOptions,
} from '../test-support/build-fixture.ts';
import { buildRecordPath, type BuildRecord } from './record.ts';
import type { BuildReport } from './report.ts';

/**
 * `vite build` with `pix3()` on the fixture project (plan §B.6): the single-file html, the zip,
 * `build: false`, the strip decisions and the option handling — judged by what lands in
 * `dist/` and `.pix3/build.json`, not by the plugin's own log.
 */

/** `.pix3/build.json` as the build left it, or null (nothing but specs reads it back). */
const readBuildRecord = (root: string): BuildRecord | null => {
  try {
    return JSON.parse(readFileSync(buildRecordPath(root), 'utf8')) as BuildRecord;
  } catch {
    return null;
  }
};

const roots: string[] = [];
const BUILD_TIMEOUT_MS = 120_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.PIX3_NO_SYNC;
});

const project = (files = FIXTURE_FILES, options: FixtureProjectOptions = {}): string => {
  const root = writeFixtureProject(files, options);
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
const report = (root: string): BuildReport =>
  JSON.parse(readFileSync(readBuildRecord(root)?.report as string, 'utf8')) as BuildReport;

/** The embedded bytes of one asset, decoded from the page. */
const embeddedAsset = (page: string, resPath: string): Buffer => {
  const key = resPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(
    `${key}[\`"']?\\s*:\\s*\\{\\s*base64\\s*:\\s*[\`"']([A-Za-z0-9+/=]+)`
  ).exec(page);
  if (!match) throw new Error(`${resPath} is not embedded`);
  return Buffer.from(match[1], 'base64');
};

const withLib = (
  lib: Readonly<Record<string, string>>,
  fn: string,
  declared = true
): { files: Record<string, string | Buffer>; options: FixtureProjectOptions } => {
  const name = (JSON.parse(lib['package.json']) as { name: string }).name;
  return {
    files: {
      ...FIXTURE_FILES,
      'package.json': JSON.stringify({
        name: 'fixture',
        private: true,
        dependencies: declared ? { [name]: '*' } : {},
      }),
      'scripts/UsesLib.ts': usesLibScript(name, fn),
    },
    options: { packages: { [name]: lib } },
  };
};

describe('build: html (single file)', () => {
  it(
    'produces one classic-script index.html with the assets embedded and unmentioned modules stubbed',
    async () => {
      const root = project();
      const dist = await runBuild(root);
      const page = html(dist);

      // One artifact and its report: no chunks, no assets beside it.
      expect(readdirSync(dist).sort()).toEqual(['index.html', 'index.report.json']);
      // Classic script (DeepCore's compatibility rewrite), at the end of body, no ESM residue.
      expect(page).not.toMatch(/type="module"/);
      expect(page).not.toMatch(/crossorigin/);
      expect(page).not.toMatch(/import\.meta/);
      expect(page.indexOf('<div id="app">')).toBeLessThan(page.lastIndexOf('<script'));
      expect(page).toContain('</script>\n</body>');
      // The assets: the scene (as JSON — plan §B.6 item 4) and the sprite; nothing else.
      expect(page).toContain('"scenes/main.pix3scene"');
      expect(page).toContain(DOT_PNG.toString('base64'));
      expect(page).not.toContain('not shipped');
      const scene = JSON.parse(embeddedAsset(page, 'scenes/main.pix3scene').toString('utf8')) as {
        root: { id: string; children: { type: string }[] }[];
      };
      expect(scene.root[0].id).toBe('stage');
      expect(scene.root[0].children.map(child => child.type)).toEqual([
        'ColorRect2D',
        'Sprite2D',
        'Label2D',
      ]);
      expect(embeddedAsset(page, 'sprites/dot.png')).toEqual(DOT_PNG);
      // Strip: what the scene names stays, what nothing mentions is a stub (the throw survives
      // minification; the stub's comment does not).
      expect(page).toContain('Slider2D was stripped from this build');
      expect(page).toContain('NetworkService was stripped from this build');
      expect(page).not.toContain('ColorRect2D was stripped');
      expect(page).not.toContain('Label2D was stripped');
      // No PostProcess node: `postprocessing` resolved to the stub, not inlined.
      expect(page).toContain('postprocessing was stripped from this build');
      expect(page).not.toContain('EffectComposer.prototype');
      // No model: `GLTFLoader` is the stub. No YAML parser: the scenes are JSON.
      expect(page).toContain('GLTFLoader was stripped from this build');
      expect(page).not.toContain('KHR_materials');
      expect(page).not.toMatch(/YAMLParseError|LineCounter|composeDoc/);
      // The player's manifest from pix3project.yaml.
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
      expect(record?.report).toBe(join(dist, 'index.report.json'));

      // The report: sizes by group, the stubs, the assets — enough for "why is it this big".
      const sizes = report(root);
      expect(sizes.format).toBe('html');
      expect(sizes.bytes).toBe(record?.bytes);
      expect(sizes.gzipBytes).toBeGreaterThan(0);
      expect(sizes.gzipBytes).toBeLessThan(sizes.bytes);
      expect(sizes.compress).toEqual({ enabled: false });
      expect(sizes.code.bundleBytes).toBeGreaterThan(500_000);
      expect(sizes.code.groups.three.renderedBytes).toBeGreaterThan(
        sizes.code.groups.runtime.renderedBytes
      );
      expect(sizes.code.groups.three.share + sizes.code.groups.runtime.share).toBeGreaterThan(0.9);
      expect(sizes.code.groups.project.modules).toBeGreaterThan(0);
      expect(sizes.code.groups.assets.modules).toBe(1);
      expect(Object.keys(sizes.code.packages)).toContain('three');
      expect(Object.keys(sizes.code.packages)).not.toContain('yaml');
      expect(Object.keys(sizes.code.packages)).not.toContain('postprocessing');
      expect(sizes.code.largestModules[0].id).toMatch(/^three\//);
      expect(sizes.code.largestModules.some(m => m.id.startsWith('@pix3/runtime/src/'))).toBe(true);
      expect(sizes.strip).toMatchObject({
        enabled: true,
        keep: [],
        dependencies: {},
        dependencyImports: [],
      });
      expect(sizes.strip.stripped).toEqual(record?.stripped);
      expect(sizes.libraries.yaml).toMatch(/^stub/);
      expect(sizes.libraries.GLTFLoader).toMatch(/^stub/);
      expect(sizes.libraries.postprocessing).toMatch(/^stub/);
      expect(sizes.assets.count).toBe(2);
      expect(sizes.assets.entries.map(entry => entry.path)).toEqual([
        'scenes/main.pix3scene',
        'sprites/dot.png',
      ]);
      expect(sizes.assets.entries[1].rawBytes).toBe(DOT_PNG.byteLength);
      expect(sizes.assets.base64Bytes).toBeGreaterThan(sizes.assets.rawBytes);
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
      const page = html(join(root, 'dist'));
      expect(page).not.toContain('was stripped from this build');
      // Nothing stubbed: the real parser and loader ship, the scene stays YAML.
      const sizes = report(root);
      expect(Object.keys(sizes.code.packages)).toContain('yaml');
      expect(sizes.libraries.yaml).toBe('bundled');
      expect(sizes.libraries.GLTFLoader).toBe('bundled');
      expect(embeddedAsset(page, 'scenes/main.pix3scene').toString('utf8')).toContain(
        'type: Group2D'
      );
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'keeps GLTFLoader when a scene or script names a model',
    async () => {
      const root = project({
        ...FIXTURE_FILES,
        'scripts/LoadsModel.ts':
          "import { Script } from '@pix3/runtime';\nexport class LoadsModel extends Script {\n  onStart(): void { void 'res://models/crate.glb'; }\n}\n",
      });
      await runBuild(root);
      expect(report(root).libraries.GLTFLoader).toBe('bundled');
      expect(html(join(root, 'dist'))).not.toContain('GLTFLoader was stripped');
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

  it(
    'compress: the bundle ships gzip + base64 behind a DecompressionStream bootstrap, as an iife',
    async () => {
      const root = project();
      await runBuild(root);
      const plainBytes = readBuildRecord(root)?.bytes as number;

      const dist = await runBuild(root, { compress: true });
      const page = html(dist);
      expect(readdirSync(dist).sort()).toEqual(['index.html', 'index.report.json']);
      // One classic script: the bootstrap. No module script, no blob/data URL, no eval.
      expect(page.match(/<script\b/g)).toHaveLength(1);
      expect(page).not.toMatch(/type="module"/);
      expect(page).toContain("new DecompressionStream('gzip')");
      expect(page).toContain('script.textContent = code');
      expect(page).not.toMatch(/createObjectURL|data:text\/javascript|\beval\(|new Function/);
      // The payload inflates to the whole bundle, wrapped as an iife.
      const payload = /var payload = "([A-Za-z0-9+/=]+)"/.exec(page);
      expect(payload).not.toBeNull();
      const code = gunzipSync(Buffer.from(payload?.[1] as string, 'base64')).toString('utf8');
      expect(code.startsWith('(function(){')).toBe(true);
      expect(code.trimEnd().endsWith('})();')).toBe(true);
      expect(code).toContain('WebGLRenderer');
      expect(code).toContain('Slider2D was stripped from this build');
      expect(code).toContain(DOT_PNG.toString('base64'));
      expect(code).not.toMatch(/import\.meta/);
      // About two thirds off the file.
      const record = readBuildRecord(root);
      expect(record?.bytes).toBeLessThan(plainBytes * 0.45);
      const sizes = report(root);
      expect(sizes.compress.enabled).toBe(true);
      if (sizes.compress.enabled) {
        expect(sizes.compress.bundleBytes).toBe(Buffer.byteLength(code, 'utf8'));
        expect(sizes.compress.base64Bytes).toBe((payload?.[1] as string).length);
        expect(sizes.compress.ratio).toBeLessThan(0.4);
        expect(sizes.compress.savedBytes).toBeGreaterThan(plainBytes * 0.5);
      }
    },
    BUILD_TIMEOUT_MS
  );
});

describe('build: a dependency that imports @pix3/runtime (N11, plan §B.6 item 2)', () => {
  it(
    'keeps what a declared dependency imports by name: GeometryMesh is not stubbed',
    async () => {
      const { files, options } = withLib(NAMED_IMPORT_LIB, 'makeBox');
      const root = project(files, options);
      await runBuild(root);
      const record = readBuildRecord(root);
      // Strip is on (the P1 rule switched it off for any such dependency), the named import kept.
      expect(record?.stripped).toContain('nodes/2D/UI/Slider2D');
      expect(record?.stripped).not.toContain('nodes/3D/GeometryMesh');
      const page = html(join(root, 'dist'));
      expect(page).not.toContain('GeometryMesh was stripped');
      expect(page).toContain('Slider2D was stripped');
      const sizes = report(root);
      expect(sizes.strip.dependencies).toEqual({ 'named-import-lib': 1 });
      expect(sizes.strip.dependencyImports).toEqual(['GeometryMesh']);
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'import * as: strip goes off with a message naming pix3({ strip: { keep } }); keep turns it back on',
    async () => {
      const { files, options } = withLib(NAMESPACE_IMPORT_LIB, 'makeBox');
      const root = project(files, options);
      await runBuild(root);
      let record = readBuildRecord(root);
      expect(record?.stripped).toEqual([]);
      let sizes = report(root);
      expect(sizes.strip.enabled).toBe(false);
      expect(sizes.strip.reason).toContain(
        "namespace-import-lib/index.js: import * as pix3 from '@pix3/runtime'"
      );
      expect(sizes.strip.reason).toContain('pix3({ strip: { keep:');
      expect(html(join(root, 'dist'))).not.toContain('was stripped from this build');

      await runBuild(root, { strip: { keep: ['GeometryMesh'] } });
      record = readBuildRecord(root);
      expect(record?.stripped).toContain('nodes/2D/UI/Slider2D');
      expect(record?.stripped).not.toContain('nodes/3D/GeometryMesh');
      sizes = report(root);
      expect(sizes.strip.enabled).toBe(true);
      expect(sizes.strip.keep).toEqual(['GeometryMesh']);
      expect(sizes.strip.reason).toContain('stripping anyway');
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'the transform net: a dependency that never declared the runtime fails the build with the fix',
    async () => {
      const { files, options } = withLib(UNDECLARED_IMPORT_LIB, 'makeSlider', false);
      const root = project(files, options);
      await expect(runBuild(root)).rejects.toThrow(
        /undeclared-import-lib\/index\.js imports Slider2D from @pix3\/runtime, which this build stripped[\s\S]*pix3\(\{ strip: \{ keep \} \}\)/
      );
      // Named, it builds and keeps the module.
      await runBuild(root, { strip: { keep: ['Slider2D'] } });
      expect(readBuildRecord(root)?.stripped).not.toContain('nodes/2D/UI/Slider2D');
      expect(html(join(root, 'dist'))).not.toContain('Slider2D was stripped');
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
      expect(record?.report).toBe(join(dist, 'Fixture Game.report.json'));
      const entries = unzipSync(new Uint8Array(readFileSync(record?.path as string)));
      const names = Object.keys(entries).sort();
      expect(names).toContain('index.html');
      expect(names).toContain('scenes/main.pix3scene');
      expect(names).toContain('sprites/dot.png');
      expect(names.some(name => name.endsWith('.js'))).toBe(true);
      expect(names).not.toContain('Fixture Game.zip');
      expect(names).not.toContain('Fixture Game.report.json');
      expect(Buffer.from(entries['sprites/dot.png'])).toEqual(DOT_PNG);
      // The scene beside index.html is the JSON document (the runtime's `yaml` is the stub).
      const scene = JSON.parse(Buffer.from(entries['scenes/main.pix3scene']).toString('utf8')) as {
        root: { id: string }[];
      };
      expect(scene.root[0].id).toBe('stage');
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
      expect(code).toContain('GLTFLoader was stripped from this build');
      expect(code).not.toMatch(/YAMLParseError|LineCounter/);
      const sizes = report(root);
      expect(sizes.format).toBe('zip');
      expect(sizes.compress).toEqual({ enabled: false });
      expect(sizes.assets.entries.map(entry => entry.path)).toEqual([
        'scenes/main.pix3scene',
        'sprites/dot.png',
      ]);
      expect(sizes.code.groups.three.renderedBytes).toBeGreaterThan(0);
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
      expect(readdirSync(dist).some(name => name.endsWith('.report.json'))).toBe(false);
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
