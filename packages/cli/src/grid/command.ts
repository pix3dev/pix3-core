import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  stringify,
  type Document,
  type Node as YamlNode,
  type YAMLMap,
} from 'yaml';

import { readTextOrNull, writeAtomic } from '../fs-util.ts';
import type { CliIo } from '../io.ts';
import { resolveProjectRoot } from '../manifest.ts';
import { COMMAND_USAGE } from '../usage.ts';

/**
 * `pix3 grid` — writes rows × cols instances of one prefab under a node of a scene, once: a board's
 * backing cells, a level-select page, an inventory. The result is ordinary YAML (one
 * `instance:` entry per cell, its position and its overrides), so the editor shows it, `pix3 tree`
 * lists it and a human edits it like any other node. core-tests/game18 wrote its 64 cells by hand
 * because the kit says to author them; this writes them instead. Not a node: nothing repeats at
 * run time, and running it again with --replace rewrites the cells it wrote.
 */

interface GridArgs {
  readonly scene: string;
  readonly parent: string;
  readonly prefab: string;
  readonly rows: number;
  readonly cols: number;
  readonly step?: { x: number; y: number };
  readonly id?: string;
  readonly name?: string;
  readonly props: Record<string, unknown>;
  readonly checker: Record<string, unknown>;
  readonly replace: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly project?: string;
}

/** More than this many instances is a mistake (or wants a script that spawns them). */
const MAX_CELLS = 1024;

const parseObject = (flag: string, text: string | undefined): Record<string, unknown> | string => {
  let value: unknown;
  try {
    value = JSON.parse(text ?? '');
  } catch {
    value = undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : `${flag} takes one JSON object of properties, e.g. ${flag} '{"texture":{"type":"texture","url":"res://sprites/cell-b.svg"}}'`;
};

const parseGridArgs = (argv: readonly string[]): GridArgs | { error: string } | 'help' => {
  let scene: string | undefined;
  let parent: string | undefined;
  let prefab: string | undefined;
  let rows: number | undefined;
  let cols: number | undefined;
  let step: GridArgs['step'];
  let id: string | undefined;
  let name: string | undefined;
  let props: Record<string, unknown> = {};
  let checker: Record<string, unknown> = {};
  let replace = false;
  let dryRun = false;
  let json = false;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg];
    const value = (): string | undefined => inline ?? argv[++i];
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--json') json = true;
    else if (flag === '--replace') replace = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--parent') parent = value();
    else if (flag === '--prefab') prefab = value();
    else if (flag === '--rows') rows = Number(value());
    else if (flag === '--cols') cols = Number(value());
    else if (flag === '--size') {
      const match = /^(\d+)x(\d+)$/.exec(value() ?? '');
      if (!match) return { error: '--size takes COLSxROWS, e.g. --size 8x8' };
      cols = Number(match[1]);
      rows = Number(match[2]);
    } else if (flag === '--step') {
      const match = /^(-?\d+(?:\.\d+)?)(?:x(-?\d+(?:\.\d+)?))?$/.exec(value() ?? '');
      if (!match) return { error: '--step takes W or WxH in the parent’s units, e.g. --step 124' };
      step = { x: Number(match[1]), y: Number(match[2] ?? match[1]) };
    } else if (flag === '--id') id = value();
    else if (flag === '--name') name = value();
    else if (flag === '--props' || flag === '--checker') {
      const parsed = parseObject(flag, value());
      if (typeof parsed === 'string') return { error: parsed };
      if (flag === '--props') props = parsed;
      else checker = parsed;
    } else if (flag === '--project') project = value();
    else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (scene === undefined) scene = arg;
    else return { error: `one scene at a time (got ${scene} and ${arg})` };
  }
  if (!scene)
    return { error: 'give the scene to write into, e.g. pix3 grid scenes/main.pix3scene' };
  if (!parent) return { error: '--parent <node id> is the node the cells go under' };
  if (!prefab) return { error: '--prefab <res://…> is the prefab every cell instances' };
  if (rows === undefined || cols === undefined) {
    return { error: '--rows R --cols C (or --size CxR) say how many cells' };
  }
  if (![rows, cols].every(n => Number.isInteger(n) && n > 0)) {
    return { error: '--rows and --cols take whole numbers above 0' };
  }
  if (rows * cols > MAX_CELLS) {
    return {
      error: `${rows * cols} cells is more than ${MAX_CELLS}: a scene file is no place for them — spawn them from a script`,
    };
  }
  for (const pattern of [id, name]) {
    if (pattern !== undefined && !/\{(row|col|i)\}/.test(pattern)) {
      return {
        error: `"${pattern}" names every cell alike: put {row} and {col} (or {i}) in --id / --name`,
      };
    }
  }
  return {
    scene,
    parent,
    prefab,
    rows,
    cols,
    step,
    id,
    name,
    props,
    checker,
    replace,
    dryRun,
    json,
    project,
  };
};

