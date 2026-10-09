// @ts-check
/**
 * `npm create pix3@latest [dir] -- [--template 2d|3d] [--name <project name>] [--yes]`
 *
 * Asks what it was not told (in a terminal; `--yes` or no TTY takes the defaults: `2d`,
 * `pix3-game`), then runs `pix3 new <2d|3d> <dir>` of the `@pix3/cli` it depends on — the one
 * implementation of project creation (templates `base` + the `2d`/`3d` layer from this package's
 * `templates/`, the manifest, the agent kit). Plain JavaScript on purpose: a create-* bin runs
 * from `node_modules`, where Node does not strip TypeScript, and this one needs no build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export const STARTERS = /** @type {const} */ (['2d', '3d']);
const DEFAULT_TEMPLATE = '2d';
const DEFAULT_DIR = 'pix3-game';

const USAGE = `Usage: npm create pix3@latest [dir] -- [--template 2d|3d] [--name <project name>] [--yes]

  dir                 an empty or new folder (default: ${DEFAULT_DIR})
  --template, -t      2d (default) or 3d — an empty project either way
  --name              project name (default: the folder name)
  --yes, -y           take the defaults for anything not given, ask nothing
`;

/**
 * @param {readonly string[]} argv
 * @returns {{ dir?: string, template?: string, name?: string, yes: boolean, help: boolean }}
 */
export const parseArgs = argv => {
  /** @type {{ dir?: string, template?: string, name?: string, yes: boolean, help: boolean }} */
  const out = { yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('-') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    const value = () => inline ?? argv[++i];
    if (flag === '--template' || flag === '-t') out.template = value();
    else if (flag === '--name') out.name = value();
    else if (flag === '--yes' || flag === '-y') out.yes = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--2d' || flag === '--3d') out.template = flag.slice(2);
    else if (!arg.startsWith('-') && out.dir === undefined) out.dir = arg;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
};

/**
 * The `pix3` entry to run: the CLI's sources in a pix3-core checkout (Node strips the types
 * outside `node_modules`), its published single-file bin otherwise.
 * @returns {string}
 */
export const pix3Entry = () => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@pix3/cli/package.json'));
  const source = join(root, 'src', 'index.ts');
  if (existsSync(source) && !/[\\/]node_modules[\\/]/.test(source)) return source;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pix3;
  if (typeof bin !== 'string') throw new Error(`@pix3/cli at ${root} has no pix3 bin`);
  return join(root, bin);
};

/** @param {string} value */
const normalizeTemplate = value => value.trim().toLowerCase();

/**
 * The whole command; resolves to the exit code.
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export const run = async argv => {
  /** @type {ReturnType<typeof parseArgs>} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `create-pix3: ${error instanceof Error ? error.message : error}\n\n${USAGE}`
    );
    return 1;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  const interactive = !args.yes && stdin.isTTY === true && stdout.isTTY === true;
  const prompt = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    let template = args.template === undefined ? undefined : normalizeTemplate(args.template);
    while (template === undefined || !STARTERS.includes(/** @type {'2d'} */ (template))) {
      if (template !== undefined) {
        process.stderr.write(`create-pix3: "${template}" is not a starter (2d, 3d)\n`);
        if (!prompt) return 1;
      }
      template = prompt
        ? normalizeTemplate(
            (await prompt.question(`2D or 3D? (2d/3d) [${DEFAULT_TEMPLATE}] `)) || DEFAULT_TEMPLATE
          )
        : DEFAULT_TEMPLATE;
    }
    const dir =
      args.dir ??
      (prompt
        ? (await prompt.question(`Project folder [${DEFAULT_DIR}] `)).trim() || DEFAULT_DIR
        : DEFAULT_DIR);
    prompt?.close();
    const result = spawnSync(
      process.execPath,
      [pix3Entry(), 'new', template, dir, ...(args.name ? ['--name', args.name] : [])],
      { stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    prompt?.close();
  }
};
