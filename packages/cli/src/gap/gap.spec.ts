// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { detectAgent, GAPS_FILE, parseGapArgs, readGaps, runGapCli } from './command.ts';

/** `pix3 gap` (plan §G.3, §G.4): one JSON object per line in `.pix3/gaps.jsonl`, append-only. */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-gap-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const project = (): string => {
  const root = join(scratch, `p${++counter}`);
  mkdirSync(join(root, 'scenes'), { recursive: true });
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
  return root;
};
const io = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      cwd,
      env,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      now: () => new Date('2026-10-10T12:00:00.000Z'),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
};

describe('pix3 gap', () => {
  it('appends one record per call, from any folder of the project', () => {
    const root = project();
    const first = io(join(root, 'scenes'), { CLAUDECODE: '1' });
    expect(
      runGapCli(
        [
          'no node for a 9-slice panel',
          '--kind',
          'node',
          '--detail',
          'built it from 9 Sprite2D\nby hand',
          '--context',
          'scenes/ui/shop.pix3scene',
        ],
        first.io
      )
    ).toBe(0);
    expect(first.out()).toBe(`Recorded in ${GAPS_FILE}: [node] no node for a 9-slice panel\n`);
    expect(runGapCli(['  pix3_scene has\n no filter by type '], io(root).io)).toBe(0);
    const lines = readFileSync(join(root, GAPS_FILE), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({
      ts: '2026-10-10T12:00:00.000Z',
      agent: 'claude-code',
      kind: 'node',
      summary: 'no node for a 9-slice panel',
      detail: 'built it from 9 Sprite2D\nby hand',
      context: 'scenes/ui/shop.pix3scene',
    });
    // Key order is the schema's; optional keys are absent, not null.
    expect(lines[1]).toBe(
      '{"ts":"2026-10-10T12:00:00.000Z","kind":"other","summary":"pix3_scene has no filter by type"}'
    );
    const list = io(root);
    expect(runGapCli(['--list'], list.io)).toBe(0);
    expect(list.out()).toContain('node       [claude-code] no node for a 9-slice panel');
    expect(readGaps(root)).toHaveLength(2);
  });

  it('refuses what is not a gap record, and outside a project', () => {
    const root = project();
    const bad = (argv: string[]) => {
      const run = io(root);
      expect(runGapCli(argv, run.io)).toBe(1);
      return run.err();
    };
    expect(bad([])).toContain('say what was missing');
    expect(bad(['x', '--kind', 'wish'])).toContain(
      '--kind is one of capability, tool, node, doc, other'
    );
    expect(bad(['a', 'b'])).toContain('one summary only');
    expect(bad(['x'.repeat(201)])).toContain('at most 200');
    expect(bad(['x', '--what'])).toContain('unknown option');
    expect(readGaps(root)).toEqual([]);
    const outside = io(scratch);
    expect(runGapCli(['x'], outside.io)).toBe(2);
  });

  it('skips a torn line when reading; tells the agent from its environment', () => {
    const root = project();
    mkdirSync(join(root, '.pix3'), { recursive: true });
    writeFileSync(join(root, GAPS_FILE), '{"ts":"t","kind":"doc","summary":"a"}\n{"ts":\n');
    expect(readGaps(root)).toEqual([{ ts: 't', kind: 'doc', summary: 'a' }]);
    expect(detectAgent({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
    expect(detectAgent({})).toBeUndefined();
    expect(parseGapArgs(['x', '--agent', 'cursor'])).toMatchObject({ agent: 'cursor' });
  });
});
