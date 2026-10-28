/**
 * The project-script rule for the commands that run as plain Node (`pix3 tree`, `pix3 check`): the
 * runtime's `core/project-script-registration.ts` (`PROJECT_SCRIPT_DIRECTORIES`,
 * `isProjectScriptEntry`) restated, because those commands cannot import the runtime's TypeScript
 * sources; `script-rule.spec.ts` pins it to the runtime's. A `.ts` under `scripts/` or
 * `src/scripts/` (recursively) is an entry — no `.js`, no specs, tests or declarations, no textual
 * gate — and its exports register as `user:<export name>`.
 */

/** Folders whose `.ts` files are script entries (the editor's and the player's glob root). */
export const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
/** Folders of the bot-policy root (`virtual:pix3/bot-policies`). */
export const BOT_POLICY_DIRECTORIES = ['design/tests/bots'] as const;
/** A `.ts` under a script folder that is not an entry: a spec, a test, a declaration. */
export const NOT_A_SCRIPT_ENTRY = /\.(?:spec|test)\.ts$|\.d\.ts$/;

/** True when the project-relative `path` is a script entry of `dirs`. */
export const isScriptEntry = (
  path: string,
  dirs: readonly string[] = SCRIPT_DIRECTORIES
): boolean =>
  path.endsWith('.ts') &&
  !NOT_A_SCRIPT_ENTRY.test(path) &&
  dirs.some(dir => path.startsWith(`${dir}/`));

/**
 * Drop comments so a commented-out `export class` does not count; strings are left alone. One pass
 * that knows which construct it is in: two regexes in a row (block comments, then line comments)
 * read the `/*` of `// scenes/ui/*` as a block comment and swallowed the code down to the next
 * `*\/`, so a class below it "did not exist" (`E_USER_SCRIPT_NOT_FOUND`, core-tests/game12).
 */
export const stripComments = (source: string): string => {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      // Keep the line breaks, so a line number read off the result still matches the file.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        else if (ch !== '`' && source[j] === '\n') break;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

const EXPORT_CLASS = /\bexport\s+(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)?/g;
const EXPORT_CONST_CLASS = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/g;
const EXPORT_LIST = /\bexport\s+(type\s+)?\{([^}]*)\}/g;
const EXPORT_STAR = /\bexport\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\b/;

/** Export names that the editor would consider for registration, as far as text can tell. */
export const scanExportNames = (source: string): { names: string[]; hasStar: boolean } => {
  const text = stripComments(source);
  const names: string[] = [];
  for (const match of text.matchAll(EXPORT_CLASS)) {
    names.push(match[1] ? 'default' : (match[2] ?? 'default'));
  }
  for (const match of text.matchAll(EXPORT_CONST_CLASS)) {
    names.push(match[1]);
  }
  for (const match of text.matchAll(EXPORT_LIST)) {
    if (match[1]) continue; // `export type { … }`
    for (const raw of match[2].split(',')) {
      const specifier = raw.trim();
      if (!specifier || specifier.startsWith('type ')) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
      names.push(alias ? alias[1] : specifier.split(/\s+/)[0]);
    }
  }
  return { names, hasStar: EXPORT_STAR.test(text) };
};
