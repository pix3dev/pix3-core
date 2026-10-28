import {
  isProjectScriptEntry,
  PROJECT_SCRIPT_DIRECTORIES,
  PROJECT_SCRIPT_EXCLUDE_PATTERN,
} from '@pix3/runtime';
import { describe, expect, it } from 'vitest';

import {
  BOT_POLICY_DIRECTORIES,
  isScriptEntry,
  NOT_A_SCRIPT_ENTRY,
  scanExportNames,
  SCRIPT_DIRECTORIES,
  stripComments,
} from './script-rule.ts';

/**
 * ONE project-script rule (`packages/runtime/src/core/project-script-registration.ts`): `pix3
 * tree` and `pix3 check` run as plain Node and cannot import the runtime's TypeScript, so their
 * copy is held to the runtime's here (the plugin's is, by its own `script-rule.spec.ts`).
 */
describe('the project-script rule of the Node-runnable commands', () => {
  it('names the runtime folders and exclusions', () => {
    expect([...SCRIPT_DIRECTORIES]).toEqual([...PROJECT_SCRIPT_DIRECTORIES]);
    expect(NOT_A_SCRIPT_ENTRY.source).toBe(PROJECT_SCRIPT_EXCLUDE_PATTERN.source);
  });

  it('isScriptEntry agrees with isProjectScriptEntry on every kind of path', () => {
    const dirs = [...SCRIPT_DIRECTORIES, ...BOT_POLICY_DIRECTORIES];
    for (const path of [
      'scripts/Mover.ts',
      'scripts/deep/Mover.ts',
      'src/scripts/Hud.ts',
      'design/tests/bots/idle.ts',
      'scripts/Mover.js',
      'scripts/Mover.spec.ts',
      'scripts/Mover.test.ts',
      'scripts/types.d.ts',
      'src/game/fields.ts',
      'scriptsx/A.ts',
    ]) {
      expect(isScriptEntry(path), path).toBe(isProjectScriptEntry(path));
      expect(isScriptEntry(path, dirs), path).toBe(isProjectScriptEntry(path, dirs));
    }
  });
});

describe('scanExportNames reads exports through comments and strings (core-tests/game12)', () => {
  it('a `/*` inside a line comment does not open a block comment', () => {
    const source = [
      '// Shows the cards of scenes/ui/* and hides them again',
      'export class ResultCards extends Script {}',
      '/* export class Commented {} */',
      "const url = 'https://example.com/*not-a-comment';",
      'export class AfterString {}',
    ].join('\n');
    expect(scanExportNames(source).names).toEqual(['ResultCards', 'AfterString']);
  });

  it('keeps line breaks of a block comment and the text of strings', () => {
    expect(stripComments('a /* x\ny */ b // c\n"// d"')).toBe('a     \n     b \n"// d"');
  });
});
