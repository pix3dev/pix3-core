// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { findProjectRoot } from './manifest.ts';
import { CLI_VERSION } from './version.ts';
import { createProject, packageNameOf, type PostCreateStep } from './new-project.ts';
import {
  listTemplates,
  oneLine,
  resolveTemplate,
  resolveTemplatesRoot,
  type TemplateInfo,
} from './templates.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-new-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const walk = (dir: string, base: string = dir): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });

describe('templates', () => {
  it('reads the repo templates in a checkout: the 2d and 3d starters, not the base layer', () => {
    expect(resolveTemplatesRoot()).toMatch(/create-pix3[\\/]templates$/);
    expect(listTemplates().map(t => t.id)).toEqual(['2d', '3d']);
    for (const template of listTemplates()) {
      expect(template.layerDirs).toEqual([join(resolveTemplatesRoot(), 'base', 'files')]);
      expect(template.entryScenePath).toBe('scenes/main.pix3scene');
    }
  });

  it('resolves an id case-insensitively and refuses an unknown one, naming the starters', () => {
    const templates = listTemplates();
    const resolved = resolveTemplate('3D', templates);
    expect('template' in resolved && resolved.template.id).toBe('3d');
    const unknown = resolveTemplate('tapper', templates);
    expect('error' in unknown && unknown.error).toContain('2d, 3d');
  });

  it('cuts a description to its first sentence', () => {
    expect(oneLine('One thing. Then another.')).toBe('One thing.');
    expect(oneLine('No full stop')).toBe('No full stop');
  });

  it('a template extending a missing layer is not listed', () => {
    const dir = join(root, 'templates');
    mkdirSync(join(dir, 'x', 'files'), { recursive: true });
    writeFileSync(join(dir, 'x', 'template.yaml'), 'id: x\nextends: nope\n');
    expect(listTemplates(dir)).toEqual([]);
  });
});

/** Every project-relative file `createProject` should have copied from a template's layers. */
const expectedFiles = (template: TemplateInfo): string[] =>
  [...template.layerDirs, template.filesDir]
    .flatMap(dir => walk(dir))
    .map(file => (file === 'gitignore' ? '.gitignore' : file));

describe('pix3 new', () => {
  for (const [id, projectType, nodeTypes] of [
    ['2d', '2d', ['Group2D', 'ColorRect2D']],
    ['3d', '3d', ['Node3D', 'Camera3D', 'DirectionalLightNode', 'AmbientLightNode']],
  ] as const) {
    it(`${id}: base + layer, a Vite project with one empty entry scene`, () => {
      const template = listTemplates().find(t => t.id === id);
      if (!template) throw new Error(`${id} missing`);
      const dir = join(root, 'my-game');
      const project = createProject({ template, dir, projectName: 'My Game!' });

      for (const file of expectedFiles(template)) {
        expect(statSync(join(dir, file)).isFile()).toBe(true);
      }
      expect(walk(dir).sort()).toEqual(
        [
          '.gitignore',
          '.pix3/template.json',
          'README.md',
          'index.html',
          'package.json',
          'pix3project.yaml',
          'scenes/main.pix3scene',
          'src/main.ts',
          'tsconfig.json',
          'vite.config.ts',
        ].sort()
      );
      for (const sub of ['design', 'scenes', 'sprites', 'scripts', 'audio']) {
        expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
      }

      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.name).toBe('my-game');
      expect(pkg.scripts).toEqual({
        dev: 'vite',
        editor: 'pix3 editor',
        build: 'vite build',
        preview: 'vite preview',
        check: 'pix3 check',
        smoke: 'pix3 smoke',
      });
      expect(pkg.dependencies).toMatchObject({
        '@pix3/runtime': CLI_VERSION,
        three: expect.stringMatching(/^~0\.183\./),
        postprocessing: expect.any(String),
        lit: expect.any(String),
      });
      expect(pkg.devDependencies).toMatchObject({
        vite: expect.stringMatching(/^\^8/),
        '@pix3/vite-plugin': CLI_VERSION,
        '@pix3/editor-core': CLI_VERSION,
        '@pix3/cli': CLI_VERSION,
        typescript: expect.any(String),
      });
      expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('plugins: [pix3()]');
      expect(readFileSync(join(dir, 'src/main.ts'), 'utf8')).toContain(
        "import { startGame } from '@pix3/vite-plugin/player';"
      );
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('<title>My Game!</title>');
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\.pix3\/$/m);
      // pix3 agent-setup writes the CDP token into these.
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\.mcp\.json$/m);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\.codex\/config\.toml$/m);
      for (const file of walk(dir)) {
        if (/\.(json|ts|html|md|yaml|pix3scene)$/.test(file)) {
          expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/\{\{[A-Z_]+\}\}/);
        }
      }

      const manifest = parse(readFileSync(join(dir, 'pix3project.yaml'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(manifest).toMatchObject({
        version: '1.0.0',
        defaultExportScenePath: 'scenes/main.pix3scene',
        viewportBaseSize: { width: 1920, height: 1080 },
        projectType,
        targetPlatform: 'universal',
        metadata: { projectName: 'My Game!', templateId: id },
        autoloads: [],
      });
      expect((manifest.metadata as Record<string, unknown>).projectId).toBe(project.projectId);
      expect(project.projectId).toMatch(/^[0-9a-f-]{36}$/);

      const scene = parse(readFileSync(join(dir, 'scenes/main.pix3scene'), 'utf8')) as {
        root: { type: string; components?: unknown[]; children?: { type: string }[] }[];
      };
      const types = scene.root.flatMap(node => [
        node.type,
        ...(node.children ?? []).map(child => child.type),
      ]);
      expect(types).toEqual(nodeTypes);
      // Nothing that plays: no component anywhere.
      expect(readFileSync(join(dir, 'scenes/main.pix3scene'), 'utf8')).not.toContain('components:');

      const templateJson = JSON.parse(readFileSync(join(dir, '.pix3/template.json'), 'utf8')) as {
        templateId: string;
      };
      expect(templateJson.templateId).toBe(id);
    });
  }

  it('derives the npm package name from the project name', () => {
    expect(packageNameOf('My Game!')).toBe('my-game');
    expect(packageNameOf('  ')).toBe('pix3-game');
    expect(packageNameOf('Space_Tapper 2')).toBe('space_tapper-2');
  });

  it('mints a different id per project', () => {
    const template = listTemplates().find(t => t.id === '2d');
    if (!template) throw new Error('2d missing');
    const a = createProject({ template, dir: join(root, 'a') });
    const b = createProject({ template, dir: join(root, 'b') });
    expect(a.projectId).not.toBe(b.projectId);
  });

  it('refuses a folder that is not empty', () => {
    const template = listTemplates()[0];
    const dir = join(root, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x.txt'), 'x');
    expect(() => createProject({ template, dir })).toThrow(/not empty/);
  });

  it('runs post-create steps (the agent-kit extension point)', () => {
    const template = listTemplates()[0];
    const step: PostCreateStep = project => {
      writeFileSync(join(project.dir, 'AGENTS.md'), `# ${project.projectName}\n`);
      return ['AGENTS.md'];
    };
    const project = createProject({ template, dir: join(root, 'kit'), postCreateSteps: [step] });
    expect(project.files).toContain('AGENTS.md');
  });

  it('finds the project root from a subfolder', () => {
    const template = listTemplates()[0];
    const dir = join(root, 'nested');
    createProject({ template, dir });
    expect(findProjectRoot(join(dir, 'scenes'))).toBe(dir);
    expect(findProjectRoot(root)).toBeNull();
  });
});
