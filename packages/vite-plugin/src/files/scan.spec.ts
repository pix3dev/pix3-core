// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isExcludedPath, isNonShippableDirectoryName } from './scan.ts';

/** What the editor follows and the build reads: never a hidden directory (core-tests/game15). */
describe('the project file set', () => {
  it('leaves out hidden directories at any depth — an agent scratch, the kit, CI', () => {
    for (const path of [
      '.scratch/shots/menu.png',
      '.claude/skills/pix3-nodes/SKILL.md',
      '.github/workflows/ci.yml',
      'design/.notes/a.md',
      '.pix3/dev.json',
      'dist/index.html',
      'node_modules/three/package.json',
    ]) {
      expect(isExcludedPath(path), path).toBe(true);
    }
  });

  it('keeps the project: scenes, scripts, assets, and dotfiles that are files', () => {
    for (const path of [
      'scenes/main.pix3scene',
      'scripts/Board.ts',
      'sprites/gem.svg',
      '.gitignore',
      'design/tests/bots/round.ts',
    ]) {
      expect(isExcludedPath(path), path).toBe(false);
    }
    expect(isNonShippableDirectoryName('.scratch')).toBe(true);
    expect(isNonShippableDirectoryName('scenes')).toBe(false);
  });
});
