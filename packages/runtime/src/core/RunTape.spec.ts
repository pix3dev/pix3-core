import { afterEach, describe, expect, it } from 'vitest';

import { createHeadlessGame, type HeadlessGame } from '../testing';
import type { PropertySchema } from '../fw/property-schema';
import { registerGameDebug } from './game-debug';
import { platform } from './platform';
import { parseRunTape } from './RunTape';
import { Script } from './ScriptComponent';

/** What the next replay does differently, to make it diverge on purpose. */
const twist = { atTick: 0, permanent: true };

/**
 * A tap counts through a command the GAME dispatches (`tap`), `boost` is a command from outside,
 * `onForeground` counts trips to the background, and the node drifts with time (the tree).
 */
class Tapper extends Script {
  private taps = 0;
  private score = 0;
  private back = 0;
  private ticks = 0;
  private release: (() => void) | null = null;

  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'Tapper', properties: [] };
  }

  override onStart(): void {
    const commands = this.scene!.commands;
    commands.register('tap', () => {
      this.taps += 1;
    });
    commands.register('boost', args => {
      this.score += Number(args?.by ?? 1);
    });
    commands.register('next', () => {
      void this.scene!.changeScene('scenes/main.pix3scene');
    });
    commands.register('watch', () => {
      void platform.showRewarded('more', { onReward: () => (this.score += 50) });
    });
    this.scene!.app.onForeground(this, () => {
      this.back += 1;
    });
    this.release = registerGameDebug({
      name: 'tapper',
      snapshot: () => ({ taps: this.taps, score: this.score, back: this.back }),
    });
  }

  override onUpdate(dt: number): void {
    this.ticks += 1;
    for (const event of this.input?.pointerEvents ?? []) {
      if (event.type === 'down') this.scene!.commands.dispatch('tap');
    }
    if (this.ticks === twist.atTick) this.score += 100;
    if (!twist.permanent && this.ticks === twist.atTick + 3) this.score -= 100;
    this.node!.position.x += dt * 60;
  }

  override onDetach(): void {
    this.release?.();
    super.onDetach();
  }
}

const SCENE = `version: '1.0.0'
root:
  - id: root
    type: Group2D
    components:
      - id: tapper
        type: user:Tapper
`;

let games: HeadlessGame[] = [];
const boot = async (options: { record?: { every?: number }; replay?: string } = {}) => {
  const game = await createHeadlessGame({
    files: { 'scenes/main.pix3scene': SCENE },
    scripts: { Tapper },
    viewport: { width: 400, height: 800 },
    ...options,
  });
  games.push(game);
  return game;
};

const tap = (game: HeadlessGame, x: number, y: number): void => {
  const pointer = { kind: 'pointer', id: 1, x, y, pointerType: 'touch', button: 0 } as const;
  game.input({ ...pointer, type: 'down', buttons: 1 });
  game.input({ ...pointer, type: 'up', buttons: 0 });
};

/** A 90-tick run: a tap at tick 10, a boost at 20, a trip to the background at 50. */
const record = async (every?: number): Promise<string> => {
  const game = await boot({ record: every ? { every } : {} });
  await game.start('scenes/main.pix3scene');
  await game.step(9);
  tap(game, 0.5, 0.25);
  await game.step(10);
  game.dispatch('boost', { by: 3 });
  await game.step(30);
  game.input({ kind: 'background', awayMs: 1200 });
  await game.step(41);
  return game.recording();
};

const lines = (text: string): Record<string, unknown>[] =>
  text
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);

afterEach(async () => {
  twist.atTick = 0;
  twist.permanent = true;
  for (const game of games) await game.disposeAsync();
  games = [];
});

