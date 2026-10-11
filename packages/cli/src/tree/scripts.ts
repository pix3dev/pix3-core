import { isScriptEntry, scanExportNames } from '../script-rule.ts';
import type { ProjectFiles } from '../validate/project.ts';

/**
 * The `user:` component ids a project declares, read from the text of its script entries — for
 * the `pix3 tree` overview, which must not load the runtime. The same view as `pix3 validate`'s
 * level 1 (`script-rule.ts`: the entry rule and the export names), so the two agree on which ids
 * exist; level 2 of `pix3 validate` is the authority on what registers.
 */
export const scanUserScriptIds = (project: ProjectFiles): string[] => {
  const ids = new Set<string>();
  for (const file of project.files) {
    if (!isScriptEntry(file)) continue;
    let source: string;
    try {
      source = project.readText(file);
    } catch {
      continue;
    }
    for (const name of scanExportNames(source).names) ids.add(`user:${name}`);
  }
  return [...ids].sort();
};
