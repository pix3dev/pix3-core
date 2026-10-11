import type { CliIo } from '../io.ts';
import { resolveProjectRoot } from '../manifest.ts';
import { hasOwnTsconfig } from '../types/project-types.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { formatKitReport, installKit } from './install.ts';
import { ensureKit } from './kit-source.ts';

interface KitArgs {
  readonly projectDir?: string;
  readonly update: boolean;
  /** A 1.x project's kit → 2.x (`kit/migrate.ts`); implies `--update`. */
  readonly migrate: boolean;
  readonly help: boolean;
}

const parseKitArgs = (argv: readonly string[]): KitArgs | { error: string } => {
  let projectDir: string | undefined;
  let update = false;
  let migrate = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--update') update = true;
    else if (arg === '--migrate') migrate = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--project=')) projectDir = arg.slice('--project='.length);
    else if (arg === '--project') {
      projectDir = argv[++i];
      if (!projectDir || projectDir.startsWith('--')) return { error: '--project needs a folder' };
    } else return { error: `unknown option "${arg}"` };
  }
  return { projectDir, update, migrate, help };
};

/** `pix3 kit [--update | --migrate] [--project <dir>]`; returns the exit code. */
export const runKitCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const args = parseKitArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 kit: ${args.error}\n\n${COMMAND_USAGE.kit}`);
    return 2;
  }
  if (args.help) {
    io.stdout(COMMAND_USAGE.kit);
    return 0;
  }
  const project = resolveProjectRoot(io.cwd, args.projectDir);
  if ('error' in project) {
    io.stderr(`pix3 kit: ${project.error}\n`);
    return 2;
  }
  const { root } = project;
  const log = (line: string): void => io.stderr(`${line}\n`);
  const kit = await ensureKit({ log });
  const runtimeTypes = hasOwnTsconfig(root)
    ? undefined
    : (await import('../types/runtime-types.ts')).ensureRuntimeTypes({ log });
  if (args.migrate) {
    const { formatMigrationReport, migrateKit } = await import('./migrate.ts');
    io.stdout(formatMigrationReport(migrateKit(root, kit, { runtimeTypes }), root));
    return 0;
  }
  io.stdout(formatKitReport(installKit(root, kit, { update: args.update, runtimeTypes }), root));
  return 0;
};
