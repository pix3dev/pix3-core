import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

import { describeUnsynced, syncEditor } from '../editor-sync.ts';
import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import {
  CHECK_TSCONFIG,
  hasOwnTsconfig,
  installProjectTypes,
  projectTypesCurrent,
  ROOT_TSCONFIG,
} from '../types/project-types.ts';
import type { BundledDiagnostic, BundledValidateReport } from '../validate/entry.ts';
import { CLI_VERSION } from '../version.ts';
import { scanEditorChain, type EditorChainIssueKind } from './editor-chain.ts';
import {
  installedRuntimeVersion,
  lockstepMismatches,
  runtimeVersionMismatch,
} from '../version-gate.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { runTypecheck, type TypecheckResult } from './typecheck.ts';
import {
  resolveTypeScript,
  TypeScriptUnavailableError,
  type ResolvedTypeScript,
  type ResolveTypeScriptOptions,
} from './typescript.ts';

/**
 * `pix3 check [--json] [--no-hydrate] [--offline] [--no-sync] [--project <dir>]` (plan §5 A): everything
 * `pix3 validate` checks (both levels), plus a TypeScript type-check of the project's scripts and
 * whether the agent kit and the project's `@pix3/runtime` match this CLI.
 *
 * Diagnostics share one list with validate's: tsc errors become `E_TYPE`. Exit codes as validate:
 * 0 = no errors, 1 = at least one error, 2 = could not run (bad arguments, no project).
 *
 * Imports nothing heavy at load time: the validator bundle, TypeScript and the runtime types are
 * all reached lazily.
 */

/** Codes `check` adds to validate's (`src/validate/diagnostics.ts`). */
export const CHECK_CODES = {
  E_TYPE: { severity: 'error', summary: 'a TypeScript error in a project script' },
  E_DEPENDENCIES_MISSING: {
    severity: 'error',
    summary:
      'the project has its own tsconfig.json but no node_modules: run npm install (the type-check was skipped)',
  },
  E_TYPECHECK_UNAVAILABLE: {
    severity: 'error',
    summary: 'TypeScript could not be found or installed, so the scripts were not type-checked',
  },
  E_EDITOR_UNSYNCED: {
    severity: 'error',
    summary:
      'a running Pix3 editor did not flush its unsaved scenes in time, so the disk may be older than what the designer sees (--no-sync reads it anyway)',
  },
  E_RUNTIME_VERSION: {
    severity: 'error',
    summary:
      "the project's node_modules/@pix3/runtime is not the runtime this CLI validates with (run the project's own CLI, or install the matching runtime)",
  },
  W_PIX3_VERSION_MISMATCH: {
    severity: 'warning',
    summary:
      "an installed @pix3/cli, @pix3/vite-plugin or @pix3/editor-core is not this CLI's version (the packages are released in lockstep)",
  },
  W_RUNTIME_NOT_INSTALLED: {
    severity: 'warning',
    summary:
      'the project has its own tsconfig.json and node_modules, but no node_modules/@pix3/runtime',
  },
  W_KIT_OUTDATED: {
    severity: 'warning',
    summary: 'the agent kit in this project was written by another CLI version',
  },
  W_EDITOR_HMR_API: {
    severity: 'warning',
    summary:
      'import.meta.hot in a module the editor runs (a script, a bot policy or what they import): Vite puts its HMR client on the editor page, and a full-reload of the game reloads the editor',
  },
  W_EDITOR_CSS_IMPORT: {
    severity: 'warning',
    summary:
      'a stylesheet imported by a module the editor runs: Vite puts its HMR client on the editor page',
  },
  W_EDITOR_DYNAMIC_IMPORT: {
    severity: 'warning',
    summary:
      'a non-literal import() in a module the editor runs: Vite wraps it with a helper from its HMR client, which then loads on the editor page',
  },
} as const;

export type CheckCode = keyof typeof CHECK_CODES;

export type CheckDiagnostic = Omit<BundledDiagnostic, 'code'> & { readonly code: string };

/** Contract B (plan §B.2): what each construct is, and how to write it instead. */
const EDITOR_CHAIN_CODES: Record<
  EditorChainIssueKind,
  { readonly code: CheckCode; readonly what: string; readonly fix: string }
