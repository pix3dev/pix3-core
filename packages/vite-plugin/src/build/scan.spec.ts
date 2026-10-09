// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toClassicScriptHtml } from './classic-script.ts';
import { parseProjectManifest } from './project-manifest.ts';
import { isPrefabPath, scanProject } from './scan.ts';
import { decideStrip, runtimeDependents } from './strip-decision.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pix3-scan-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
};

const manifest = (text = ''): ReturnType<typeof parseProjectManifest> =>
  parseProjectManifest(text, 'fixture');

describe('scanProject (plan §B.6 item 1)', () => {
  it('reads every text source outside node_modules/dist/.pix3 and collects mentions', async () => {
    const root = project({
      'scenes/main.pix3scene':
        'root:\n  - id: a\n    type: Slider2D\n    components:\n      - type: core:Follow\n',
      'src/game.ts': "import { GeometryMesh } from '@pix3/runtime';\nnew GeometryMesh();\n",
      'scripts/Hud.ts': 'export const x = 1; // mentions Checkbox2D\n',
      'scripts/Hud.spec.ts': 'Joystick2D',
      'node_modules/dep/index.js': 'Bar2D',
      'dist/index.html': 'PointLightNode',
      '.pix3/types/kit.d.ts': 'SpotLightNode',
      'package-lock.json': '{"NetworkService": 1}',
    });
    const scan = await scanProject({ root, resRoot: '.', manifest: manifest() });
    expect(scan.mentionedNames.has('Slider2D')).toBe(true);
    expect(scan.mentionedNames.has('core:Follow')).toBe(true);
    expect(scan.mentionedNames.has('GeometryMesh')).toBe(true);
    expect(scan.mentionedNames.has('Checkbox2D')).toBe(true);
    // Specs, declarations, node_modules, dist, .pix3 and lockfiles do not count.
    expect(scan.mentionedNames.has('Joystick2D')).toBe(false);
    expect(scan.mentionedNames.has('Bar2D')).toBe(false);
    expect(scan.mentionedNames.has('PointLightNode')).toBe(false);
    expect(scan.mentionedNames.has('SpotLightNode')).toBe(false);
    expect(scan.usesNetwork).toBe(false);
    expect(scan.textSourceCount).toBe(3);
  });

  it('ships every scene and prefab, what they reference, and expands directories', async () => {
    const root = project({
      'scenes/main.pix3scene':
        'root:\n  - id: a\n    type: Sprite2D\n    properties:\n      texture: res://sprites/hero.png\n  - id: p\n    instance: res://prefabs/coin.pix3scene\n',
      'prefabs/coin.pix3scene':
        'root:\n  - id: c\n    type: AnimatedSprite2D\n    properties:\n      animation: res://anims/spin.pix3anim\n',
      'anims/spin.pix3anim': '{"frames":["res://frames/a.png","res://frames/b.png"]}',
      'scripts/Fx.ts': 'const BASE = `res://sfx/boom/ex${i}.png`;\nconst dir = "res://levels";\n',
      'sprites/hero.png': 'png',
      'frames/a.png': 'a',
      'frames/b.png': 'b',
      'sfx/boom/ex1.png': '1',
      'sfx/boom/ex2.png': '2',
      'levels/1.pix3scene': 'root: []\n',
      'levels/2.pix3scene': 'root: []\n',
      'sprites/unused.png': 'x',
      'README.md': 'not shipped',
    });
    const scan = await scanProject({ root, resRoot: '.', manifest: manifest() });
    expect(scan.assetPaths).toEqual([
      'anims/spin.pix3anim',
      'frames/a.png',
      'frames/b.png',
      'levels/1.pix3scene',
      'levels/2.pix3scene',
      'prefabs/coin.pix3scene',
      'scenes/main.pix3scene',
      'sfx/boom/ex1.png',
      'sfx/boom/ex2.png',
      'sprites/hero.png',
    ]);
    expect(scan.scenePaths).toEqual([
      'levels/1.pix3scene',
      'levels/2.pix3scene',
      'scenes/main.pix3scene',
    ]);
    expect(scan.entryScenePath).toBe('scenes/main.pix3scene');
    expect(scan.netKindPrefabs).toEqual(['prefabs/coin.pix3scene']);
    expect(scan.warnings).toEqual([]);
  });

  it('honours resRoot: scenes live under it, paths are res://-relative', async () => {
    const root = project({
      'src/assets/scenes/main.pix3scene':
        'root:\n  - id: a\n    type: Sprite2D\n    properties:\n      texture: res://textures/a.png\n',
      'src/assets/textures/a.png': 'a',
      'src/main.ts': "console.log('res://textures/missing.png')",
    });
    const scan = await scanProject({ root, resRoot: 'src/assets', manifest: manifest() });
    expect(scan.scenePaths).toEqual(['scenes/main.pix3scene']);
    expect(scan.assetPaths).toEqual(['scenes/main.pix3scene', 'textures/a.png']);
    expect(scan.warnings).toEqual(['Referenced resource not found: res://textures/missing.png']);
  });

  it('adds fonts, declared locale tables with their sprites, atlas pages and the packed atlas', async () => {
    const root = project({
      'pix3project.yaml': '',
      'scenes/main.pix3scene':
        'root:\n  - id: s\n    type: SpineSkeleton2D\n    properties:\n      atlasPath: res://spine/hero.atlas\n  - id: fx\n    type: PostProcess\n',
      'spine/hero.atlas': '\nhero.png\nsize: 1024,1024\n\nregion\n  bounds: 1,2,3,4\n',
      'spine/hero.png': 'p',
      'fonts/nunito.woff2': 'f',
      'locales/en.json': '{"strings":{},"sprites":{"logo":"res://sprites/logo-en.png"}}',
      'locales/ru.json': '{"strings":{},"sprites":{"logo":"res://sprites/logo-ru.png"}}',
      'locales/de.json': '{"strings":{}}',
      'sprites/logo-en.png': 'e',
      'sprites/logo-ru.png': 'r',
      'assets/.atlas/atlas-manifest.json':
        '{"formatVersion":1,"sheets":[{"id":"s0","file":"s0.png"}]}',
      'assets/.atlas/s0.png': 's',
    });
    const scan = await scanProject({
      root,
      resRoot: '.',
      manifest: manifest(
        'fonts:\n  - family: Nunito\n    path: fonts/nunito.woff2\nlocalization:\n  defaultLocale: en\n  locales: [en, ru]\n'
      ),
    });
    expect(scan.usesSpine).toBe(true);
    expect(scan.usesPostProcessing).toBe(true);
    expect(scan.assetPaths).toContain('fonts/nunito.woff2');
    expect(scan.assetPaths).toContain('spine/hero.png');
    expect(scan.assetPaths).toContain('locales/en.json');
    expect(scan.assetPaths).toContain('locales/ru.json');
    expect(scan.assetPaths).not.toContain('locales/de.json');
    expect(scan.assetPaths).toContain('sprites/logo-ru.png');
    expect(scan.assetPaths).toContain('assets/.atlas/atlas-manifest.json');
    expect(scan.assetPaths).toContain('assets/.atlas/s0.png');
    expect(scan.localization).toEqual({ defaultLocale: 'en', locales: ['en', 'ru'] });
  });

  it('discovers locales/ when the manifest has no block, en first', async () => {
    const root = project({
      'scenes/main.pix3scene': 'root: []\n',
      'locales/ru.json': '{}',
      'locales/en.json': '{}',
    });
    const scan = await scanProject({ root, resRoot: '.', manifest: manifest() });
    expect(scan.localization).toEqual({ defaultLocale: 'en', locales: ['en', 'ru'] });
    expect(scan.assetPaths).toContain('locales/ru.json');
  });

  it('resolves the entry scene: option, then the manifest, then scenes/main, then the first', async () => {
    const files = {
      'scenes/b.pix3scene': 'root: []\n',
      'scenes/a.pix3scene': 'root: []\n',
      'scenes/ui/end.pix3scene': 'root: []\n',
      'prefabs/x.pix3scene': 'root: []\n',
    };
    let scan = await scanProject({ root: project(files), resRoot: '.', manifest: manifest() });
    expect(scan.scenePaths).toEqual(['scenes/a.pix3scene', 'scenes/b.pix3scene']);
    expect(scan.entryScenePath).toBe('scenes/a.pix3scene');

    scan = await scanProject({
      root: project(files),
      resRoot: '.',
      manifest: manifest('defaultExportScenePath: res://scenes/b.pix3scene\n'),
    });
    expect(scan.entryScenePath).toBe('scenes/b.pix3scene');

    scan = await scanProject({
      root: project(files),
      resRoot: '.',
      manifest: manifest('defaultExportScenePath: scenes/gone.pix3scene\n'),
      entryScene: 'res://scenes/a.pix3scene',
    });
    expect(scan.entryScenePath).toBe('scenes/a.pix3scene');

    scan = await scanProject({
      root: project({ ...files, 'scenes/main.pix3scene': 'root: []\n' }),
      resRoot: '.',
      manifest: manifest('defaultExportScenePath: scenes/gone.pix3scene\n'),
      entryScene: 'scenes/nope.pix3scene',
    });
    expect(scan.entryScenePath).toBe('scenes/main.pix3scene');
    expect(scan.warnings).toEqual([
      'Requested entry scene is not a project scene: scenes/nope.pix3scene',
      'defaultExportScenePath is not a project scene: scenes/gone.pix3scene',
    ]);
  });

  it('classifies prefabs by folder and extension', () => {
    expect(isPrefabPath('prefabs/coin.pix3scene')).toBe(true);
    expect(isPrefabPath('scenes/ui/result.pix3scene')).toBe(true);
    expect(isPrefabPath('things/enemy.prefab')).toBe(true);
    expect(isPrefabPath('scenes/main.pix3scene')).toBe(false);
  });
});

