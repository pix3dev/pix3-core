#!/usr/bin/env node
import { resolve } from 'node:path';

import { createProject } from './new-project.ts';
import { listTemplates, oneLine, resolveTemplate } from './templates.ts';
import { USAGE } from './usage.ts';
import { CLI_VERSION } from './version.ts';

/**
 * `pix3` — entry point of `@pix3/cli`. Deliberately free of heavy imports: `new` must stay instant
 * under a cold `npx`, so every other command is imported on demand.
 */

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags.set(arg.slice(2), argv[++i]);
      } else {
        flags.set(arg.slice(2), true);
      }
    } else if (arg === '-v') {
      flags.set('version', true);
    } else if (arg === '-h') {
      flags.set('help', true);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
};

const stringFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const printTemplateList = (): void => {
  const templates = listTemplates().filter(t => !t.hidden);
  const width = Math.max(...templates.map(t => t.id.length));
  const section = (title: string, items: typeof templates): void => {
    if (items.length === 0) return;
    process.stdout.write(`${title}\n`);
    for (const t of items) {
      process.stdout.write(`  ${t.id.padEnd(width)}  ${t.title} — ${oneLine(t.description)}\n`);
    }
    process.stdout.write('\n');
  };
  section(
    'Recipes (ship design/recipe.md — a playable core loop):',
    templates.filter(t => t.isRecipe)
  );
  section(
    'Starter templates:',
    templates.filter(t => !t.isRecipe)
  );
  process.stdout.write(
    'Create one:  pix3 new <id> [dir]   (recipes also by short name: pix3 new tapper)\n'
  );
};

const runNew = async (args: ParsedArgs): Promise<number> => {
  const [, query, dirArg] = args.positionals;
  if (!query) {
    printTemplateList();
    return 0;
  }
  const resolved = resolveTemplate(query, listTemplates());
  if ('error' in resolved) {
    process.stderr.write(`pix3: ${resolved.error}\n`);
    return 1;
  }
  const dir = resolve(process.cwd(), dirArg ?? resolved.template.id);
  // The kit and the script types are prebuilt in a published package (plain file copies); a repo
  // checkout regenerates them first when their sources changed (printed).
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  const { ensureKit } = await import('./kit/kit-source.ts');
  const { ensureRuntimeTypes } = await import('./types/runtime-types.ts');
  const { agentKitStep } = await import('./kit/install.ts');
  const kit = await ensureKit({ log });
  const runtimeTypes = ensureRuntimeTypes({ log });
  const project = createProject({
    template: resolved.template,
    dir,
    projectName: stringFlag(args, 'name'),
    postCreateSteps: [agentKitStep(kit, runtimeTypes)],
  });
  process.stdout.write(
    `Created ${project.projectName} from ${project.template.id} in ${project.dir}\n` +
      `  ${project.files.length} files, project id ${project.projectId}, agent kit ${kit.manifest.version}\n\n` +
      `Next: \`npm install\`, then \`pix3 editor\` opens it in Chrome for your agent, and\n` +
      '      `pix3 agent-setup` connects Codex / Claude Code to that Chrome once per project;\n' +
      '      AGENTS.md / CLAUDE.md and .claude/skills/ tell the agent how, `pix3 check` verifies its work.\n'
  );
  return 0;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];
  if (args.flags.has('version')) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (!command || args.flags.has('help') || command === 'help') {
    process.stdout.write(USAGE);
    return command || args.flags.has('help') ? 0 : 1;
  }
  switch (command) {
    case 'new':
      return runNew(args);
    case 'check': // own argument parsing; validator, TypeScript and types load lazily
      return (await import('./check/check.ts')).runCheck(
        process.argv.slice(process.argv.indexOf('check') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    case 'kit':
      return (await import('./kit/command.ts')).runKitCli({
        cwd: process.cwd(),
        projectDir: stringFlag(args, 'project'),
        update: args.flags.has('update'),
      });
    case 'editor': // own argument parsing; finds or starts the dev server, opens Chrome
      return (await import('./editor/command.ts')).runEditorCli(
        process.argv.slice(process.argv.indexOf('editor') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    case 'agent-setup': // own argument parsing; writes the project's MCP config files
      return (await import('./agent-setup/command.ts')).runAgentSetupCli(
        process.argv.slice(process.argv.indexOf('agent-setup') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    case 'smoke': // own argument parsing; the game runs in a worker from the smoke bundle
      return (await import('./smoke/command.ts')).runSmokeCli(
        process.argv.slice(process.argv.indexOf('smoke') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    case 'tree': // own argument parsing; plain YAML (the runtime loads only for --props)
      return (await import('./tree/command.ts')).runTreeCli(
        process.argv.slice(process.argv.indexOf('tree') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    case 'validate': // own argument parsing (`--json` takes no value); runtime loads lazily
      return (await import('./validate/entry.ts')).runValidateCli(
        process.argv.slice(process.argv.indexOf('validate') + 1)
      );
    case 'sfx': // own argument parsing; offline synth, no dependencies
      return (await import('./sfx/command.ts')).runSfx(
        process.argv.slice(process.argv.indexOf('sfx') + 1),
        {
          cwd: process.cwd(),
          stdout: text => process.stdout.write(text),
          stderr: text => process.stderr.write(text),
        }
      );
    default:
      process.stderr.write(`pix3: unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
};

main().then(
  code => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`pix3: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