> = {
  'import-meta-hot': {
    code: 'W_EDITOR_HMR_API',
    what: '`import.meta.hot`',
    fix: 'remove it: the editor re-imports scripts on pix3_sync, a script needs no HMR code (put HMR handling in src/main.ts if the game wants it)',
  },
  'css-import': {
    code: 'W_EDITOR_CSS_IMPORT',
    what: 'a stylesheet import',
    fix: "import the stylesheet from the game's entry (src/main.ts), or as a string with `?inline`",
  },
  'dynamic-import': {
    code: 'W_EDITOR_DYNAMIC_IMPORT',
    what: 'a non-literal `import()`',
    fix: "use a plain string, import('./levels/one.ts'), a static import, or import.meta.glob for a table of modules",
  },
};

/** Human output lists at most this many diagnostics of one code before summarising. */
const HUMAN_LIMIT_PER_CODE = 40;

export interface CheckReport {
  readonly ok: boolean;
  readonly projectRoot: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly level2: BundledValidateReport['level2'];
  /** Every file checked (scenes validated + scripts type-checked), sha256 of the raw bytes. */
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly notes: readonly string[];
  readonly typecheck: {
    readonly ok: boolean;
    /**
     * Number of `E_TYPE` / `E_TYPECHECK_UNAVAILABLE` / `E_DEPENDENCIES_MISSING` diagnostics (they
     * are in `diagnostics`).
     */
    readonly errors: number;
    readonly tsconfig: string | null;
    /** `project` = the project's own tsconfig; `pix3-types` = `.pix3/tsconfig.check.json`. */
    readonly mode: 'project' | 'pix3-types';
    readonly files: number;
    readonly typescript: { readonly version: string; readonly source: string } | null;
    /** Why tsc did not run at all (null when it ran, or was attempted and failed). */
    readonly skipped: string | null;
  };
  readonly kit: {
    readonly version: string | null;
    readonly cliVersion: string;
    readonly upToDate: boolean;
  };
  readonly timingsMs: {
    readonly validate: number;
    readonly typecheck: number;
    readonly total: number;
  };
}

/** The validator, as `check` calls it (the bundle; specs can pass the source function). */
export type ValidateFn = (options: {
  projectRoot: string;
  hydrate: boolean;
}) => Promise<BundledValidateReport>;

export interface CheckIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly validate?: ValidateFn;
  readonly typescript?: Partial<Omit<ResolveTypeScriptOptions, 'projectRoot' | 'offline'>>;
}

interface CheckArgs {
  readonly json: boolean;
  readonly hydrate: boolean;
  readonly offline: boolean;
  readonly sync: boolean;
  readonly project?: string;
  readonly help: boolean;
}

const parseCheckArgs = (argv: readonly string[]): CheckArgs | { error: string } => {
  let json = false;
  let hydrate = true;
  let offline = false;
  let sync = true;
  let project: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-hydrate') hydrate = false;
    else if (arg === '--offline') offline = true;
    else if (arg === '--no-sync') sync = false;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--project') {
      project = argv[++i];
      if (!project) return { error: '--project needs a folder' };
    } else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else return { error: `unknown argument ${arg}` };
  }
  return { json, hydrate, offline, sync, project, help };
};

const defaultValidate: ValidateFn = async options => {
  const { withValidateBundle } = await import('../validate/entry.ts');
  return withValidateBundle((bundle, esbuildSpecifier) =>
    bundle.validateBundledProject({ ...options, esbuildSpecifier })
  );
};

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const diag = (
  code: CheckCode,
  fields: Omit<CheckDiagnostic, 'severity' | 'code'>
): CheckDiagnostic => ({ severity: CHECK_CODES[code].severity, code, ...fields });

