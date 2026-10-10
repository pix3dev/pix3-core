import {
  autoloadComponentType,
  isProjectScriptEntry,
  isProjectScriptPath,
  normalizeAutoloads,
  type ScriptRegistry,
} from '@pix3/runtime';

import { diagnostic, type Diagnostic } from './diagnostics.ts';
import { toProjectPath, type ProjectFiles } from './project.ts';
import { scanExportNames } from './user-scripts.ts';
import { formatPath, isRecord, parseYamlWithLines, type DocPath } from './yaml-doc.ts';

/**
 * `pix3project.yaml` `autoloads:` against the scripts (level 1: text only). Every host builds an
 * autoload the same way (`normalizeAutoloads` + `autoloadComponentType` in the runtime): the entry
 * needs a `singleton` and a `scriptPath`, the file must be a script entry under `scripts/` or
 * `src/scripts/`, and it must export a Script class named like the file. Anything else and the
 * game starts without the singleton — every `getAutoload` returns null — so each is an error.
 */
const MANIFEST = 'pix3project.yaml';

const FIX_SHAPE = '- singleton: GameState\n    scriptPath: scripts/GameState.ts';

export const checkAutoloads = (project: ProjectFiles): Diagnostic[] => {
  if (!project.has(MANIFEST)) return [];
  const parsed = parseYamlWithLines(project.readText(MANIFEST));
  if ('errors' in parsed || !isRecord(parsed.data)) return [];
  const raw = parsed.data.autoloads;
  if (raw === undefined || raw === null) return [];
  const out: Diagnostic[] = [];
  const report = (at: DocPath, message: string, fix?: string): void => {
    out.push(
      diagnostic({
        code: 'E_AUTOLOAD',
        file: MANIFEST,
        path: formatPath(at),
        line: parsed.lineOf(at),
        message,
        ...(fix ? { fix } : {}),
      })
    );
  };
  if (!Array.isArray(raw)) {
    report(
      ['autoloads'],
      'autoloads: must be a list; the game reads none.',
      `autoloads:\n  ${FIX_SHAPE}`
    );
    return out;
  }
  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const at: DocPath = ['autoloads', index];
    const [normalized] = normalizeAutoloads([entry]);
    if (!normalized) {
      report(
        at,
        'an autoload needs a singleton name and a scriptPath; this one is skipped.',
        FIX_SHAPE
      );
      return;
    }
    if (seen.has(normalized.singleton)) {
      report(
        [...at, 'singleton'],
        `singleton "${normalized.singleton}" is declared twice; the game keeps the first.`,
        'give each autoload its own singleton name'
      );
      return;
    }
    seen.add(normalized.singleton);
    // A disabled autoload is never built: nothing to check until it is switched on.
    if (!normalized.enabled) return;
    const file = toProjectPath(normalized.scriptPath) ?? normalized.scriptPath;
    const type = autoloadComponentType(file);
    const name = type.slice('user:'.length);
    const where: DocPath = [...at, 'scriptPath'];
    if (!isProjectScriptPath(file)) {
      report(
        where,
        `${file} is not under scripts/ or src/scripts/: project scripts outside them are never registered, so "${normalized.singleton}" never runs.`,
        `move it to scripts/${name}.ts`
      );
      return;
    }
    if (!project.has(file)) {
      report(
        where,
        `${file} does not exist: autoload "${normalized.singleton}" never runs.`,
        `create ${file} with export class ${name} extends Script`
      );
      return;
    }
    const source = project.readText(file);
    if (!isProjectScriptEntry(file, source)) {
      report(
        where,
        `${file} is not a script entry (no "extends Script" in a .ts/.js file): autoload "${normalized.singleton}" never runs.`,
        `export class ${name} extends Script`
      );
      return;
    }
    const { names, hasStar } = scanExportNames(source);
    if (!hasStar && !names.includes(name)) {
      report(
        where,
        `${file} does not export ${name}: an autoload's class is the one named like its file (${type}), so "${normalized.singleton}" never runs.`,
        `export class ${name} extends Script (or point scriptPath at the file named like the class)`
      );
    }
  });
  return out;
};

/**
 * Level 2: the scripts compiled and registered — an autoload whose type is still missing exports
 * something named like the file that is not a Script class.
 */
export const checkAutoloadTypes = (
  project: ProjectFiles,
  registry: ScriptRegistry
): Diagnostic[] => {
  if (!project.has(MANIFEST)) return [];
  const parsed = parseYamlWithLines(project.readText(MANIFEST));
  if ('errors' in parsed || !isRecord(parsed.data) || !Array.isArray(parsed.data.autoloads)) {
    return [];
  }
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  parsed.data.autoloads.forEach((entry: unknown, index) => {
    const [normalized] = normalizeAutoloads([entry]);
    if (!normalized || seen.has(normalized.singleton)) return;
    seen.add(normalized.singleton);
    if (!normalized.enabled) return;
    const file = toProjectPath(normalized.scriptPath) ?? normalized.scriptPath;
    if (!project.has(file)) return; // level 1 said so
    const type = autoloadComponentType(file);
    if (registry.getComponentType(type)) return;
    const at: DocPath = ['autoloads', index, 'scriptPath'];
    out.push(
      diagnostic({
        code: 'E_AUTOLOAD',
        file: MANIFEST,
        path: formatPath(at),
        line: parsed.lineOf(at),
        message: `${file} compiles, but registers no Script class ${type.slice('user:'.length)} (${type}): autoload "${normalized.singleton}" never runs.`,
        fix: `export class ${type.slice('user:'.length)} extends Script`,
      })
    );
  });
  return out;
};