describe('parseProjectManifest', () => {
  it('normalises like the editor: defaults, clamps, platform quality, fonts, locales', () => {
    const info = parseProjectManifest(
      [
        'defaultExportScenePath: res://scenes/menu.pix3scene',
        'viewportBaseSize: { width: 10, height: 1920.4 }',
        'targetPlatform: mobile',
        'quality: { maxPixelRatio: 9 }',
        'fonts:',
        '  - { family: A, path: res://fonts/a.woff2 }',
        '  - { family: A, path: fonts/a.woff2 }',
        '  - { family: "", path: x }',
        'localization: { locales: [ru, en] }',
        'metadata: { projectName: "  Game  " }',
      ].join('\n'),
      'dir-name'
    );
    expect(info.projectName).toBe('Game');
    expect(info.defaultScenePath).toBe('scenes/menu.pix3scene');
    expect(info.viewportBaseSize).toEqual({ width: 64, height: 1920 });
    expect(info.quality).toEqual({ antialias: false, shadows: false, maxPixelRatio: 4 });
    expect(info.fonts).toEqual([
      { family: 'A', path: 'fonts/a.woff2', weight: 400, style: 'normal' },
    ]);
    expect(info.localization).toEqual({ defaultLocale: 'ru', locales: ['ru', 'en'] });
    expect(parseProjectManifest('', 'dir-name')).toMatchObject({
      projectName: 'dir-name',
      defaultScenePath: null,
      viewportBaseSize: { width: 1920, height: 1080 },
      quality: { antialias: true, shadows: true, maxPixelRatio: 2 },
      fonts: [],
      localization: null,
    });
    expect(parseProjectManifest(':::bad', 'x').projectName).toBe('x');
  });
});