describe('run recording', () => {
  it('keeps only outside inputs, at their tick, and the game’s own command as a result', async () => {
    const text = await record();
    const all = lines(text);
    expect(all[0]).toMatchObject({
      type: 'header',
      format: 1,
      scene: 'scenes/main.pix3scene',
      time: { mode: 'manual' },
      checkpointEvery: 30,
      run: { storage: { snapshot: { version: 0, data: {} } } },
    });
    expect(all[1]).toEqual({ type: 'scene', tick: 1, path: 'scenes/main.pix3scene' });
    const inputs = all.flatMap(line =>
      line.type === 'tick'
        ? ((line.in as Record<string, unknown>[] | undefined) ?? []).map(
            (input): Record<string, unknown> => ({ tick: line.tick, ...input })
          )
        : []
    );
    expect(inputs.map(i => [i.tick, i.kind, i.type ?? i.name ?? i.awayMs])).toEqual([
      [10, 'pointer', 'down'],
      [10, 'pointer', 'up'],
      [20, 'command', 'boost'],
      [50, 'background', 1200],
    ]);
    expect(inputs[0]).toMatchObject({ phase: 'before', seq: 0, x: 0.5, y: 0.25 });
    // The tap's `tap` command is the game's own: a result in a checkpoint, never an input.
    const checkpoints = all.filter(line => line.type === 'checkpoint');
    expect(checkpoints.map(c => c.tick)).toEqual([30, 60, 90]);
    expect(checkpoints[0].commands).toEqual([
      ['tap', 'ok'],
      ['boost', 'ok'],
    ]);
    expect(checkpoints[2].state).toEqual({ back: 1, score: 3, taps: 1 });
    expect(all.at(-1)).toEqual({ type: 'end', tick: 90 });
  });

  it('one tap is exactly one command when recorded and when replayed', async () => {
    const text = await record();
    const replay = await boot({ replay: text });
    const result = await replay.replay();
    expect(result).toMatchObject({ ok: true, ticks: 90, end: 90, checkpoints: 3, stopped: null });
    expect(replay.scene.commands.log.filter(entry => entry.name === 'tap')).toHaveLength(1);
    expect(replay.snapshot()).toEqual({ taps: 1, score: 3, back: 1 });
  });

  it('marks a frame of several ticks, and replays it as one', async () => {
    const game = await boot({ record: {} });
    await game.start('scenes/main.pix3scene');
    await game.step(2);
    game.runner.stepFrames(3);
    await game.step(1);
    const text = game.recording();
    const ticks = lines(text).filter(line => line.type === 'tick');
    expect(ticks.map(line => [line.tick, line.f])).toEqual([
      [1, undefined],
      [3, 3],
      [6, 1],
    ]);
    expect(ticks[0].dt).toBeCloseTo(1 / 60);
    expect(await (await boot({ replay: text })).replay()).toMatchObject({ ok: true, ticks: 6 });
  });
});

describe('run replay — the environment', () => {
  it('replays ad outcomes as the recording saw them', async () => {
    const game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': SCENE },
      scripts: { Tapper },
      record: {},
      ads: ['skip', 'reward'],
    });
    games.push(game);
    await game.start('scenes/main.pix3scene');
    for (const at of [5, 5]) {
      await game.step(at);
      game.dispatch('watch');
      // The show holds the game (pause reason `ad`) until its outcome lands.
      await game.flush();
    }
    await game.step(5);
    const text = game.recording();
    const ads = lines(text).flatMap(line =>
      ((line.in as { kind: string; outcome?: string }[] | undefined) ?? []).filter(
        input => input.kind === 'ad'
      )
    );
    expect(ads.map(ad => ad.outcome)).toEqual(['skip', 'reward']);
    const replay = await boot({ replay: text });
    expect(await replay.replay()).toMatchObject({ ok: true });
    expect(replay.snapshot()).toMatchObject({ score: 50 });
  });

  it('lines a scene change up with the recording when the load took ticks there', async () => {
    const game = await boot({ record: {} });
    await game.start('scenes/main.pix3scene');
    await game.step(20);
    game.dispatch('next');
    // The old scene plays on while the new one loads, as in a page.
    game.runner.stepFrames(1);
    game.runner.stepFrames(1);
    game.runner.stepFrames(1);
    await game.flush();
    await game.step(40);
    const text = game.recording();
    const scenes = lines(text).filter(line => line.type === 'scene');
    expect(scenes.map(line => line.tick)).toEqual([1, 24]);
    const result = await (await boot({ replay: text })).replay();
    expect(result).toMatchObject({ ok: true, ticks: 63 });
    expect(result.notes.join('\n')).toMatch(
      /started 3 tick\(s\) sooner than recorded \(a load or a transition\); ticks 21–23 were skipped\./
    );
  });
});

