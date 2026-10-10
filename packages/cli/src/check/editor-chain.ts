import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Contract B of the editor page (plan §B.2): the modules the editor executes — the project's
 * scripts (`scripts/`, `src/scripts/`), its bot policies (`design/tests/bots/`) and every local
 * module they import, transitively — must not make Vite inject `/@vite/client`. Three constructs
 * do (S1, finding 3):
 *
 * - `import.meta.hot` (Vite adds the HMR client to any module that mentions it);
 * - a CSS import (a stylesheet module in dev imports `updateStyle` from the client);
 * - a non-literal `import(expr)` (Vite wraps the specifier in `__vite__injectQuery` from the
 *   client). `import('./chunk.ts')` with a plain string is safe.
 *
 * With the client on the page, the game's own dead-end HMR chain (`full-reload`) and the
 * client's reload-after-reconnect reach the editor and reload it, losing what the designer has
 * not saved. `pix3 check` warns; the page reports the client when it finds it loaded.
 *
 * The scan is lexical (comments and string contents are masked, template substitutions are
 * code): no TypeScript or parser is loaded, the same file set as the plugin's globs is walked,
 * and relative / root-absolute specifiers are followed. Bare packages are not scanned.
 */

/** Same roots as the plugin's `virtual:pix3/editor-scripts` and `virtual:pix3/bot-policies`. */
export const EDITOR_CHAIN_DIRS = ['scripts', 'src/scripts', 'design/tests/bots'] as const;

export type EditorChainIssueKind = 'import-meta-hot' | 'css-import' | 'dynamic-import';

export interface EditorChainIssue {
  readonly kind: EditorChainIssueKind;
  /** Project-relative, forward slashes. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** The offending text, trimmed to one line. */
  readonly text: string;
  /** The root that reaches `file` (itself for a root). */
  readonly via: string;
}

export interface EditorChainScan {
  /** Every module scanned (roots first, then what they import), project-relative. */
  readonly files: readonly string[];
  readonly issues: readonly EditorChainIssue[];
}

const NOT_A_ROOT = /\.(?:spec|test)\.ts$|\.d\.ts$/;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', '.pix3']);
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];
const STYLE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:\?(.*))?$/;
/** Queries that turn a stylesheet into a string or URL: no style module, no client. */
const STYLE_AS_DATA = /(?:^|&)(?:raw|url|inline)(?:&|=|$)/;

interface StringLiteral {
  /** Offset of the opening quote. */
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /** A template literal with `${}` in it. */
  readonly substituted: boolean;
}

interface Lexed {
  /** The source with comments and string/template text blanked (newlines kept). */
  readonly masked: string;
  readonly strings: Map<number, StringLiteral>;
}

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD =
  /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** Blank comments and literal text so the patterns below only ever match code. */
export const lex = (source: string): Lexed => {
  const out = source.split('');
  const strings = new Map<number, StringLiteral>();
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  /** Brace depth of each open `${` (a template resumes when its depth closes). */
  const templateStack: number[] = [];
  /** Start offset of the template each open `${` belongs to. */
  const templateStarts: number[] = [];
  let depth = 0;
  let i = 0;
  const lastCode = (): string => {
    for (let k = i - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k];
    return '';
  };

  const readTemplate = (start: number, bodyFrom: number): void => {
    // From `bodyFrom` (after ` or }) to the closing ` or the next `${`.
    let k = bodyFrom;
    let text = '';
    while (k < source.length) {
      const ch = source[k];
      if (ch === '\\') {
        text += source.slice(k, k + 2);
        k += 2;
        continue;
      }
      if (ch === '`') {
        blank(bodyFrom, k);
        const prior = strings.get(start);
        strings.set(start, {
          start,
          end: k + 1,
          value: (prior?.value ?? '') + text,
          substituted: prior?.substituted ?? false,
        });
        i = k + 1;
        return;
      }
      if (ch === '$' && source[k + 1] === '{') {
        blank(bodyFrom, k);
        const prior = strings.get(start);
        strings.set(start, {
          start,
          end: k,
          value: (prior?.value ?? '') + text,
          substituted: true,
        });
        templateStack.push(depth);
        depth += 1;
        templateStarts.push(start);
        i = k + 2;
        return;
      }
      text += ch;
      k += 1;
    }
    blank(bodyFrom, k);
    i = k;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let k = i + 1;
      let value = '';
      while (k < source.length && source[k] !== ch && source[k] !== '\n') {
        if (source[k] === '\\') {
          value += source.slice(k, k + 2);
          k += 2;
          continue;
        }
        value += source[k];
        k += 1;
      }
      strings.set(i, { start: i, end: k + 1, value, substituted: false });
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    if (ch === '`') {
      readTemplate(i, i + 1);
      continue;
    }
    if (ch === '/') {
      const prev = lastCode();
      const before = out
        .slice(Math.max(0, i - 12), i)
        .join('')
        .trimEnd();
      if (prev === '' || REGEX_AFTER.has(prev) || REGEX_AFTER_WORD.test(before)) {
        let k = i + 1;
        let inClass = false;
        while (k < source.length && source[k] !== '\n') {
          const c = source[k];
          if (c === '\\') {
            k += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          k += 1;
        }
        blank(i + 1, k);
        i = k + 1;
        continue;
      }
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop();
        const start = templateStarts.pop() as number;
        readTemplate(start, i + 1);
        continue;
      }
    }
    i += 1;
  }
  return { masked: out.join(''), strings };
};

const lineOf = (source: string, offset: number): number => {
  let line = 1;
  for (let k = 0; k < offset && k < source.length; k++) if (source[k] === '\n') line += 1;
  return line;
};

