// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPlayCli } from './command.ts';

/**
 * `pix3 play`'s refusals, which happen before a browser starts. The run itself (a private headless
 * Chrome, the page booted, a policy ticked by the runner, the report) needs a Chrome and is checked
 * by hand against a starter: `pix3 play dist --bot <name>` and `pix3 play --bot <name>`.
 */

let root: string;

const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPlayCli(argv, {
    cwd: root,
    stdout: text => void out.push(text),
    stderr: text => void err.push(text),
    env: { PIX3_HOME: join(root, '.home') },
  });
  return { code, out: out.join(''), err: err.join('') };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-play-'));
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pix3 play', () => {
  it('prints its help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: pix3 play');
  });

  it('refuses when there is nothing to play, a bad size, or no such policy', async () => {
    const nothing = await run([]);
    expect(nothing.code).toBe(2);
    expect(nothing.err).toContain('nothing to play');

    expect((await run(['--size', 'phone'])).code).toBe(2);
    // A bot's budget is game frames (core-tests/game9): a whole positive number.
    const frames = await run(['--bot', 'x', '--frames', '0']);
    expect(frames.code).toBe(2);
    expect(frames.err).toContain('--frames takes a positive whole number');
    const badArgs = await run(['--bot', 'x', '--bot-args', '[1]']);
    expect(badArgs.code).toBe(2);
    expect(badArgs.err).toContain('--bot-args takes one JSON object');

    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const policy = await run(['dist', '--bot', 'missing']);
    expect(policy.code).toBe(2);
    expect(policy.err).toContain(join('design', 'tests', 'bots', 'missing.ts'));
  });
});
