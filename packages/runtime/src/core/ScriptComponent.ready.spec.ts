import { describe, expect, it } from 'vitest';
import { createHeadlessGame } from '../testing/headless-game';
import { Script } from './ScriptComponent';

const log: string[] = [];

class Rules extends Script {
  onStart(): void {
    log.push('rules:start');
  }
  onReady(): void {
    log.push('rules:ready');
  }
}

class Board extends Script {
  onStart(): void {
    log.push('board:start');
  }
  onReady(): void {
    log.push('board:ready');
  }
}

const scene = `version: 1.0.0
root:
  - id: game-root
    type: Group2D
    name: Game Root
    components:
      - type: user:Rules
    children:
      - id: board
        type: Group2D
        name: Board
        components:
          - type: user:Board
`;

describe('Script.onReady', () => {
  it('runs after every component of the frame has started — a root sees its children started', async () => {
    log.length = 0;
    const game = await createHeadlessGame({
      files: { 'scenes/main.pix3scene': scene },
      scripts: { Rules, Board },
    });
    await game.start('scenes/main.pix3scene');
    await game.step(3);
    expect(log).toEqual(['rules:start', 'board:start', 'rules:ready', 'board:ready']);
    expect(game.errors).toEqual([]);
    game.dispose();
  });
});