describe('run replay — divergence', () => {
  it('names the interval and the path when the game goes another way between checkpoints', async () => {
    const text = await record();
    twist.atTick = 45;
    const result = await (await boot({ replay: text })).replay();
    expect(result.ok).toBe(false);
    expect(result.divergence).toMatchObject({
      from: 30,
      to: 60,
      paths: ['state.score'],
      likelyLoad: false,
    });
    expect(result.divergence?.recorded.state).toEqual({ back: 1, score: 3, taps: 1 });
    expect(result.divergence?.replayed.state).toEqual({ back: 1, score: 103, taps: 1 });
    expect(result.ticks).toBe(60);
  });

  it('misses a difference that is gone by the next checkpoint, and finds it with --every 1', async () => {
    const coarse = await record();
    twist.atTick = 40;
    twist.permanent = false;
    expect(await (await boot({ replay: coarse })).replay()).toMatchObject({ ok: true });

    twist.atTick = 0;
    twist.permanent = true;
    const fine = await record(1);
    twist.atTick = 40;
    twist.permanent = false;
    const result = await (await boot({ replay: fine })).replay();
    // The script's 40th update is tick 39: the pre-roll before tick 1 is an update too.
    expect(result.divergence).toMatchObject({ from: 38, to: 39, paths: ['state.score'] });
  });
});

describe('run replay — files it refuses', () => {
  const header = JSON.stringify({
    type: 'header',
    format: 1,
    build: null,
    scene: 'scenes/main.pix3scene',
    run: {},
    time: { mode: 'manual', fixedDeltaSec: 1 / 60 },
    viewport: { width: 400, height: 800, dpr: 1 },
    locale: null,
    checkpointEvery: 30,
  });
  const end = '{"type":"end","tick":5}';
  const cases: [string, string, RegExp][] = [
    ['empty', '', /empty/],
    ['not JSON', `${header}\n{nope`, /line 2: not JSON/],
    ['no header', end, /line 1: the first line is not the header/],
    ['a future format', header.replace('"format":1', '"format":2'), /format 2 is not one/],
    ['cut short', `${header}\n{"type":"tick","tick":1}`, /no end line/],
    [
      'ticks out of order',
      `${header}\n{"type":"tick","tick":3}\n{"type":"tick","tick":2}\n${end}`,
      /line 3: tick numbers/,
    ],
    [
      'an unknown input',
      `${header}\n{"type":"tick","tick":1,"in":[{"seq":0,"phase":"before","kind":"gamepad"}]}\n${end}`,
      /unknown input kind "gamepad"/,
    ],
    [
      'a pointer with no position',
      `${header}\n{"type":"tick","tick":1,"in":[{"seq":0,"phase":"before","kind":"pointer","type":"down","id":1}]}\n${end}`,
      /a pointer input needs/,
    ],
    ['a line after the end', `${header}\n${end}\n{"type":"tick","tick":6}`, /after the end/],
    [
      'an end before its ticks',
      `${header}\n{"type":"tick","tick":9}\n${end}`,
      /end tick must be whole and not before/,
    ],
  ];
  for (const [name, text, problem] of cases) {
    it(`refuses ${name}`, async () => {
      const parsed = parseRunTape(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors.join('\n')).toMatch(problem);
      await expect(createHeadlessGame({ files: {}, replay: text })).rejects.toThrow(
        /Not a replayable recording/
      );
    });
  }
});