describe('decideStrip (plan §B.6 item 2, P1 rule)', () => {
  const withDeps = (deps: Record<string, Record<string, unknown>>): string =>
    project({
      'package.json': JSON.stringify({
        dependencies: Object.fromEntries(Object.keys(deps).map(name => [name, '*'])),
        devDependencies: { '@pix3/vite-plugin': '*' },
      }),
      ...Object.fromEntries(
        Object.entries(deps).map(([name, pkg]) => [
          `node_modules/${name}/package.json`,
          JSON.stringify({ name, ...pkg }),
        ])
      ),
      'node_modules/@pix3/vite-plugin/package.json': JSON.stringify({
        name: '@pix3/vite-plugin',
        peerDependencies: { '@pix3/runtime': '*' },
      }),
    });

  it('is on when no dependency depends on the runtime (own packages do not count)', () => {
    const root = withDeps({ three: {}, lit: { dependencies: { 'lit-html': '*' } } });
    expect(runtimeDependents(root)).toEqual([]);
    expect(decideStrip(root, undefined)).toEqual({ enabled: true, reason: null });
  });

  it('is off when a dependency declares @pix3/runtime in deps or peerDeps', () => {
    const root = withDeps({
      'game-kit': { peerDependencies: { '@pix3/runtime': '*' } },
      'ui-pack': { dependencies: { '@pix3/runtime': '*' } },
      three: {},
    });
    expect(runtimeDependents(root)).toEqual(['game-kit', 'ui-pack']);
    const decision = decideStrip(root, undefined);
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('game-kit, ui-pack');
    expect(decideStrip(root, true)).toEqual({
      enabled: true,
      reason: 'forced by pix3({ strip: true })',
    });
  });

  it('strip: false wins', () => {
    const root = withDeps({});
    expect(decideStrip(root, false)).toEqual({ enabled: false, reason: 'pix3({ strip: false })' });
  });
});

describe('toClassicScriptHtml', () => {
  it('moves the inlined module script to the end of body as a classic script', () => {
    const out = toClassicScriptHtml(
      '<!doctype html><html><head><meta charset="utf-8"><script type="module" crossorigin>const u = import.meta.url; const r = import.meta.resolve ? 1 : 2; const h = import.meta.hot;</script><title>t</title></head><body><div id="app"></div></body></html>'
    );
    expect(out).toBe(
      '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id="app"></div><script>const u = document.baseURI; const r = undefined ? 1 : 2; const h = ({}).hot;</script>\n</body></html>'
    );
  });

  it('leaves a page without a head script alone', () => {
    const html = '<html><head></head><body><script src="a.js"></script></body></html>';
    expect(toClassicScriptHtml(html)).toBe(html);
  });
});
