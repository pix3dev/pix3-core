import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

export interface FixtureProjectOptions {
  readonly nodeModules?: boolean;
  /**
   * Local packages to put into the project's `node_modules` (N11 fixtures): `name → files`.
   * With any given, `node_modules` is a real directory of links to this checkout's entries plus
   * these packages, instead of one link to the checkout's `node_modules`.
   */
  readonly packages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const writeFixtureProject = (
  files: Readonly<Record<string, string | Buffer>> = FIXTURE_FILES,
  options: FixtureProjectOptions = {}
): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-build-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  const packages = options.packages ?? {};
  if (Object.keys(packages).length > 0) {
    const nodeModules = join(root, 'node_modules');
    mkdirSync(nodeModules);
    for (const entry of readdirSync(CHECKOUT_NODE_MODULES)) {
      if (entry === '.bin' || entry === '.package-lock.json') continue;
      symlinkSync(join(CHECKOUT_NODE_MODULES, entry), join(nodeModules, entry), 'dir');
    }
    for (const [name, packageFiles] of Object.entries(packages)) {
      for (const [path, content] of Object.entries(packageFiles)) {
        const absolute = join(nodeModules, ...name.split('/'), ...path.split('/'));
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
      }
    }
  } else if (options.nodeModules ?? true) {
    symlinkSync(CHECKOUT_NODE_MODULES, join(root, 'node_modules'), 'dir');
  }
  return root;
};

/** A library that declares the runtime and takes `GeometryMesh` from it by name (N11). */
export const NAMED_IMPORT_LIB: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: 'named-import-lib',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    peerDependencies: { '@pix3/runtime': '*' },
  }),
  'index.js':
    "import { GeometryMesh } from '@pix3/runtime';\nexport const makeBox = () => new GeometryMesh();\n",
};

/** The same library, importing the whole barrel: the build cannot see what it uses. */
export const NAMESPACE_IMPORT_LIB: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: 'namespace-import-lib',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    peerDependencies: { '@pix3/runtime': '*' },
  }),
  'index.js':
    "import * as pix3 from '@pix3/runtime';\nexport const makeBox = () => new pix3.GeometryMesh();\n",
};

/** A library that does NOT declare the runtime yet imports it (the transform safety net). */
export const UNDECLARED_IMPORT_LIB: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: 'undeclared-import-lib',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }),
  'index.js':
    "import { Slider2D } from '@pix3/runtime';\nexport const makeSlider = () => new Slider2D();\n",
};

/** A project script that uses a library's export (the scan sees `makeBox`, not `GeometryMesh`). */
export const usesLibScript = (lib: string, fn: string): string =>
  `import { Script } from '@pix3/runtime';\nimport { ${fn} } from '${lib}';\n\nexport class UsesLib extends Script {\n  onStart(): void {\n    void ${fn};\n  }\n}\n`;