/** `{row}`, `{col}`, `{i}` in a string, or in every string of a JSON value. */
const fill = <T>(value: T, cell: { row: number; col: number; i: number }): T => {
  if (typeof value === 'string') {
    return value
      .replaceAll('{row}', String(cell.row))
      .replaceAll('{col}', String(cell.col))
      .replaceAll('{i}', String(cell.i)) as T;
  }
  if (Array.isArray(value)) return value.map(item => fill(item, cell)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, cell)])
    ) as T;
  }
  return value;
};

/** A pattern as a regex over ids: what `--replace` takes for the cells an earlier run wrote. */
const patternRegex = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split(/(\{(?:row|col|i)\})/)
      .map(part =>
        /^\{(row|col|i)\}$/.test(part) ? '\\d+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`
  );

interface SceneNode {
  readonly map: YAMLMap;
  readonly id: string;
}

/** Every node of a scene document (roots and their `children`, depth first). */
const nodesOf = (doc: Document): SceneNode[] => {
  const out: SceneNode[] = [];
  const walk = (seq: unknown): void => {
    if (!isSeq(seq)) return;
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      out.push({ map: item, id: String(item.get('id') ?? '') });
      walk(item.get('children', true));
    }
  };
  walk(doc.get('root', true));
  return out;
};

/** The prefab's root: its id and name (the default patterns) and its size (the default step). */
const readPrefabRoot = (
  file: string
): { id: string; name: string; width?: number; height?: number } | string => {
  const text = readTextOrNull(file);
  if (text === null) return `the prefab ${file} does not exist`;
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return `the prefab ${file} is not YAML: ${(error as Error).message}`;
  }
  const root = (data as { root?: unknown[] } | null)?.root?.[0] as
    | { id?: unknown; name?: unknown; properties?: { width?: unknown; height?: unknown } }
    | undefined;
  if (!root) return `the prefab ${file} has no root node`;
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    id: typeof root.id === 'string' && root.id ? root.id : 'cell',
    name: typeof root.name === 'string' && root.name ? root.name : 'Cell',
    width: number(root.properties?.width),
    height: number(root.properties?.height),
  };
};

const round = (value: number): number => Math.round(value * 1000) / 1000 || 0;

/** Plain objects merged key by key (arrays and scalars replace). */
const merge = (
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] =
      typeof prior === 'object' &&
      prior !== null &&
      !Array.isArray(prior) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
        ? merge(prior as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
};

/** A value on one line, as a person writes it: `{ position: [-434, 434] }`, `'res://a.svg'`. */
const flow = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value).map(([key, item]) => `${plain(key)}: ${flow(item)}`);
    return pairs.length ? `{ ${pairs.join(', ')} }` : '{}';
  }
  return inFlow(value);
};

/** A scalar as YAML prints it in a block (`instance: res://scenes/prefabs/cell.pix3scene`). */
const plain = (value: unknown): string => stringify(value, { lineWidth: 0 }).trimEnd();

