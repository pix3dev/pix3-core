// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { decodePng, encodePng } from '../image/png.ts';
import { runSliceCli, type SliceResult } from './command.ts';

/**
 * The fixtures are real Codex sheets from Skyways, cropped and downscaled (nearest neighbour, so
 * the generator's speckle at alpha 13–40 and the dark glow at alpha ≤ 12 survive):
 * `icons-ui.png` four icons, `icons-reasons.png` six (one needs a join to stay whole),
 * `islands-keyed.png` three islands on an opaque navy backdrop. The expected boxes are what
 * Skyways' own slicer (`design/tools/slice-icons.py`, scipy) gives on the same files.
 */
const FIXTURES = join(import.meta.dirname, '..', 'image', 'fixtures');
const scratch = mkdtempSync(join(tmpdir(), 'pix3-slice-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let runs = 0;
const run = (args: string[], cwd?: string) => {
  const dir = cwd ?? join(scratch, `run-${++runs}`);
  mkdirSync(dir, { recursive: true });
  const out = { stdout: '', stderr: '' };
  const code = runSliceCli(args, {
    cwd: dir,
    stdout: text => void (out.stdout += text),
    stderr: text => void (out.stderr += text),
  });
  return { code, ...out, dir };
};
const json = (args: string[], cwd?: string) => {
  const result = run([...args, '--json'], cwd);
  expect(result.stderr).toBe('');
  return { ...result, report: JSON.parse(result.stdout) as SliceResult };
};
const boxes = (report: SliceResult) =>
  report.frames.map(f => [f.box.x, f.box.y, f.box.width, f.box.height]);

describe('pix3 slice --blobs', () => {
  it('finds the icons of a Codex sheet in reading order, as the Skyways slicer does', () => {
    const { report } = json([
      join(FIXTURES, 'icons-ui.png'),
      '--blobs',
      '--join',
      '2',
      '--dry-run',
    ]);
    expect(report.key).toBe('alpha');
    expect(report.written).toBe(false);
    // slice-icons.py --join=2 prints the joined region; ours is the region trimmed to the content.
    const regions = [
      [4, 11, 53, 54],
      [69, 11, 45, 52],
      [3, 69, 54, 54],
      [60, 75, 61, 42],
    ];
    expect(report.frames).toHaveLength(4);
    boxes(report).forEach(([x, y, w, h], i) => {
      const [rx, ry, rw, rh] = regions[i];
      expect(x).toBeGreaterThanOrEqual(rx);
      expect(y).toBeGreaterThanOrEqual(ry);
      expect(x + w).toBeLessThanOrEqual(rx + rw);
      expect(y + h).toBeLessThanOrEqual(ry + rh);
      // Trimmed by at most the join (2) on a side.
      expect(rw - w).toBeLessThanOrEqual(4);
      expect(rh - h).toBeLessThanOrEqual(4);
    });
  });

  it('joins parts closer than --join into one frame; a smaller join splits them', () => {
    const sheet = join(FIXTURES, 'icons-reasons.png');
    expect(json([sheet, '--blobs', '--join', '2', '--dry-run']).report.frames).toHaveLength(6);
    expect(json([sheet, '--blobs', '--join', '1', '--dry-run']).report.frames).toHaveLength(7);
    const counted = run([sheet, '--blobs', '--join', '1', '--count', '8', '--dry-run']);
    expect(counted.code).toBe(1);
    expect(counted.stderr).toMatch(/found 7 frames, expected 8/);
  });

  it('writes trimmed, padded frames with no haze, speckle or neighbour pixels', () => {
    const { report, dir } = json([
      join(FIXTURES, 'icons-reasons.png'),
      '--blobs',
      '--join',
      '2',
      '--out',
      'icons',
    ]);
    expect(report.frames.map(f => f.file)).toEqual(
      [1, 2, 3, 4, 5, 6].map(n => `icons/icons-reasons_0${n}.png`)
    );
    for (const frame of report.frames) {
      const image = decodePng(readFileSync(join(dir, frame.file)));
      expect([image.width, image.height]).toEqual([frame.box.width + 4, frame.box.height + 4]);
      let faint = 0;
      for (let i = 3; i < image.data.length; i += 4) {
        if (image.data[i] > 0 && image.data[i] <= 12) faint++;
      }
      expect(faint).toBe(0);
      // The 2-px pad is empty on every side.
      for (let x = 0; x < image.width; x++) {
        expect(image.data[(x + image.width) * 4 + 3]).toBe(0);
        expect(image.data[((image.height - 2) * image.width + x) * 4 + 3]).toBe(0);
      }
    }
    const again = run(
      [join(FIXTURES, 'icons-reasons.png'), '--blobs', '--join', '2', '--out', 'icons'],
      dir
    );
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/6 frame file\(s\) exist .* --force replaces them/);
  });

  it('names frames with --names and keys an opaque backdrop out from the border', () => {
    const { report, dir } = json([
      join(FIXTURES, 'islands-keyed.png'),
      '--blobs',
      '--join',
      '2',
      '--names',
      'small,medium,large',
      '--out',
      'named',
    ]);
    expect(report.key).toBe('#303050');
    expect(report.frames.map(f => f.file)).toEqual([
      'named/small.png',
      'named/medium.png',
      'named/large.png',
    ]);
    const image = decodePng(readFileSync(join(dir, report.frames[0].file)));
    // Corners are backdrop (keyed), the middle is island (opaque).
    expect(image.data[3]).toBe(0);
    expect(image.data[((image.height >> 1) * image.width + (image.width >> 1)) * 4 + 3]).toBe(255);
  });
});

describe('pix3 slice --grid', () => {
  it('cuts equal cells and skips the empty ones', () => {
    const { report } = json([join(FIXTURES, 'islands-keyed.png'), '--grid', '4x1', '--dry-run']);
    // 217 px / 4: the fourth cell (163–217) holds part of the third island, so none is empty.
    expect(boxes(report)).toEqual([
      [0, 0, 54, 72],
      [54, 0, 55, 72],
      [109, 0, 54, 72],
      [163, 0, 54, 72],
    ]);
    // A 3×1 sheet of 10-px cells with a dot in the first and the last.
    const dir = join(scratch, 'grid');
    mkdirSync(dir, { recursive: true });
    const data = new Uint8Array(30 * 10 * 4);
    for (const x of [4, 24]) data.set([200, 50, 50, 255], (5 * 30 + x) * 4);
    data[(5 * 30 + 14) * 4 + 3] = 40; // speckle in the middle cell: not solid
    writeFileSync(join(dir, 'dots.png'), encodePng({ width: 30, height: 10, data }));
    const dots = json(['dots.png', '--grid', '3x1', '--out', 'cells'], dir).report;
    expect(dots.frames.map(f => f.file)).toEqual(['cells/dots_01.png', 'cells/dots_02.png']);
    expect(boxes(dots)).toEqual([
      [0, 0, 10, 10],
      [20, 0, 10, 10],
    ]);
    expect(dots.warnings).toEqual(['cell 2 (row 1) is empty — skipped']);
  });
});

describe('pix3 slice --anim', () => {
  it('writes the frames and a sequence-mode .pix3anim, one clip per sheet', () => {
    const project = join(scratch, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'pix3project.yaml'), 'name: Slice\n');
    cpSync(join(FIXTURES, 'icons-ui.png'), join(project, 'sheet.png'));
    const first = json(
      ['sheet.png', '--blobs', '--join', '2', '--anim', 'spin', '--fps', '8'],
      project
    ).report;
    expect(first.anim).toBe('sprites/spin/spin.pix3anim');
    expect(first.frames.map(f => f.file)).toEqual(
      [1, 2, 3, 4].map(n => `sprites/spin/spin_000${n}.png`)
    );
    // One canvas for every frame.
    expect(new Set(first.frames.map(f => `${f.width}x${f.height}`)).size).toBe(1);
    json(['sheet.png', '--grid', '2x2', '--anim', 'spin', '--clip', 'idle'], project);
    const anim = JSON.parse(readFileSync(join(project, 'sprites/spin/spin.pix3anim'), 'utf8'));
    expect(anim.texturePath).toBe('');
    expect(anim.clips.map((c: { name: string; fps: number }) => [c.name, c.fps])).toEqual([
      ['spin', 8],
      ['idle', 12],
    ]);
    expect(anim.clips[1].frames[0]).toEqual({
      texturePath: 'res://sprites/spin/idle_0001.png',
      sourceSize: { width: 62, height: 63 },
    });
  });

  it('needs a project for res:// paths', () => {
    const result = run([join(FIXTURES, 'icons-ui.png'), '--blobs', '--anim', 'spin', '--out', 'x']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--anim needs the frames inside a Pix3 project/);
  });
});

describe('pix3 slice arguments', () => {
  it.each([
    [[], /name one sheet PNG/],
    [['a.png'], /--grid <cols>x<rows> or --blobs/],
    [['a.png', '--grid', '3x', '--blobs'], /--grid <cols>x<rows> or --blobs/],
    [['a.png', '--grid', '0x2'], /--grid takes/],
    [['a.png', '--grid', '2x2', '--join', '4'], /--join goes with --blobs/],
    [['a.png', '--blobs', '--key', 'red'], /--key takes auto or #rrggbb/],
    [['a.png', '--blobs', '--names', 'a,b', '--count', '3'], /--count 3 disagrees with 2 --names/],
    [['a.png', '--blobs', '--fps', '10'], /--clip and --fps go with --anim/],
    [['a.png', '--blobs', '--wat'], /unknown option --wat/],
  ])('%j is a usage error', (args, message) => {
    const result = run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
  });

  it('reports an unreadable sheet', () => {
    const dir = join(scratch, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.png'), 'not a png');
    const result = run(['x.png', '--blobs'], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/x\.png: not a PNG/);
  });
});
