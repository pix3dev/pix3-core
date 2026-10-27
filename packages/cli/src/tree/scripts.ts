import { isScriptEntry, scanExportNames } from '../script-rule.ts';
import type { ProjectFiles } from '../validate/project.ts';

/** `name` is declared in `source` as something that is not a class with a base class. */
const cannotBeComponent = (source: string, name: string): boolean => {
  const id = name.replace(/[$]/g, '\\$');
  return (
    new RegExp(`\\bclass\\s+${id}\\s*(<[^>]*>\\s*)?(implements\\b[^{]*)?\\{`).test(source) ||
    new RegExp(`\\b(function\\*?|const|let|var|interface|type|enum)\\s+${id}\\b`).test(source)
  );
};

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
    // Leave out the exports that cannot be a component: a class with no `extends` (a model, a
    // helper — `user:BoardModel` used to be listed), a function, a constant, a type. A class on an
    // intermediate base or an aliased export stays: level 2 of `pix3 validate` decides those.
    for (const name of scanExportNames(source).names) {
      if (!cannotBeComponent(source, name)) ids.add(`user:${name}`);
    }
  }
  return [...ids].sort();
};
