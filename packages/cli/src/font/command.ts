import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSeq, parseDocument } from 'yaml';

import { readTextOrNull, writeAtomic } from '../fs-util.ts';
import type { CliIo } from '../io.ts';
import { PROJECT_MANIFEST_FILE, resolveProjectRoot } from '../manifest.ts';
import { cliPackageRoot } from '../package-root.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { FONT_CATALOG, findCatalogFont, fontFileName, type CatalogFont } from './catalog.ts';

/**
 * `pix3 font` — lists the fonts this CLI carries; `pix3 font add <family>` copies one into the
 * project's `fonts/` (each subset's woff2 and the licence) and registers its faces under `fonts:`
 * in `pix3project.yaml`, where the editor, the player and `pix3 smoke` load them before the first
 * frame. Idempotent: an add that is already there writes nothing.
 */

/** Where the faces are in the project, and under which `res://` path the manifest names them. */
const PROJECT_FONTS_DIR = 'fonts';

interface FontArgs {
  readonly action: 'list' | 'add';
  readonly family?: string;
  readonly projectDir?: string;
  readonly json: boolean;
}

const parseFontArgs = (argv: readonly string[]): FontArgs | { error: string } => {
  const positionals: string[] = [];
  let projectDir: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--project') {
      projectDir = argv[++i];
      if (projectDir === undefined) return { error: '--project needs a value' };
    } else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else positionals.push(arg);
  }
  const [action = 'list', ...rest] = positionals;
  if (action === 'list') return { action, projectDir, json };
  if (action !== 'add') return { error: `unknown action "${action}" (list or add)` };
  const family = rest.join(' ').trim();
  if (!family) return { error: 'add needs a family, e.g. pix3 font add Nunito' };
  return { action, family, projectDir, json };
};

const scriptsOf = (font: CatalogFont): string =>
  font.subsets.map(subset => (subset.subset === 'latin' ? 'Latin' : 'Cyrillic')).join(' + ');

const listText = (): string =>
  [
    'Fonts this CLI ships into a project (pix3 font add <family>):',
    '',
    ...FONT_CATALOG.map(
      font =>
        `  ${font.family.padEnd(13)} ${String(font.weight).padEnd(4)} ${scriptsOf(font).padEnd(17)} ${font.license.padEnd(12)} ${font.look}`
    ),
    '',
    'A text in a language a family lacks (Cyrillic in a Latin-only one) falls back to a system face.',
    '',
  ].join('\n');

interface ManifestFace {
  readonly family: string;
  readonly path: string;
  readonly weight: number;
  readonly unicodeRange: string;
}

/** Add the faces `pix3project.yaml` does not name yet (by path); the rest of it stays as written. */
const registerFaces = (projectRoot: string, faces: readonly ManifestFace[]): string[] => {
  const path = join(projectRoot, PROJECT_MANIFEST_FILE);
  const doc = parseDocument(readTextOrNull(path) ?? '');
  const existing = doc.get('fonts');
  const fonts = (doc.toJS() as { fonts?: unknown } | null)?.fonts;
  const known = new Set((Array.isArray(fonts) ? fonts : []).map(face => String(face?.path ?? '')));
  const added = faces.filter(face => !known.has(face.path));
  if (added.length === 0) return [];
  if (isSeq(existing)) for (const face of added) existing.add(doc.createNode(face));
  else doc.set('fonts', doc.createNode(added));
  writeAtomic(path, doc.toString({ indent: 2 }));
  return added.map(face => face.path);
};

const sameBytes = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b));

export const runFontCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(COMMAND_USAGE.font);
    return 0;
  }
  const args = parseFontArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 font: ${args.error}\n\n${COMMAND_USAGE.font}`);
    return 2;
  }
  if (args.action === 'list') {
    if (args.json) io.stdout(`${JSON.stringify(FONT_CATALOG, null, 2)}\n`);
    else io.stdout(listText());
    return 0;
  }
  const font = findCatalogFont(args.family ?? '');
  if (!font) {
    io.stderr(
      `pix3 font: no font "${args.family}" here; the families are ${FONT_CATALOG.map(f => f.family).join(', ')}.\n`
    );
    return 2;
  }
  const project = resolveProjectRoot(io.cwd, args.projectDir);
  if ('error' in project) {
    io.stderr(`pix3 font: ${project.error}\n`);
    return 2;
  }
  const source = join(cliPackageRoot(), 'fonts');
  const target = join(project.root, PROJECT_FONTS_DIR);
  const files = [...font.subsets.map(subset => fontFileName(font, subset)), font.licenseFile];
  // Refuse before writing anything: a file of that name with other bytes is the project's own.
  const clash = files.find(
    file => existsSync(join(target, file)) && !sameBytes(join(source, file), join(target, file))
  );
  if (clash) {
    io.stderr(
      `pix3 font: ${PROJECT_FONTS_DIR}/${clash} exists with other bytes; move it away first (nothing was written).\n`
    );
    return 1;
  }
  mkdirSync(target, { recursive: true });
  const copied: string[] = [];
  for (const file of files) {
    if (existsSync(join(target, file))) continue;
    copyFileSync(join(source, file), join(target, file));
    copied.push(`${PROJECT_FONTS_DIR}/${file}`);
  }
  const registered = registerFaces(
    project.root,
    font.subsets.map(subset => ({
      family: font.family,
      path: `${PROJECT_FONTS_DIR}/${fontFileName(font, subset)}`,
      weight: font.weight,
      unicodeRange: subset.unicodeRange,
    }))
  );
  if (args.json) {
    io.stdout(
      `${JSON.stringify({ family: font.family, weight: font.weight, copied, registered }, null, 2)}\n`
    );
    return 0;
  }
  io.stdout(
    `${font.family} ${font.weight} (${scriptsOf(font)}, ${font.license}): ` +
      (copied.length + registered.length === 0
        ? 'already in the project, nothing written.\n'
        : `${copied.length} file(s) into ${PROJECT_FONTS_DIR}/, ${registered.length} face(s) added to ${PROJECT_MANIFEST_FILE} fonts:.\n`) +
      `Use it: labelFontFamily: "${font.family}", labelFontWeight: ${font.weight} (Label2D, Button2D …).\n`
  );
  return 0;
};
