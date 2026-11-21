import { afterEach, describe, expect, it } from 'vitest';
import { getGameDebug, registerGameDebug, Script, type PropertySchema } from '@pix3/runtime';
import { createHeadlessGame, type HeadlessGame } from '@pix3/runtime/testing';
import { startDirectBot } from '@/services/game-test/bot-host';
import type { Json } from '@/core/agent-introspection';

/**
 * The bot host as `pix3 smoke --bot` uses it: a policy on `direct-action` against a real runner in
 * manual time, with no DOM — the button and the command reach the game, the gestures are refused.
 */
class Counter extends Script {
  private boosts = 0;
  private held = 0;
  private release: (() => void) | null = null;

  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'Counter', properties: [] };
  }

  override onStart(): void {
    this.scene!.commands.register('boost', () => {
      this.boosts += 1;
    });
    this.release = registerGameDebug({
      name: 'counter',
      snapshot: () => ({ boosts: this.boosts, held: this.held }),
    });
  }

  override onUpdate(): void {
    if (this.input?.getButton('Key_Space')) this.held += 1;
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
      - id: counter
        type: user:Counter
`;

let game: HeadlessGame | null = null;
afterEach(async () => {
  await game?.disposeAsync();
  game = null;
});

const gameState = (): Json | null =>
  (JSON.parse(JSON.stringify(getGameDebug()?.snapshot?.() ?? null)) as Json) ?? null;

describe('startDirectBot', () => {
  it('ticks a policy on the runner frame hook: commands and buttons land, gestures are refused', async () => {
    game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': SCENE },
      scripts: { Counter },
    });
    await game.start('scenes/main.pix3scene');
    const bot = startDirectBot(game.runner, {
      name: 'direct',
      args: { boosts: 2 },
      gameState,
      module: {
        default: () => ({
          tick(bot: {
            frame: number;
            args: { boosts: number };
            command(name: string): boolean;
            press(action: string, frames?: number): void;
            swipe(a: object, b: object): void;
            pinch(c: object, s: number): void;
            gameState(): { boosts: number; held: number };
            done(pass: boolean, reason: string): void;
          }) {
            if (bot.frame <= bot.args.boosts) bot.command('boost');
            if (bot.frame === 3) bot.press('Space', 4);
            if (bot.frame === 4) bot.swipe({ x: 0, y: 0 }, { x: 1, y: 1 });
            if (bot.frame === 5) bot.pinch({ x: 0, y: 0 }, 2);
            if (bot.frame === 20) {
              const state = bot.gameState();
              bot.done(state.boosts === 2 && state.held > 0, `boosts ${state.boosts}`);
            }
          },
        }),
      },
    });
    if ('error' in bot) throw new Error(bot.error);
    await game.step(30);
    const report = bot.stop();
    expect(report.channel).toBe('direct-action');
    expect(report.done).toMatchObject({ pass: true, reason: 'boosts 2', frame: 20 });
    expect(report.frames).toBe(20);
    expect(report.refused).toBe(2);
    expect(report.log.map(entry => entry.message).join('\n')).toContain(
      'pinch() is a physical gesture'
    );
    expect(game.snapshot()).toMatchObject({ boosts: 2 });
  });

  it('answers a module that holds no policy with the sentence', () => {
    expect(
      startDirectBot({} as never, { name: 'x', module: { nothing: 1 }, gameState: () => null })
    ).toMatchObject({ error: expect.stringContaining('must export the policy') });
  });
});
