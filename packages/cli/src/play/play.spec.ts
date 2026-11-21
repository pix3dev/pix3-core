// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePlayArgs, runPlayCli, safeAreaOverlayScript } from './command.ts';
import { formatProfileHuman, type PlayProfile } from './profile-report.ts';
import { checkScreens, screensSheetHtml, selectScreens } from './screens.ts';
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
  it('--screens: the gallery of design/tests/screens.ts, refused before Chrome starts', async () => {
    const parsed = parsePlayArgs([
      '--screens',
      '--only',
      'menu,shop',
      '--locale',
      'all',
      '--size',
      '390x844,360x640@1',
    ]);
    expect(typeof parsed === 'object' && 'screens' in parsed ? parsed.screens : null).toMatchObject(
      {
        only: ['menu', 'shop'],
        locales: 'all',
        sizes: [{ label: 'size=390x844' }, { label: 'size=360x640@1' }],
      }
    );
    // Sizes and locales multiply the states; they are not a grid needing a bot.
    expect(typeof parsed === 'object' && 'grid' in parsed ? parsed.grid : 'x').toBeNull();
    expect((await run(['--screens', '--seed', '3'])).err).toContain('drop --seed');
    expect((await run(['--screens', '--bot', 'x'])).err).toContain('drop --bot');
    expect((await run(['--only', 'menu'])).err).toContain('give it --screens');
    expect((await run(['--bot', 'x', '--locale', 'all'])).err).toContain(
      '--locale all is for --screens'
    );

    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const none = await run(['dist', '--screens']);
    expect(none.code).toBe(2);
    expect(none.err).toContain('no design/tests/screens.ts');
    mkdirSync(join(root, 'design', 'tests', 'bots'), { recursive: true });
    writeFileSync(
      join(root, 'design', 'tests', 'screens.ts'),
      "const empty: Record<string, unknown> = {};\nexport default [{ name: 'menu', overrides: empty }, { name: 'shop', overrides: {}, policy: 'to-shop' }];\n"
    );
    const unknown = await run(['dist', '--screens', '--only', 'result']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('no screen result');
    const policy = await run(['dist', '--screens']);
    expect(policy.code).toBe(2);
    expect(policy.err).toContain(
      `screen shop: no bot policy ${join(root, 'design', 'tests', 'bots', 'to-shop.ts')}`
    );
  });

  it('checks the screen list and draws its contact sheet', () => {
    expect(checkScreens([])).toEqual({ error: expect.stringContaining('non-empty list') });
    expect(checkScreens([{ name: 'a b' }])).toEqual({
      error: expect.stringContaining('file-name-safe'),
    });
    expect(checkScreens([{ name: 'a' }, { name: 'a' }])).toEqual({
      error: expect.stringContaining('taken'),
    });
    expect(checkScreens([{ name: 'a', overrides: { record: {} } }])).toEqual({
      error: expect.stringContaining('take no record'),
    });
    const screens = checkScreens([
      { name: 'menu' },
      { name: 'shop', overrides: { seed: 2 }, policy: ' to-shop ' },
    ]);
    expect(screens).toEqual([
      { name: 'menu', overrides: {} },
      { name: 'shop', overrides: { seed: 2 }, policy: 'to-shop' },
    ]);
    expect(selectScreens(screens as never, ['shop'])).toEqual([(screens as never[])[1]]);

    const html = screensSheetHtml(
      [
        {
          screen: 'menu',
          locale: 'ru',
          size: '390x844@2',
          file: '/o/menu.png',
          status: 'ok',
          errors: [],
          shots: [],
        },
        {
          screen: 'menu',
          locale: 'en',
          size: '390x844@2',
          status: 'error',
          errors: ['boom'],
          shots: [{ name: 'open<', frame: 4, path: '/o/menu.en/open<.png' }],
        },
      ],
      path => path.slice(3)
    );
    expect(html.match(/<section>/g)).toHaveLength(1);
    expect(html).toContain('<img src="menu.png"><figcaption>ru · 390x844@2</figcaption>');
    expect(html).toContain(
      '<figure class="error"><div class="none"></div><figcaption>en · 390x844@2 · error'
    );
    expect(html).toContain('<img src="menu.en/open&lt;.png"><figcaption>en · 390x844@2 · open&lt;');
  });

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
    expect(badArgs.err).toContain('--bot-args takes a JSON object');

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
    expect((await run(['--config', '[1]'])).err).toContain('--config takes a JSON object');
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

    // --golden pins a fixed-step run (a bot or --run), read before Chrome starts.
    expect((await run(['dist', '--golden', 'g.json'])).err).toContain(
      '--golden pins a fixed-step run'
    );
    expect((await run(['dist', '--write'])).err).toContain('--write goes with --golden');
    expect(
      (await run(['dist', '--bot', 'x', '--golden', 'g.json', '--tolerance', 'x=1'])).err
    ).toContain('--tolerance takes path=eps');
    const goldenArgs = parsePlayArgs(['dist', '--bot', 'x', '--golden=g.json', '--write']);
    expect(
      typeof goldenArgs === 'object' && 'golden' in goldenArgs ? goldenArgs.golden : null
    ).toEqual({
      file: 'g.json',
      write: true,
      tolerance: new Map(),
    });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const policy = await run(['dist', '--bot', 'missing']);
    expect(policy.code).toBe(2);
    expect(policy.err).toContain(join('design', 'tests', 'bots', 'missing.ts'));
    mkdirSync(join(root, 'design', 'tests', 'bots'), { recursive: true });
    writeFileSync(join(root, 'design', 'tests', 'bots', 'round.ts'), 'export {};');
    const noGolden = await run(['dist', '--bot', 'round', '--golden', 'none.json']);
    expect(noGolden.code).toBe(2);
    expect(noGolden.err).toContain('no golden none.json — record one first');

    // --run takes pix3_game_run's params; its policy is checked before Chrome starts, and a run
    // is either a --run or a --bot (play-in-page S3).
    expect((await run(['dist', '--run', '[1]'])).err).toContain('--run takes the params');
    expect((await run(['dist', '--run', '{}', '--bot', 'x'])).err).toContain('--bot and --run');
    const runPolicy = await run(['dist', '--run', '{"bot":{"name":"gone"}}']);
    expect(runPolicy.code).toBe(2);
    expect(runPolicy.err).toContain(join('design', 'tests', 'bots', 'gone.ts'));
  });

  it('turns list values into a grid of runs, each with its own size, args and overrides', async () => {
    const parsed = parsePlayArgs([
      'dist',
      '--bot',
      'round',
      '--seed',
      '1..3',
      '--size',
      '390x844@3,360x640',
      '--locale',
      'ru',
      '--parallel',
      '2',
    ]);
    if (typeof parsed !== 'object' || 'error' in parsed) throw new Error(String(parsed));
    expect(parsed.parallel).toBe(2);
    expect(parsed.grid?.seed?.map(seed => seed.value)).toEqual([1, 2, 3]);
    expect(parsed.grid?.size?.map(size => size.value)).toEqual([
      { width: 390, height: 844, scale: 3 },
      { width: 360, height: 640 },
    ]);
    // One value per axis is a single run, its values applied as before.
    const single = parsePlayArgs(['dist', '--bot', 'x', '--size', '360x640@2', '--locale', 'ru']);
    expect(single).toMatchObject({ grid: null, width: 360, height: 640, scale: 2 });
    expect(typeof single === 'object' && 'run' in single ? single.run : null).toEqual({
      locale: 'ru',
    });
    writeFileSync(join(root, 'configs.json'), JSON.stringify([{ a: { b: { n: 1 } } }, { a: {} }]));
    const configs = parsePlayArgs(['dist', '--bot', 'x', '--config', join(root, 'configs.json')]);
    expect(typeof configs === 'object' && 'grid' in configs ? configs.grid?.config : null).toEqual([
      { value: { a: { b: { n: 1 } } }, label: 'config={"a":{"b":{"n":1}}}' },
      { value: { a: {} }, label: 'config={"a":{}}' },
    ]);
    expect((await run(['dist', '--seed', '1..3'])).err).toContain('a grid');
    expect((await run(['dist', '--bot', 'x', '--seed', '1,2', '--tree'])).err).toContain(
      '--tree take(s) one run'
    );
    expect((await run(['dist', '--bot', 'x', '--parallel', '0'])).err).toContain('--parallel');
    expect((await run(['dist', '--locale', 'ru;en'])).err).toContain('--locale takes');
  });

  it('refuses a recording or a replay it cannot make before a browser starts', async () => {
    const runOf = (argv: string[]) => {
      const parsed = parsePlayArgs(argv);
      return typeof parsed === 'object' && 'run' in parsed ? parsed.run : parsed;
    };
    expect(runOf(['dev', '--record', 'r.pix3replay', '--every', '5'])).toEqual({
      record: { every: 5 },
    });
    expect(runOf(['dev', '--record', 'r.pix3replay'])).toEqual({ record: {} });
    expect((await run(['--every', '2'])).err).toContain('--every sets the checkpoints');
    expect((await run(['--record', 'a', '--replay', 'b'])).err).toContain('two runs');
    expect((await run(['--replay', 'r.pix3replay', '--bot', 'x', '--seed', '2'])).err).toContain(
      "--replay plays the recording's scene, settings, inputs and screen: drop --bot, --seed"
    );
    const missing = await run(['--replay', 'gone.pix3replay']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no file');
    writeFileSync(join(root, 'bad.pix3replay'), '{"type":"end","tick":0}\n');
    expect((await run(['--replay', 'bad.pix3replay'])).err).toContain('is not a Pix3 recording');
    // A build carries no recorder: the dev server records and replays.
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    const onDist = await run(['dist', '--record', 'r.pix3replay']);
    expect(onDist.code).toBe(2);
    expect(onDist.err).toContain('--record needs the dev server');
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