const lineText = (source: string, offset: number): string => {
  const from = source.lastIndexOf('\n', offset - 1) + 1;
  const to = source.indexOf('\n', offset);
  const text = source.slice(from, to === -1 ? source.length : to).trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g;
const IMPORT_META_HOT = /(?<![\w$.])import\s*\.\s*meta\s*(?:\?\s*)?\.\s*hot(?![\w$])/g;
/** What precedes a module specifier: `from`, a bare `import`, or `import(`. */
const SPECIFIER_LEAD = /(?:(?<![\w$.])from|(?<![\w$.])import|(?<![\w$.])import\s*\()\s*$/;

export interface ModuleFacts {
  readonly specifiers: readonly { readonly value: string; readonly offset: number }[];
  readonly issues: readonly Omit<EditorChainIssue, 'file' | 'via'>[];
}

/** The specifiers one module imports and the contract-B constructs it contains. */
export const moduleFacts = (source: string): ModuleFacts => {
  const { masked, strings } = lex(source);
  const issues: Omit<EditorChainIssue, 'file' | 'via'>[] = [];
  const specifiers: { value: string; offset: number }[] = [];

  for (const match of masked.matchAll(IMPORT_META_HOT)) {
    const offset = match.index ?? 0;
    issues.push({
      kind: 'import-meta-hot',
      line: lineOf(source, offset),
      text: lineText(source, offset),
    });
  }
  for (const match of masked.matchAll(DYNAMIC_IMPORT)) {
    const offset = match.index ?? 0;
    let k = offset + match[0].length;
    while (k < masked.length && /\s/.test(masked[k])) k += 1;
    const literal = strings.get(k);
    if (literal && !literal.substituted) {
      // `import('./a' + n)` is an expression that starts with a literal: still non-literal.
      let after = literal.end;
      while (after < masked.length && /\s/.test(masked[after])) after += 1;
      if (masked[after] === ')' || masked[after] === ',') continue;
    }
    issues.push({
      kind: 'dynamic-import',
      line: lineOf(source, offset),
      text: lineText(source, offset),
    });
  }
  for (const literal of strings.values()) {
    if (literal.substituted) continue;
    if (!SPECIFIER_LEAD.test(masked.slice(Math.max(0, literal.start - 40), literal.start)))
      continue;
    specifiers.push({ value: literal.value, offset: literal.start });
    const style = STYLE.exec(literal.value);
    if (style && !STYLE_AS_DATA.test(style[1] ?? '')) {
      issues.push({
        kind: 'css-import',
        line: lineOf(source, literal.start),
        text: lineText(source, literal.start),
      });
    }
  }
  issues.sort((a, b) => a.line - b.line);
  return { specifiers, issues };
};

const toWire = (projectRoot: string, absolute: string): string | null => {
  const rel = relative(projectRoot, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const wire = rel.split(sep).join('/');
  return wire.split('/').some(part => SKIPPED_DIRS.has(part)) ? null : wire;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A relative or root-absolute specifier → the local file Vite would load, or null. */
export const resolveLocal = (
  projectRoot: string,
  importer: string,
  specifier: string
): string | null => {
  const clean = specifier.split('?')[0];
  let base: string;
  if (clean.startsWith('./') || clean.startsWith('../')) base = resolve(dirname(importer), clean);
  else if (clean.startsWith('/') && !clean.startsWith('//')) base = join(projectRoot, clean);
  else return null;
  if (isFile(base)) return base;
  // TypeScript's `./x.js` for `./x.ts`.
  const swapped = base.replace(/\.(?:js|mjs|jsx)$/, ext =>
    ext === '.mjs' ? '.mts' : ext === '.jsx' ? '.tsx' : '.ts'
  );
  if (swapped !== base && isFile(swapped)) return swapped;
  for (const ext of RESOLVE_EXTENSIONS) if (isFile(`${base}${ext}`)) return `${base}${ext}`;
  for (const ext of RESOLVE_EXTENSIONS) {
    const index = join(base, `index${ext}`);
    if (isFile(index)) return index;
  }
  return null;
};

const listRoots = (projectRoot: string): string[] => {
  const roots: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.ts') && !NOT_A_ROOT.test(entry.name)) {
        roots.push(join(dir, entry.name));
      }
    }
  };
  for (const dir of EDITOR_CHAIN_DIRS) {
    const absolute = join(projectRoot, ...dir.split('/'));
    if (existsSync(absolute)) walk(absolute);
  }
  return roots;
};

/** Walk the editor chain of a project and report every contract-B construct in it. */
export const scanEditorChain = (projectRoot: string): EditorChainScan => {
  const files: string[] = [];
  const issues: EditorChainIssue[] = [];
  const seen = new Set<string>();
  const queue: { absolute: string; via: string }[] = [];
  for (const absolute of listRoots(projectRoot)) {
    const wire = toWire(projectRoot, absolute);
    if (wire !== null) queue.push({ absolute, via: wire });
  }
  while (queue.length > 0) {
    const { absolute, via } = queue.shift() as { absolute: string; via: string };
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const wire = toWire(projectRoot, absolute);
    if (wire === null) continue;
    let source: string;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    files.push(wire);
    const facts = moduleFacts(source);
    for (const issue of facts.issues) issues.push({ ...issue, file: wire, via });
    for (const { value } of facts.specifiers) {
      const target = resolveLocal(projectRoot, absolute, value);
      if (target && !seen.has(target) && !STYLE.test(target)) queue.push({ absolute: target, via });
    }
  }
  return { files, issues };
};
