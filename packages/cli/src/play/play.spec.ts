// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePlayArgs, runPlayCli, safeAreaOverlayScript } from './command.ts';
import { formatProfileHuman, type PlayProfile } from './profile-report.ts';
import { formatTreeHuman } from './tree-report.ts';

/**
 * `pix3 play`'s refusals, which happen before a browser starts. The run itself (a private headless
 * Chrome, the page booted, a policy ticked by the runner, the report) needs a Chrome and is checked
 * by hand against a starter: `pix3 play dist --bot <name>`, `pix3 play --bot <name>` and the same
 * with `--run '<pix3_game_run params>'` (the S3 parity runs of `.plans/done/play-in-page.md`).
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
    expect(result.out).toContain('--profile');
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
    const motion = parsePlayArgs(['dist', '--reduced-motion', '--seed', '3']);
    expect(typeof motion === 'object' && 'run' in motion ? motion.run : null).toEqual({
      seed: 3,
      reducedMotion: true,
    });
    expect((await run(['--config', '[1]'])).err).toContain('--config takes one JSON object');
    const runOf = (argv: string[]) => {
      const parsed = parsePlayArgs(argv);
      return typeof parsed === 'object' && 'run' in parsed ? parsed.run : parsed;
    };
    expect(runOf(['dist', '--storage', 'memory'])).toEqual({ storage: 'memory' });
    const snapshot = { version: 2, data: { best: 10 } };
    expect(runOf(['dist', `--storage=${JSON.stringify(snapshot)}`])).toEqual({
      storage: { snapshot },
    });
    writeFileSync(join(root, 'save.json'), JSON.stringify(snapshot));
    expect(runOf(['dist', '--storage', join(root, 'save.json')])).toEqual({
      storage: { snapshot },
    });
    expect((await run(['--storage', '{"best":10}'])).err).toContain('--storage takes memory');
    expect((await run(['--storage', join(root, 'nope.json')])).err).toContain('(no file');
    expect(runOf(['dist', '--ads', 'reward'])).toEqual({ ads: 'reward' });
    expect(runOf(['dist', '--ads=reward,skip,unavailable'])).toEqual({
      ads: ['reward', 'skip', 'unavailable'],
    });
    expect((await run(['--ads', 'reward,maybe'])).err).toContain('--ads takes reward');
    expect((await run(['--safe-area', '47,0,34'])).err).toContain(
      '--safe-area takes top,right,bottom,left'
    );

    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const policy = await run(['dist', '--bot', 'missing']);
    expect(policy.code).toBe(2);
    expect(policy.err).toContain(join('design', 'tests', 'bots', 'missing.ts'));

    // --run takes pix3_game_run's params; its policy is checked before Chrome starts, and a run
    // is either a --run or a --bot (play-in-page S3).
    expect((await run(['dist', '--run', '[1]'])).err).toContain('--run takes the params');
    expect((await run(['dist', '--run', '{}', '--bot', 'x'])).err).toContain('--bot and --run');
    const runPolicy = await run(['dist', '--run', '{"bot":{"name":"gone"}}']);
    expect(runPolicy.code).toBe(2);
    expect(runPolicy.err).toContain(join('design', 'tests', 'bots', 'gone.ts'));
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

  it('prints a profile: per tick and per frame apart, the software GPU called out', () => {
    const stats = (mean: number) => ({
      count: 10,
      mean,
      p50: mean,
      p95: mean,
      p99: mean,
      max: mean,
    });
    const profile: PlayProfile = {
      window: {
        warmup: { seconds: 1, frames: 5, ticks: 20 },
        seconds: 5,
        frames: 30,
        painted: 30,
        ticks: 120,
        ticksPerFrame: 4,
        fps: 6,
        timeMode: { mode: 'fixed', fixedDeltaSec: 1 / 60, ticksPerFrame: 4, renderEveryNTicks: 4 },
        gaps: 2,
      },
      frame: { ...stats(160), long: 30, longPercent: 100 },
      work: stats(18),
      logicPerTick: stats(1.5),
      logicPerFrame: stats(6),
      render: stats(12),
      activities: [
        { label: 'Islands', perTick: { mean: 0.4, max: 2 }, perFrameMean: 1.6, ticks: 120 },
      ],
      renderer: {
        sampled: 30,
        calls: { mean: 140, max: 290 },
        triangles: { mean: 26_700, max: 48_100 },
        last: { calls: 140, triangles: 26_700, geometries: 267, textures: 46, programs: 11 },
        programsLinked: 2,
      },
      heapMb: { start: 35, end: 36, peak: 40 },
      longAnimationFrames: {
        supported: true,
        count: 3,
        worst: [{ durationMs: 700, blockingMs: 650, script: null }],
      },
      device: {
        gpu: 'ANGLE (SwiftShader Device)',
        devicePixelRatio: 1,
        viewport: '1280×748',
        cores: 4,
      },
      softwareGpu: true,
    };
    const text = formatProfileHuman(profile).join('\n');
    expect(text).toContain('logic / tick');
    expect(text).toContain('logic / frame (4.0 ticks)');
    expect(text).toContain('2 interval(s) across a pause dropped');
    expect(text).toContain('Islands');
    expect(text).toContain('draw calls 140.0 mean / 290 max');
    expect(text).toContain('2 linked while measured');
    expect(text).toContain('SOFTWARE GPU');
    expect(text).toContain('outside the runner: 142.0 ms');
    expect(formatProfileHuman({ error: 'x' })).toEqual(['profile: not measured — x']);
  });

  it('prints the live tree: nodes by id, run-time objects by name, instances and hidden marked', () => {
    const leaf = { children: [], more: 0, visible: true, instances: null };
    const text = formatTreeHuman({
      count: 4,
      truncated: true,
      roots: [
        {
          ...leaf,
          id: 'world',
          nodeId: 'world',
          type: 'Node3D',
          name: 'World',
          more: 3,
          children: [
            { ...leaf, id: 'a', nodeId: null, type: 'Mesh', name: 'fog-puffs', instances: 1245 },
            { ...leaf, id: 'b', nodeId: 'hud', type: 'Group2D', name: 'hud', visible: false },
          ],
        },
      ],
    });
    expect(text).toEqual([
      'tree: 4 object(s), capped',
      '  Node3D#world "World" (+3 more)',
      '    Mesh "fog-puffs" ×1245',
      '    Group2D#hud hidden',
    ]);
    expect(formatTreeHuman({ error: 'the game is failed' })).toEqual([
      'tree: not read — the game is failed',
    ]);
  });
});