/** A scalar inside `{ … }`: a string with `:` or a flow indicator in quotes (`'res://a.svg'`). */
const inFlow = (value: unknown): string =>
  typeof value === 'string' && /[:#{}[\],&*!|>'"%@`]/.test(value)
    ? `'${value.replaceAll("'", "''")}'`
    : plain(value);

/** The cells' YAML, each an item of a block sequence whose dashes sit at `indent` columns. */
const cellsText = (entries: readonly Record<string, unknown>[], indent: number): string => {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const entry of entries) {
    const { properties, ...head } = entry;
    const keys = Object.entries(head);
    keys.forEach(([key, value], index) =>
      lines.push(`${index === 0 ? `${pad}- ` : `${pad}  `}${key}: ${plain(value)}`)
    );
    lines.push(`${pad}  properties:`);
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      lines.push(`${pad}    ${key}: ${flow(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

/** Column of a source offset. */
const columnOf = (source: string, offset: number): number =>
  offset - (source.lastIndexOf('\n', offset - 1) + 1);

/** The offset of the line start at or after `offset` (the next line when mid-line). */
const nextLineStart = (source: string, offset: number): number => {
  if (offset === 0 || source[offset - 1] === '\n') return offset;
  const newline = source.indexOf('\n', offset);
  return newline === -1 ? source.length : newline + 1;
};

const lineStartOf = (source: string, offset: number): number =>
  source.lastIndexOf('\n', offset - 1) + 1;

/**
 * The scene's text with the cells in it: the parent's block `children:` gains them (in place of an
 * earlier run's on --replace); an empty `children: []` or a missing one becomes a block. Spliced
 * into the source rather than re-printed, so every other byte of the file — comments, quotes,
 * `[0, 700]` spacing — stays as it was written.
 */
const spliceCells = (
  source: string,
  parent: YAMLMap,
  children: unknown,
  earlier: readonly YAMLMap[],
  entries: readonly Record<string, unknown>[]
): string => {
  const keyColumn = columnOf(source, (parent.range ?? [0])[0]);
  const ensureNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);
  const seq = isSeq(children) ? children : null;
  if (seq && !seq.flow && seq.items.length > 0) {
    const first = seq.items[0] as YamlNode;
    const dashColumn = columnOf(source, (first.range ?? [0])[0]) - 2;
    const block = cellsText(entries, dashColumn);
    if (earlier.length > 0) {
      // Out with the earlier run's cells, the new ones where the first of them was.
      const spans = earlier
        .map(item => {
          const range = item.range ?? [0, 0, 0];
          return [lineStartOf(source, range[0]), nextLineStart(source, range[1])] as const;
        })
        .sort((a, b) => a[0] - b[0]);
      let out = source;
      for (const [from, to] of [...spans].reverse()) out = out.slice(0, from) + out.slice(to);
      const at = spans[0][0];
      return out.slice(0, at) + block + out.slice(at);
    }
    const last = seq.items[seq.items.length - 1] as YamlNode;
    const at = nextLineStart(source, (last.range ?? [0, 0])[1]);
    return ensureNewline(source.slice(0, at)) + block + source.slice(at);
  }
  const block = cellsText(entries, keyColumn + 2);
  if (seq) {
    // `children: []`: a block of the cells instead (a flow list with nodes in it is refused first).
    const range = seq.range ?? [0, 0, 0];
    const end = nextLineStart(source, range[1]);
    return `${source.slice(0, range[0]).trimEnd()}\n${block}${source.slice(end)}`;
  }
  // `children:` with nothing after it (null): that line becomes the block's head.
  const pair = parent.items.find(
    item => (isScalar(item.key) ? item.key.value : item.key) === 'children'
  );
  if (pair && isScalar(pair.key) && pair.key.range) {
    const from = lineStartOf(source, pair.key.range[0]);
    const to = nextLineStart(source, pair.key.range[1]);
    return `${source.slice(0, from)}${' '.repeat(keyColumn)}children:\n${block}${source.slice(to)}`;
  }
  // No `children:` at all: one after the parent's last key.
  const end = nextLineStart(source, (parent.range ?? [0, 0])[1]);
  return `${ensureNewline(source.slice(0, end))}${' '.repeat(keyColumn)}children:\n${block}${source.slice(end)}`;
};

export const runGridCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseGridArgs(argv);
  if (parsed === 'help') {
    io.stdout(COMMAND_USAGE.grid);
    return 0;
  }
  if ('error' in parsed) {
    io.stderr(`pix3 grid: ${parsed.error}\n\n${COMMAND_USAGE.grid}`);
    return 2;
  }
  const args = parsed;
  const project = resolveProjectRoot(io.cwd, args.project);
  if ('error' in project) {
    io.stderr(`pix3 grid: ${project.error}\n`);
    return 2;
  }
  const root = project.root;
  const locate = (requested: string): string =>
    /^res:\/\//i.test(requested)
      ? join(root, requested.replace(/^res:\/\//i, ''))
      : isAbsolute(requested)
        ? requested
        : ([join(root, requested), resolve(io.cwd, requested)].find(path => existsSync(path)) ??
          join(root, requested));
  const toRes = (absolute: string): string => {
    const rel = relative(root, absolute);
    return rel.startsWith('..') || isAbsolute(rel) ? absolute : `res://${rel.split(sep).join('/')}`;
  };

  const sceneFile = locate(args.scene);
  const text = readTextOrNull(sceneFile);
  if (text === null) {
    io.stderr(`pix3 grid: the scene ${sceneFile} does not exist\n`);
    return 2;
  }
  const prefabFile = locate(args.prefab);
  const prefabRes = toRes(prefabFile);
  if (!prefabRes.startsWith('res://')) {
    io.stderr(`pix3 grid: the prefab ${prefabFile} is outside the project\n`);
    return 2;
  }
  const prefab = readPrefabRoot(prefabFile);
  if (typeof prefab === 'string') {
    io.stderr(`pix3 grid: ${prefab}\n`);
    return 2;
  }
  const step =
    args.step ??
    (prefab.width !== undefined && prefab.height !== undefined
      ? { x: prefab.width, y: prefab.height }
      : null);
  if (!step) {
    io.stderr(
      `pix3 grid: the prefab's root has no width / height to space the cells by; give --step W[xH]\n`
    );
    return 2;
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    io.stderr(`pix3 grid: ${toRes(sceneFile)} is not valid YAML: ${doc.errors[0].message}\n`);
    return 1;
  }
  const nodes = nodesOf(doc);
  const parentNode = nodes.find(node => node.id === args.parent);
  if (!parentNode) {
    io.stderr(
      `pix3 grid: no node "${args.parent}" in ${toRes(sceneFile)} (pix3 tree ${toRes(sceneFile)} lists them)\n`
    );
    return 2;
  }
  if (parentNode.map.get('instance') !== undefined) {
    io.stderr(
      `pix3 grid: "${args.parent}" is a prefab instance; put the cells under a node of this scene (a Group2D)\n`
    );
    return 2;
  }

  const idPattern = args.id ?? `${prefab.id}-{row}-{col}`;
  const namePattern = args.name ?? `${prefab.name} {row}-{col}`;
  const cells: { id: string; position: [number, number] }[] = [];
  const entries: Record<string, unknown>[] = [];
  for (let row = 0; row < args.rows; row += 1) {
    for (let col = 0; col < args.cols; col += 1) {
      const cell = { row, col, i: row * args.cols + col };
      // Centred on the parent's origin; row 0 at the top (Y up), col 0 on the left.
      const position: [number, number] = [
        round((col - (args.cols - 1) / 2) * step.x),
        round(((args.rows - 1) / 2 - row) * step.y),
      ];
      const overrides = merge(
        fill(args.props, cell),
        (row + col) % 2 === 1 ? fill(args.checker, cell) : {}
      );
      const { transform: transformOverride, ...rest } = overrides;
      const transform = merge(
        { position },
        (transformOverride as Record<string, unknown> | undefined) ?? {}
      );
      const id = fill(idPattern, cell);
      cells.push({ id, position });
      entries.push({
        id,
        name: fill(namePattern, cell),
        instance: prefabRes,
        properties: { transform, ...rest },
      });
    }
  }
  if (new Set(cells.map(cell => cell.id)).size !== cells.length) {
    io.stderr(`pix3 grid: --id "${idPattern}" gives two cells one id; use {row} and {col}\n`);
    return 2;
  }

  // What an earlier run wrote under this parent (ids of the pattern) goes on --replace.
  const children = parentNode.map.get('children', true);
  const ownPattern = patternRegex(idPattern);
  const earlier = isSeq(children)
    ? children.items.filter(
        (item): item is YAMLMap => isMap(item) && ownPattern.test(String(item.get('id') ?? ''))
      )
    : [];
  if (earlier.length > 0 && !args.replace) {
    io.stderr(
      `pix3 grid: "${args.parent}" already holds ${earlier.length} node(s) with ids like "${idPattern}" (${String(earlier[0].get('id'))}); --replace rewrites them (nothing was written)\n`
    );
    return 1;
  }
  const replaced = new Set(earlier);
  const taken = new Set(nodes.filter(node => !replaced.has(node.map)).map(node => node.id));
  const clash = cells.find(cell => taken.has(cell.id));
  if (clash) {
    io.stderr(
      `pix3 grid: the id "${clash.id}" is already used in ${toRes(sceneFile)}; pick another --id pattern (nothing was written)\n`
    );
    return 1;
  }

  if (isSeq(children) && children.flow && children.items.length > 0) {
    io.stderr(
      `pix3 grid: "${args.parent}" lists its children in a flow list ([...]); write them as a block list first (nothing was written)\n`
    );
    return 1;
  }
  const output = spliceCells(text, parentNode.map, children, earlier, entries);
  const summary = {
    scene: toRes(sceneFile),
    parent: args.parent,
    prefab: prefabRes,
    rows: args.rows,
    cols: args.cols,
    step,
    first: cells[0].id,
    last: cells[cells.length - 1].id,
    written: cells.length,
    replaced: earlier.length,
    dryRun: args.dryRun,
  };
  if (!args.dryRun) writeAtomic(sceneFile, output);
  if (args.json) {
    io.stdout(`${JSON.stringify(args.dryRun ? { ...summary, text: output } : summary, null, 2)}\n`);
    return 0;
  }
  if (args.dryRun) io.stdout(output);
  io.stdout(
    `${args.dryRun ? 'Would write' : 'Wrote'} ${cells.length} instance(s) of ${prefabRes} under #${args.parent} in ${toRes(sceneFile)}: ${args.cols}×${args.rows}, step ${step.x}×${step.y}, ${cells[0].id} … ${cells[cells.length - 1].id}${earlier.length ? ` (replaced ${earlier.length})` : ''}.\n`
  );
  return 0;
};
