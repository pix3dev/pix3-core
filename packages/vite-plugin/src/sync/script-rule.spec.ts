// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { projectScriptsSource } from '../build/player-modules.ts';
import {
  BOT_POLICY_DIRS,
  EDITOR_SCRIPTS_ID,
  globPatterns,
  isGlobbedScript,
  rootModuleSource,
  SCRIPT_DIRS,
} from './script-graph.ts';

/** The runtime's rule, loaded by path: the plugin's own tsconfig (nodenext) must not follow it. */
interface ProjectScriptRule {
  readonly PROJECT_SCRIPT_DIRECTORIES: readonly string[];
  projectScriptGlobPatterns(dirs?: readonly string[]): string[];
  isProjectScriptEntry(path: string, dirs?: readonly string[]): boolean;
}
const RUNTIME_RULE = fileURLToPath(
  new URL('../../../runtime/src/core/project-script-registration.ts', import.meta.url)
);
const { PROJECT_SCRIPT_DIRECTORIES, projectScriptGlobPatterns, isProjectScriptEntry } =
  (await import(RUNTIME_RULE)) as ProjectScriptRule;

/**
 * ONE project-script rule (`packages/runtime/src/core/project-script-registration.ts`): the
 * plugin cannot import the runtime's TypeScript at Node run time, so its mirror — the editor root,
 * the player root and `isGlobbedScript` — is held to the runtime's here.
 */
describe('the project-script rule', () => {
  it('the editor and player roots glob exactly what the runtime rule says', () => {
    expect([...SCRIPT_DIRS]).toEqual([...PROJECT_SCRIPT_DIRECTORIES]);
    expect(globPatterns(SCRIPT_DIRS)).toEqual(projectScriptGlobPatterns());
    expect(globPatterns(BOT_POLICY_DIRS)).toEqual(projectScriptGlobPatterns(BOT_POLICY_DIRS));
    const patterns = JSON.stringify(projectScriptGlobPatterns());
    expect(rootModuleSource(EDITOR_SCRIPTS_ID, 3)).toContain(patterns);
    expect(projectScriptsSource()).toContain(patterns);
  });

  it('isGlobbedScript agrees with isProjectScriptEntry on every kind of path', () => {
    const dirs = [...SCRIPT_DIRS, ...BOT_POLICY_DIRS];
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
      'design/tests/lib/aim.ts',
      'scripts',
      'scriptsx/A.ts',
    ]) {
      expect(isGlobbedScript(path), path).toBe(isProjectScriptEntry(path, dirs));
    }
    expect(isProjectScriptEntry('scripts/Mover.ts')).toBe(true);
    expect(isProjectScriptEntry('scripts/Mover.js')).toBe(false);
    expect(isProjectScriptEntry('res://scripts/Mover.ts')).toBe(true);
  });
});
