import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The smallest project a build can be checked on (specs only; never a sample project — the
 * per-package fixture rule). A 2D scene with a colour rect, a sprite, a label and one project
 * script; `node_modules` links to this checkout's, so `@pix3/runtime`, `three` and `vite` resolve.
 */

/** 1×1 opaque PNG. */
export const DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);

export const FIXTURE_SCENE = `version: 1.0.0
root:
  - id: stage
    type: Group2D
    name: Stage
    properties:
      width: 640
      height: 360
    components:
      - id: spin
        type: user:Spin
        enabled: true
        config:
          speed: 90
    children:
      - id: backdrop
        type: ColorRect2D
        name: Backdrop
        properties:
          width: 640
          height: 360
          color: "#204060"
        children: []
      - id: dot
        type: Sprite2D
        name: Dot
        properties:
          texture: res://sprites/dot.png
          transform:
            position: [40, 20]
            scale: [8, 8]
            rotation: 0
        children: []
      - id: caption
        type: Label2D
        name: Caption
        properties:
          label: "fixture"
          labelFontSize: 32
          labelColor: "#ffffff"
        children: []
`;

export const FIXTURE_SCRIPT = `import { Script, type PropertySchema } from '@pix3/runtime';

export class Spin extends Script {
  config: { speed: number } = { speed: 90 };

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Spin',
      properties: [
        {
          name: 'speed',
          type: 'number',
          ui: { label: 'Speed' },
          getValue: (s: unknown) => (s as Spin).config.speed,
          setValue: (s: unknown, v: unknown) => {
            (s as Spin).config.speed = typeof v === 'number' ? v : 0;
          },
        },
      ],
    };
  }

  onUpdate(dt: number): void {
    const g = globalThis as { __pix3FixtureTicks?: number };
    g.__pix3FixtureTicks = (g.__pix3FixtureTicks ?? 0) + 1;
    const node = this.node as { rotation?: { z: number } } | null;
    if (node?.rotation) node.rotation.z += (dt * this.config.speed * Math.PI) / 180;
  }
}
`;

export const FIXTURE_MANIFEST = `version: 1.0.0
defaultExportScenePath: scenes/main.pix3scene
viewportBaseSize:
  width: 640
  height: 360
projectType: 2d
targetPlatform: universal
quality:
  antialias: false
  shadows: false
  maxPixelRatio: 1
metadata:
  projectName: Fixture Game
autoloads: []
`;

export const FIXTURE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture</title>
    <style>html,body,#app{margin:0;height:100%;background:#000}</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

export const FIXTURE_MAIN_TS = `import { startGame } from '@pix3/vite-plugin/player';

void startGame('#app');
`;

export const FIXTURE_FILES: Readonly<Record<string, string | Buffer>> = {
  'index.html': FIXTURE_INDEX_HTML,
  'src/main.ts': FIXTURE_MAIN_TS,
  'pix3project.yaml': FIXTURE_MANIFEST,
  'scenes/main.pix3scene': FIXTURE_SCENE,
  'scripts/Spin.ts': FIXTURE_SCRIPT,
  'sprites/dot.png': DOT_PNG,
  // An unreferenced file in a shipped directory: the html build must not embed it.
  'notes.md': '# not shipped\n',
};

/** This checkout's `node_modules` (the plugin sits in `packages/vite-plugin/src/build/`). */
export const CHECKOUT_NODE_MODULES = join(import.meta.dirname, '../../../../node_modules');

export const writeFixtureProject = (
  files: Readonly<Record<string, string | Buffer>> = FIXTURE_FILES,
  options: { readonly nodeModules?: boolean } = {}
): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-build-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (options.nodeModules ?? true) {
    symlinkSync(CHECKOUT_NODE_MODULES, join(root, 'node_modules'), 'dir');
  }
  return root;
};
