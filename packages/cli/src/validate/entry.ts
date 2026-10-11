import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CliIo } from '../io.ts';
import { resolveEsbuild, withCommandBundle } from '../package-root.ts';
import { validateHelp } from './diagnostics.ts';

/**
 * `pix3 validate` as `index.ts` reaches it — deliberately free of runtime imports, so the other
 * commands never pay for the validator and `node src/index.ts` can load this file directly.
 *
 * The validator itself always runs from an esbuild bundle (see `bundle.ts` for why):
 * - published package: `dist/validate/prebuilt/bundle-main.js`, built at `prepack`;
 * - repo checkout (running the `.ts` sources): the prebuilt bundle is never used, even when a
 *   `dist/` from an earlier build exists (`package-root.ts`); it is built into a temp folder first
 *   (~0.5 s, needs the repo's `esbuild`), which keeps runtime edits live without a build step.
 */

/** The report shape `pix3 check` consumes (`validate.ts` `ValidateReport`, restated so this file
 * stays free of runtime imports). */
export interface BundledValidateReport {
  readonly projectRoot: string;
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
  readonly diagnostics: readonly BundledDiagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly level2:
    | {
        readonly state: 'ran';
        readonly filesHydrated: number;
        readonly filesSkipped: number;
        /** Of `filesSkipped`: scenes with `user:` components left out because the scripts failed to load. */
        readonly filesSkippedForScripts?: number;
      }
    | { readonly state: 'disabled' }
    | { readonly state: 'skipped'; readonly reason: string };
  readonly notes: readonly string[];
}

export interface BundledDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly file: string;
  readonly nodeId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly message: string;
  readonly fix?: string;
}

export interface BundledValidate {
  validateBundledProject(options: {
    projectRoot: string;
    files?: readonly string[];
    hydrate?: boolean;
    esbuildSpecifier?: string;
  }): Promise<BundledValidateReport>;
  runBundledValidate(
    argv: readonly string[],
    io: CliIo & { readonly esbuildSpecifier?: string }
  ): Promise<number>;
}

const BUNDLE_MAIN = 'bundle-main.js';

const importBundle = async (dir: string): Promise<BundledValidate> =>
  (await import(pathToFileURL(join(dir, BUNDLE_MAIN)).href)) as BundledValidate;

/**
 * Run `fn` with the validator bundle loaded: the prebuilt one when published, else one built from
 * source into a temp folder (removed afterwards).
 */
export const withValidateBundle = <T>(
  fn: (bundle: BundledValidate, esbuildSpecifier: string | undefined) => Promise<T>
): Promise<T> =>
  withCommandBundle(
    'validate',
    BUNDLE_MAIN,
    async outdir => (await import('./bundle.ts')).buildValidateBundle(outdir),
    async dir => fn(await importBundle(dir), resolveEsbuild())
  );

/** Run `pix3 validate` with the arguments after the command word; resolves to the exit code. */
export const runValidateCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  // The help needs no bundle (a published package without its prebuilt one still answers it).
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(validateHelp());
    return 0;
  }
  return withValidateBundle((bundle, esbuildSpecifier) =>
    bundle.runBundledValidate(argv, { ...io, esbuildSpecifier })
  );
};