/** `metadata.agentKit.version` of the manifest, or null. */
export const readKitVersion = (projectRoot: string): string | null => {
  try {
    const parsed = parse(readFileSync(join(projectRoot, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    const metadata =
      parsed && typeof parsed === 'object'
        ? (parsed as { metadata?: { agentKit?: { version?: unknown } } }).metadata
        : undefined;
    const version = metadata?.agentKit?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
};

/** Whether a `node_modules` folder is reachable from the project (walking up), as Node resolves. */
export const hasNodeModules = (projectRoot: string): boolean => {
  let dir = resolve(projectRoot);
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
};

export { installedRuntimeVersion };

const formatDiagnostic = (d: CheckDiagnostic): string => {
  const where = `${d.file}${d.line !== undefined ? `:${d.line}` : ''}`;
  const node = d.nodeId !== undefined ? ` [${d.nodeId}]` : '';
  let text = `${where}  ${d.severity}  ${d.code}${node}  ${d.message}\n`;
  if (d.path) text += `    at ${d.path}\n`;
  if (d.fix) text += `    fix: ${d.fix}\n`;
  return text;
};

export const formatCheckHuman = (report: CheckReport): string => {
  let out = '';
  const perCode = new Map<string, number>();
  let hidden = 0;
  for (const d of report.diagnostics) {
    const seen = (perCode.get(d.code) ?? 0) + 1;
    perCode.set(d.code, seen);
    if (seen > HUMAN_LIMIT_PER_CODE) {
      hidden += 1;
      continue;
    }
    out += formatDiagnostic(d);
  }
  if (hidden > 0) out += `… ${hidden} more (pix3 check --json lists them all)\n`;
  for (const note of report.notes) out += `note: ${note}\n`;
  const tc = report.typecheck;
  const typecheckLine = tc.typescript
    ? `typecheck ${tc.files} file(s) with TypeScript ${tc.typescript.version} (${tc.typescript.source}, ${tc.tsconfig}): ${tc.errors} error(s)`
    : tc.skipped
      ? `typecheck skipped: ${tc.skipped}`
      : 'typecheck did not run';
  const level2 =
    report.level2.state === 'ran'
      ? `level 2 hydrated ${report.level2.filesHydrated} file(s)${
          report.level2.filesSkippedForScripts
            ? `, ${report.level2.filesSkippedForScripts} SKIPPED (scripts do not compile — user: components unchecked)`
            : ''
        }`
      : report.level2.state === 'disabled'
        ? 'level 2 off'
        : `level 2 skipped: ${report.level2.reason}`;
  out += `${typecheckLine}; ${level2}.\n`;
  if (report.kit.version === null) {
    out += `kit: none in this project (pix3 kit installs it).\n`;
  }
  out +=
    `${report.errorCount === 0 ? 'OK' : 'FAILED'}: ${report.files.length} file(s) checked, ` +
    `${report.errorCount} error(s), ${report.warningCount} warning(s) in ${report.timingsMs.total} ms.\n`;
  return out;
};

export const formatCheckJson = (report: CheckReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;

const compare = (a: CheckDiagnostic, b: CheckDiagnostic): number =>
  a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code);

/** Run the whole check; never throws for problems in the project (returns them). */
export const checkProject = async (
  projectRoot: string,
  options: {
    readonly hydrate: boolean;
    readonly offline: boolean;
    /** Flush a running editor first (plan §B.6); `false` = `--no-sync`. Default true. */
    readonly sync?: boolean;
    readonly validate?: ValidateFn;
    readonly typescript?: CheckIo['typescript'];
    readonly log?: (line: string) => void;
  }
): Promise<CheckReport> => {
  const started = Date.now();
  // Files are the truth only once the editor has written them: a dev server with an editor tab
  // (`.pix3/dev.json`) is asked to flush before anything here reads the disk.
  const synced = await syncEditor(projectRoot, { noSync: options.sync === false });
  const diagnostics: CheckDiagnostic[] = [];
  if (synced.status === 'unsynced') {
    diagnostics.push({
      code: 'E_EDITOR_UNSYNCED',
      severity: 'error',
      file: PROJECT_MANIFEST_FILE,
      message: describeUnsynced(synced),
    });
  }
  const validate = options.validate ?? defaultValidate;
  const validated = await validate({ projectRoot, hydrate: options.hydrate });
  const validateMs = Date.now() - started;

  const notes: string[] = [...validated.notes];
  if (synced.status === 'flushed') notes.push(`editor at ${synced.url} flushed its unsaved scenes`);

  // --- the type-check layout ------------------------------------------------------------------
  const ownTsconfig = hasOwnTsconfig(projectRoot);
  let tsconfig: string | null;
  let skipped: string | null = null;
  if (ownTsconfig) {
    tsconfig = ROOT_TSCONFIG;
    const installed = installedRuntimeVersion(projectRoot);
    if (!hasNodeModules(projectRoot)) {
      // Without node_modules every import fails, and tsc reports each one as its own "Cannot find
      // module" — hundreds of E_TYPE lines that all mean `npm install`. Say that once instead.
      skipped = 'dependencies not installed (run npm install)';
      diagnostics.push(
        diag('E_DEPENDENCIES_MISSING', {
          file: existsSync(join(projectRoot, 'package.json')) ? 'package.json' : ROOT_TSCONFIG,
          message:
            'This project has its own tsconfig.json, so its scripts are type-checked against its own node_modules — and there is no node_modules. The type-check was skipped; the scenes were still validated.',
          fix: 'npm install',
        })
      );
    } else if (installed === null) {
      diagnostics.push(
        diag('W_RUNTIME_NOT_INSTALLED', {
          file: ROOT_TSCONFIG,
          message: `This project has its own tsconfig.json, so its scripts are type-checked against its own node_modules — and node_modules/@pix3/runtime is missing (this CLI ships ${CLI_VERSION}).`,
          fix: 'npm install in the project, then run pix3 check again',
        })
      );
    }
  } else {
    tsconfig = CHECK_TSCONFIG;
    const { ensureRuntimeTypes } = await import('../types/runtime-types.ts');
    const shipped = ensureRuntimeTypes({ log: options.log });
    if (!projectTypesCurrent(projectRoot, shipped.manifest)) {
      installProjectTypes(projectRoot, shipped);
      notes.push(
        `Wrote the @pix3/runtime ${shipped.manifest.runtimeVersion} types to .pix3/types/ (and ${CHECK_TSCONFIG}).`
      );
    }
  }

  // --- TypeScript -----------------------------------------------------------------------------
  const typecheckStarted = Date.now();
  let resolved: ResolvedTypeScript | null = null;
  let result: TypecheckResult | null = null;
  if (skipped === null) {
    try {
      resolved = await resolveTypeScript({
        projectRoot,
        offline: options.offline,
        log: options.log,
        ...options.typescript,
      });
      result = runTypecheck(resolved.ts, projectRoot, tsconfig);
    } catch (error) {
      const command = error instanceof TypeScriptUnavailableError ? error.command : undefined;
      diagnostics.push(
        diag('E_TYPECHECK_UNAVAILABLE', {
          file: tsconfig,
          message: error instanceof Error ? error.message : String(error),
          fix: command,
        })
      );
    }
  }
  const typecheckMs = Date.now() - typecheckStarted;
  const typeDiagnostics: CheckDiagnostic[] = (result?.errors ?? []).map(error =>
    diag('E_TYPE', {
      file: error.file,
      line: error.line,
      message: `${error.tsCode}: ${error.message}`,
    })
  );
  diagnostics.push(...typeDiagnostics);

  // --- the version gate -----------------------------------------------------------------------
  const mismatch = runtimeVersionMismatch(projectRoot);
  if (mismatch) {
    diagnostics.push(
      diag('E_RUNTIME_VERSION', {
        file: 'node_modules/@pix3/runtime/package.json',
        message: mismatch.message,
        fix: mismatch.fix,
      })
    );
  }
  for (const other of lockstepMismatches(projectRoot)) {
    diagnostics.push(
      diag('W_PIX3_VERSION_MISMATCH', {
        file: `node_modules/${other.name}/package.json`,
        message: `${other.name} ${other.installed} is installed; this CLI is ${CLI_VERSION}. The @pix3/* packages are released in lockstep, so the editor or the build may differ from what the kit and the CLI describe.`,
        fix: `npm install ${other.name}@${CLI_VERSION}`,
      })
    );
  }

  // --- kit ------------------------------------------------------------------------------------
  const kitVersion = readKitVersion(projectRoot);
  const kitUpToDate = kitVersion === CLI_VERSION;
  if (kitVersion !== null && !kitUpToDate) {
    diagnostics.push(
      diag('W_KIT_OUTDATED', {
        file: PROJECT_MANIFEST_FILE,
        path: 'metadata.agentKit.version',
        message: `The agent kit here is ${kitVersion}; this CLI is ${CLI_VERSION}.`,
        fix: `pix3 kit --update (it never overwrites kit files you edited)`,
      })
    );
  }

  // --- contract B: what would put /@vite/client on the editor page ----------------------------
  const chain = scanEditorChain(projectRoot);
  for (const issue of chain.issues) {
    const kind = EDITOR_CHAIN_CODES[issue.kind];
    diagnostics.push(
      diag(kind.code, {
        file: issue.file,
        line: issue.line,
        message:
          `${kind.what} in a module the editor runs${issue.via !== issue.file ? ` (imported from ${issue.via})` : ''}: ` +
          `\`${issue.text}\`. Vite then loads /@vite/client into the editor page, and the game's ` +
          'full-reload reaches the editor (unsaved edits are lost).',
        fix: kind.fix,
      })
    );
  }

  // --- files and their hashes -----------------------------------------------------------------
  const files = new Map<string, string>();
  for (const file of validated.files) files.set(file.file, file.sha256);
  for (const file of result?.files ?? []) {
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) continue; // outside the project
    const absolute = join(projectRoot, file);
    if (!files.has(file) && existsSync(absolute)) files.set(file, sha256File(absolute));
  }
  for (const file of chain.files) {
    if (!files.has(file)) files.set(file, sha256File(join(projectRoot, file)));
  }

  const all = [...validated.diagnostics, ...[...diagnostics].sort(compare)];
  const errorCount = all.filter(d => d.severity === 'error').length;
  const typeErrors = all.filter(
    d =>
      d.code === 'E_TYPE' ||
      d.code === 'E_TYPECHECK_UNAVAILABLE' ||
      d.code === 'E_DEPENDENCIES_MISSING'
  ).length;
  return {
    ok: errorCount === 0,
    projectRoot,
    errorCount,
    warningCount: all.filter(d => d.severity === 'warning').length,
    level2: validated.level2,
    files: [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, sha256]) => ({ file, sha256 })),
    diagnostics: all,
    notes,
    typecheck: {
      ok: typeErrors === 0,
      errors: typeErrors,
      tsconfig,
      mode: ownTsconfig ? 'project' : 'pix3-types',
      files: result?.files.length ?? 0,
      typescript: resolved ? { version: resolved.version, source: resolved.source } : null,
      skipped,
    },
    kit: { version: kitVersion, cliVersion: CLI_VERSION, upToDate: kitUpToDate },
    timingsMs: { validate: validateMs, typecheck: typecheckMs, total: Date.now() - started },
  };
};

/** Entry for `pix3 check …`; returns the process exit code. */
export const runCheck = async (argv: readonly string[], io: CheckIo): Promise<number> => {
  const args = parseCheckArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 check: ${args.error}\n\n${COMMAND_USAGE.check}`);
    return 2;
  }
  if (args.help) {
    io.stdout(
      `${COMMAND_USAGE.check}\nCodes added to validate's (pix3 validate --help lists those):\n${Object.entries(
        CHECK_CODES
      )
        .map(([code, info]) => `  ${code.padEnd(28)} ${info.summary}`)
        .join('\n')}\n`
    );
    return 0;
  }
  const start = args.project ? resolve(io.cwd, args.project) : io.cwd;
  const projectRoot = args.project ? start : findProjectRoot(start);
  if (!projectRoot || !existsSync(join(projectRoot, PROJECT_MANIFEST_FILE))) {
    io.stderr(
      `pix3 check: no pix3project.yaml in ${start}${args.project ? '' : ' or any parent folder'}. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }
  const report = await checkProject(projectRoot, {
    hydrate: args.hydrate,
    offline: args.offline,
    sync: args.sync,
    validate: io.validate,
    typescript: io.typescript,
    log: line => io.stderr(`${line}\n`),
  });
  io.stdout(args.json ? formatCheckJson(report) : formatCheckHuman(report));
  return report.errorCount > 0 ? 1 : 0;
};
