// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runGridCli } from './command.ts';

/**
 * `pix3 grid` writes a board's cells into a scene as plain YAML (core-tests/game18 typed 64 of
 * them): positions centred on the parent, row 0 on top, the checker overrides, the refusal and the
 * --replace rewrite — and every byte of the file outside the cells left as written.
 */

let root: string;

const PREFAB = `version: 1.0.0
root:
  - id: cell
    type: Sprite2D
    name: Cell
    properties:
      width: 124
      height: 124
    children: []
`;

const scene = (children: string): string => `# The board. Comments stay.
version: 1.0.0
root:
  - id: board
    type: Group2D
    name: Board
    properties:
      transform: { position: [0, -60], scale: [1, 1] }
      texture: { type: texture, url: 'res://sprites/frame.svg' }
${children}  - id: hud
    type: Group2D
    name: HUD
`;

const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runGridCli(argv, {
    cwd: root,
    stdout: text => void out.push(text),
    stderr: text => void err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
};

const sceneFile = () => join(root, 'scenes', 'main.pix3scene');
const read = () => readFileSync(sceneFile(), 'utf8');
type Node = { id: string; instance?: string; properties?: Record<string, unknown> };
const cellsOf = (parentId: string): Node[] => {
  const doc = parse(read()) as { root: (Node & { children?: Node[] })[] };
  return doc.root.find(node => node.id === parentId)?.children ?? [];
};

const BASE = [
  'scenes/main.pix3scene',
  '--parent',
  'board',
  '--prefab',
  'res://scenes/cell.pix3scene',
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-grid-'));
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
  mkdirSync(join(root, 'scenes'));
  writeFileSync(join(root, 'scenes', 'cell.pix3scene'), PREFAB);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pix3 grid', () => {
  it('writes rows × cols instances centred on the parent, row 0 on top (core-tests/game18)', async () => {
    writeFileSync(sceneFile(), scene('    children: []\n'));
    const before = read();
    const B = '{"texture":{"type":"texture","url":"res://sprites/cell-b.svg"}}';
    const result = await run([...BASE, '--size', '3x2', '--checker', B]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Wrote 6 instance(s)');

    const cells = cellsOf('board');
    expect(cells.map(cell => cell.id)).toEqual([
      'cell-0-0',
      'cell-0-1',
      'cell-0-2',
      'cell-1-0',
      'cell-1-1',
      'cell-1-2',
    ]);
    // The step is the prefab root's size; Y up, so row 0 is the positive one.
    expect(cells[0].properties?.transform).toEqual({ position: [-124, 62] });
    expect(cells[5].properties?.transform).toEqual({ position: [124, -62] });
    expect(cells[0].instance).toBe('res://scenes/cell.pix3scene');
    // Odd row + col gets the checker overrides.
    expect(cells[1].properties?.texture).toEqual({
      type: 'texture',
      url: 'res://sprites/cell-b.svg',
    });
    expect(cells[0].properties?.texture).toBeUndefined();

    // Spliced, not re-printed: everything but `children: []` is the file as it was written.
    const text = read();
    expect(text).toContain('\n    children:\n      - id: cell-0-0\n        name: Cell 0-0\n');
    expect(text).toContain(
      '    properties:\n      transform: { position: [0, -60], scale: [1, 1] }'
    );
    expect(text).toContain("texture: { type: texture, url: 'res://sprites/cell-b.svg' }");
    expect(text.replace(/\n {4}children:\n(?: {6}.*\n)+/, '\n    children: []\n')).toBe(before);
  });

  it('refuses to write over an earlier run, rewrites it with --replace, and keeps other children', async () => {
    writeFileSync(
      sceneFile(),
      scene('    children:\n      - id: frame\n        type: Sprite2D\n        name: Frame\n')
    );
    expect((await run([...BASE, '--size', '2x2'])).code).toBe(0);
    expect(cellsOf('board').map(cell => cell.id)).toEqual([
      'frame',
      'cell-0-0',
      'cell-0-1',
      'cell-1-0',
      'cell-1-1',
    ]);
    const again = await run([...BASE, '--size', '2x2']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('--replace rewrites them (nothing was written)');

    const replaced = await run([...BASE, '--size', '3x1', '--step', '100', '--replace']);
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain('(replaced 4)');
    const cells = cellsOf('board');
    expect(cells.map(cell => cell.id)).toEqual(['frame', 'cell-0-0', 'cell-0-1', 'cell-0-2']);
    expect(cells[1].properties?.transform).toEqual({ position: [-100, 0] });
  });

  it('adds a children: block to a node that has none, and fills {row} {col} {i}', async () => {
    writeFileSync(sceneFile(), scene(''));
    const result = await run([
      ...BASE,
      '--rows',
      '1',
      '--cols',
      '2',
      '--id',
      'slot-{i}',
      '--name',
      'Slot {row}/{col}',
      '--props',
      '{"label":"Level {i}"}',
    ]);
    expect(result.code).toBe(0);
    const cells = cellsOf('board') as (Node & { name: string })[];
    expect(cells.map(cell => [cell.id, cell.name, cell.properties?.label])).toEqual([
      ['slot-0', 'Slot 0/0', 'Level 0'],
      ['slot-1', 'Slot 0/1', 'Level 1'],
    ]);
    // The HUD after it is still its own root.
    expect((parse(read()) as { root: Node[] }).root.map(node => node.id)).toEqual(['board', 'hud']);
  });

  it('refuses what it cannot do well, and writes nothing', async () => {
    writeFileSync(sceneFile(), scene('    children: []\n'));
    const before = read();
    const elsewhere = ['scenes/main.pix3scene', '--parent', 'nope', ...BASE.slice(3)];
    const cases: [string[], string][] = [
      [[...BASE.slice(0, 3), '--size', '2x2'], '--prefab'],
      [[...BASE, '--size', '40x40'], 'spawn them from a script'],
      [[...BASE, '--size', '2x2', '--id', 'cell'], 'names every cell alike'],
      [[...elsewhere, '--size', '2x2'], 'no node "nope"'],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv);
      expect(result.code).toBeGreaterThan(0);
      expect(result.err).toContain(message);
    }
    expect(read()).toBe(before);
    // The ids are the scene's: cells of the same pattern under another node clash.
    expect((await run([...BASE, '--size', '1x1'])).code).toBe(0);
    const underHud = ['scenes/main.pix3scene', '--parent', 'hud', ...BASE.slice(3)];
    const clash = await run([...underHud, '--size', '1x1']);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('"cell-0-0" is already used');
  });
});
