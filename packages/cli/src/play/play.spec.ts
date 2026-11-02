// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPlayCli, safeAreaOverlayScript } from './command.ts';

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

    // A test run's seed and config are injected into the page, so dist takes them too (game13).
    // `dev` is the dev server: with none running the answer says so.
    const devSeed = await run(['dev', '--seed', '7']);
    expect(devSeed.err).toContain('no dev server is running');
    expect((await run(['--seed', 'x'])).err).toContain('--seed takes a whole number');
    expect((await run(['--config', '[1]'])).err).toContain('--config takes one JSON object');
    expect((await run(['--safe-area', '47,0,34'])).err).toContain(
      '--safe-area takes top,right,bottom,left'
    );

    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const policy = await run(['dist', '--bot', 'missing']);
    expect(policy.code).toBe(2);
    expect(policy.err).toContain(join('design', 'tests', 'bots', 'missing.ts'));
  });

  it('shades the unsafe bands for a picture and takes them off again (core-tests/game18)', async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    const evaluate = (script: string): unknown =>
      new window.Function('document', `return ${script}`)(window.document);
    const insets = { top: 47, right: 0, bottom: 34, left: 0 };
    expect(evaluate(safeAreaOverlayScript(insets, true))).toBe(true);
    const host = window.document.getElementById('__pix3_safe_area__') as unknown as HTMLElement;
    expect(host.style.pointerEvents).toBe('none');
    const bands = [...host.children].map(band => (band as HTMLElement).style);
    expect(bands.map(band => band.height)).toEqual(['47px', '34px']);
    expect(bands[0].top).toBe('0px');
    expect(bands[1].bottom).toBe('0px');
    evaluate(safeAreaOverlayScript(insets, false));
    expect(window.document.getElementById('__pix3_safe_area__')).toBeNull();
    await window.happyDOM.close();
  });
});
