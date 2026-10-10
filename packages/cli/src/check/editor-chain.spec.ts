// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { lex, moduleFacts, scanEditorChain } from './editor-chain.ts';

const kinds = (source: string): string[] => moduleFacts(source).issues.map(i => i.kind);

describe('the lexer', () => {
  it('blanks comments, strings and template text but keeps substitutions as code', () => {
    const source = "const a = 'import.meta.hot'; // import(x)\nconst b = `x${import(y)}z`;\n";
    const { masked } = lex(source);
    expect(masked).not.toContain('import.meta.hot');
    expect(masked).not.toContain('import(x)');
    expect(masked).toContain('import(y)');
    expect(masked.split('\n')).toHaveLength(3);
  });

  it('does not take a division for a regex, nor a regex for code', () => {
    expect(kinds('const r = /import\\(x\\)/;\nconst d = a / b / c;\n')).toEqual([]);
  });
});

describe('contract B constructs in one module', () => {
  it('finds import.meta.hot, also through optional chaining', () => {
    expect(kinds('if (import.meta.hot) import.meta.hot.accept();\n')).toEqual([
      'import-meta-hot',
      'import-meta-hot',
    ]);
    expect(kinds('import.meta?.hot?.dispose(() => {});\n')).toEqual(['import-meta-hot']);
    expect(kinds('const env = import.meta.env; const g = import.meta.glob("./*.ts");\n')).toEqual(
      []
    );
  });

  it('finds a non-literal import() and lets a literal one through', () => {
    expect(
      kinds('await import(\'./a.ts\'); await import("./b.ts"); await import(`./c.ts`);\n')
    ).toEqual([]);
    expect(kinds('await import(name);\n')).toEqual(['dynamic-import']);
    expect(kinds('await import(`./levels/${n}.ts`);\n')).toEqual(['dynamic-import']);
    expect(kinds("await import('./a' + n);\n")).toEqual(['dynamic-import']);
    expect(kinds("await import('./a.json', { with: { type: 'json' } });\n")).toEqual([]);
    expect(kinds('loader.import(x); obj.import (y);\n')).toEqual([]);
  });

  it('finds stylesheet imports, static and literal-dynamic, but not ?inline/?raw/?url', () => {
    expect(
      kinds("import './hud.css';\nimport styles from './a.scss';\nawait import('./b.less');\n")
    ).toEqual(['css-import', 'css-import', 'css-import']);
    expect(
      kinds(
        "import text from './a.css?raw';\nimport url from './b.css?url';\nimport c from './c.css?inline';\n"
      )
    ).toEqual([]);
    expect(kinds("const file = 'theme.css';\n")).toEqual([]);
  });

  it('reports the line of each construct', () => {
    const facts = moduleFacts("// header\n\nimport './x.css';\n");
    expect(facts.issues).toEqual([{ kind: 'css-import', line: 3, text: "import './x.css';" }]);
  });
});

describe('the editor chain of a project', () => {
  const root = mkdtempSync(join(tmpdir(), 'pix3-chain-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  it('walks the script and bot roots and their local imports, not packages or specs', () => {
    write('scripts/Player.ts', "import { speed } from '../lib/tuning.js';\nimport 'three';\n");
    write('lib/tuning.ts', "export const speed = 1;\nimport('./x.ts');\nexport * from './deep';\n");
    write('lib/deep/index.ts', 'if (import.meta.hot) {}\n');
    write('scripts/Player.spec.ts', 'import.meta.hot;\n');
    write('design/tests/bots/dodge.ts', "import { aim } from '/design/tests/lib/aim.ts';\n");
    write('design/tests/lib/aim.ts', "import './aim.css';\nexport const aim = 1;\n");
    write('src/main.ts', 'import.meta.hot;\n'); // the game's entry is not in the editor chain

    const scan = scanEditorChain(root);
    expect(scan.files).toEqual([
      'scripts/Player.ts',
      'design/tests/bots/dodge.ts',
      'lib/tuning.ts',
      'design/tests/lib/aim.ts',
      'lib/deep/index.ts',
    ]);
    expect(scan.issues.map(i => [i.kind, i.file, i.line, i.via])).toEqual([
      ['css-import', 'design/tests/lib/aim.ts', 1, 'design/tests/bots/dodge.ts'],
      ['import-meta-hot', 'lib/deep/index.ts', 1, 'scripts/Player.ts'],
    ]);
  });
});
