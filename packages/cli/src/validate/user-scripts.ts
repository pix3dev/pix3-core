import { isProjectScriptEntry, USER_SCRIPT_ID_PREFIX } from '@pix3/runtime';

import { scanExportNames } from '../script-rule.ts';
import type { ProjectFiles } from './project.ts';

/**
 * Level 1's view of the project's `user:*` components: which ids exist, found by reading the
 * scripts, never by running them.
 *
 * It mirrors `ProjectScriptLoaderService` (the shared rule is `core/project-script-registration.ts`
 * in the runtime): entry files are the `.ts` under `scripts/` or `src/scripts/` (no specs, tests or
 * declarations — what the plugin's glob root evaluates; no `.js`, no textual gate), and every
 * exported Script class registers as `user:<export name>`. From text we
 * can see the export names but not whether each is a Script class — an entry file's exported
 * helper function would be listed too. That errs towards "exists", which is the right side for a
 * check that must never produce a false error; level 2 compiles the files and knows for sure.
 */
export interface UserScriptIndex {
  /** `user:Name` → entry file that exports it. */
  readonly ids: ReadonlyMap<string, string>;
  /** Entry files. */
  readonly entries: readonly string[];
  /** Entry files with an `export * from …` — they may register ids this scan cannot see. */
  readonly opaqueEntries: readonly string[];
}

export const scanUserScripts = (project: ProjectFiles): UserScriptIndex => {
  const ids = new Map<string, string>();
  const entries: string[] = [];
  const opaqueEntries: string[] = [];
  for (const file of project.files) {
    if (!isProjectScriptEntry(file)) continue;
    let source: string;
    try {
      source = project.readText(file);
    } catch {
      continue;
    }
    entries.push(file);
    const { names, hasStar } = scanExportNames(source);
    if (hasStar) opaqueEntries.push(file);
    for (const name of names) {
      const id = `${USER_SCRIPT_ID_PREFIX}${name}`;
      if (!ids.has(id)) ids.set(id, file);
    }
  }
  return { ids, entries, opaqueEntries };
};
