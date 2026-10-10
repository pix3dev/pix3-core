// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseAst } from 'vite';

import {
  collectRuntimeImports,
  listPackageSources,
  lowerToJs,
  scanDependencyImports,
} from './dependency-imports.ts';

/**
 * N11: what the build reads out of a dependency's imports of `@pix3/runtime` — the named ones
 * keep modules, every other form is opaque. The walk runs on the bundler's own AST (`parseAst`
 * here, `this.parse` in the plugin), so the shapes are the ones rolldown/rollup produce.
 */

const walk = (code: string, file = 'lib/index.js') => collectRuntimeImports(parseAst(code), file);

describe('collectRuntimeImports', () => {
  it('collects named imports and re-exports, string-literal and aliased alike', () => {
    const found = walk(
      [
        "import { GeometryMesh, Sprite2D as Sprite } from '@pix3/runtime';",
        "import { 'core:Follow' as follow } from '@pix3/runtime';",
        "export { Label2D } from '@pix3/runtime';",
        "import { something } from 'elsewhere';",
      ].join('\n')
    );
    expect([...found.names].sort()).toEqual(['GeometryMesh', 'Label2D', 'Sprite2D', 'core:Follow']);
    expect(found.opaque).toEqual([]);
  });

  it('is opaque on a namespace import, a dynamic import, export * and require', () => {
    for (const [code, form] of [
      ["import * as pix3 from '@pix3/runtime';", "import * as pix3 from '@pix3/runtime'"],
      ["export * from '@pix3/runtime';", "export * from '@pix3/runtime'"],
      ["const rt = await import('@pix3/runtime');", "import('@pix3/runtime')"],
      ["const rt = require('@pix3/runtime');", "require('@pix3/runtime')"],
      ['const rt = import(`@pix3/runtime`);', "import('@pix3/runtime')"],
    ]) {
      const found = walk(code, 'game-kit/dist/index.js');
      expect(found.opaque).toEqual([`game-kit/dist/index.js: ${form}`]);
    }
  });

  it('ignores other modules, type-only imports and a default import', () => {
    const found = walk(
      [
        "import * as THREE from 'three';",
        "import('three');",
        "import d from '@pix3/runtime';",
        "export * from './local';",
        "const x = require('yaml');",
      ].join('\n')
    );
    expect(found.names.size).toBe(0);
    expect(found.opaque).toEqual([]);
  });

  it('finds imports nested in blocks and functions', () => {
    const found = walk(
      "export async function load() { if (Math.random()) { return import('@pix3/runtime'); } }"
    );
    expect(found.opaque).toHaveLength(1);
  });
});

describe('lowerToJs', () => {
  it('turns TypeScript into JS the parser accepts, keeping value imports and dropping types', async () => {
    const js = await lowerToJs(
      "import { GeometryMesh, type Node3D } from '@pix3/runtime';\nexport const make = (): GeometryMesh => new GeometryMesh();\n",
      '/lib/src/index.ts'
    );
    const found = collectRuntimeImports(parseAst(js), 'lib/src/index.ts');
    expect([...found.names]).toEqual(['GeometryMesh']);
  });
});

describe('scanDependencyImports / listPackageSources', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const packageRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'pix3-deps-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, ...path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    return root;
  };

  it('parses only the sources that mention the runtime, TS lowered, tests and nested packages skipped', async () => {
    const root = packageRoot({
      'package.json': '{}',
      'node_modules/game-kit/package.json': '{"name":"game-kit"}',
      'node_modules/game-kit/dist/index.js': "import { GeometryMesh } from '@pix3/runtime';",
      'node_modules/game-kit/dist/other.js': 'export const n = 1;',
      'node_modules/game-kit/src/index.ts':
        "import { Sprite2D, type Node2D } from '@pix3/runtime';\nexport const s = (): Node2D => new Sprite2D();",
      'node_modules/game-kit/src/index.spec.ts': "import * as pix3 from '@pix3/runtime';",
      'node_modules/game-kit/src/types.d.ts': "import * as pix3 from '@pix3/runtime';",
      'node_modules/game-kit/node_modules/inner/index.js': "import * as pix3 from '@pix3/runtime';",
      'node_modules/game-kit/test/x.js': "import * as pix3 from '@pix3/runtime';",
    });
    expect(
      listPackageSources(join(root, 'node_modules/game-kit')).map(file =>
        file.slice(root.length + '/node_modules/game-kit/'.length)
      )
    ).toEqual(['dist/index.js', 'dist/other.js', 'src/index.ts']);
    const scan = await scanDependencyImports({
      root,
      packages: ['game-kit', 'not-installed'],
      parse: parseAst,
    });
    expect([...scan.names].sort()).toEqual(['GeometryMesh', 'Sprite2D']);
    expect(scan.opaque).toEqual([]);
    expect(scan.parsed).toEqual({ 'game-kit': 2 });
  });

  it('reports a file that does not parse as opaque, naming it', async () => {
    const root = packageRoot({
      'node_modules/broken/package.json': '{"name":"broken"}',
      'node_modules/broken/index.js':
        "import { GeometryMesh } from '@pix3/runtime'; this is not js",
    });
    const scan = await scanDependencyImports({ root, packages: ['broken'], parse: parseAst });
    expect(scan.opaque).toHaveLength(1);
    expect(scan.opaque[0]).toMatch(/^broken\/index\.js: could not be parsed/);
  });
});
