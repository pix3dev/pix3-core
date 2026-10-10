import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHeadlessGame, type HeadlessGame } from '../testing';
import { Script } from './ScriptComponent';
import { autoloadComponentType, normalizeAutoloads } from './autoloads';
import type { PropertySchema } from '../fw/property-schema';

/** Every lifecycle hook of every script, in the order the engine ran them. */
let journal: string[] = [];

class GameState extends Script {
  ticks = 0;
  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'GameState', properties: [] };
  }
  override onAttach(): void {
    journal.push('GameState.attach');
  }
  override onStart(): void {
    journal.push('GameState.start');
  }
  override onUpdate(): void {
    this.ticks += 1;
    if (journal.at(-1) !== 'GameState.update') journal.push('GameState.update');
  }
  override onDetach(): void {
    journal.push('GameState.detach');
    super.onDetach();
  }
}

class Audio extends Script {
  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'Audio', properties: [] };
  }
  override onDetach(): void {
    journal.push('Audio.detach');
    super.onDetach();
  }
}

/** A scene script: records what it sees of the singleton, and can change the scene. */
class Probe extends Script {
  seen: GameState | null = null;
  seenByClass: GameState | null = null;
  ticksAtStart = -1;
  static override getPropertySchema(): PropertySchema {
    return { nodeType: 'Probe', properties: [] };
  }
  override onStart(): void {
    journal.push(`Probe.start@${this.node?.name}`);
    this.seen = this.scene?.getAutoload<GameState>('GameState') ?? null;
    this.seenByClass = this.scene?.getAutoload(GameState) ?? null;
    this.ticksAtStart = this.seen?.ticks ?? -1;
  }
  override onUpdate(): void {
    if (journal.at(-1) !== `Probe.update@${this.node?.name}`)
      journal.push(`Probe.update@${this.node?.name}`);
  }
  override onDetach(): void {
    journal.push(`Probe.detach@${this.node?.name}`);
    super.onDetach();
  }
}

const scene = (name: string): string => `version: '1.0.0'
root:
  - id: ${name}
    type: Group2D
    name: ${name}
    components:
      - id: probe-${name}
        type: 'user:Probe'
`;

const FILES = {
  'scenes/a.pix3scene': scene('SceneA'),
  'scenes/b.pix3scene': scene('SceneB'),
};

const probeOf = (game: HeadlessGame): Probe => {
  const probe = game.roots()[0]?.components[0];
  if (!(probe instanceof Probe)) throw new Error('no probe');
  return probe;
};

describe('autoloads (runtime)', () => {
  let game: HeadlessGame | null = null;

  afterEach(async () => {
    await game?.disposeAsync();
    game = null;
    journal = [];
    vi.restoreAllMocks();
  });

  it('builds once, ticks before the scene and survives changeScene', async () => {
    game = await createHeadlessGame({
      files: FILES,
      scripts: { GameState, Audio, Probe },
      autoloads: [
        { singleton: 'GameState', scriptPath: 'scripts/GameState.ts', enabled: true },
        { singleton: 'Audio', scriptPath: 'src/scripts/Audio.ts', enabled: true },
      ],
    });
    await game.start('scenes/a.pix3scene');
    const first = probeOf(game);
    expect(first.seen).toBeInstanceOf(GameState);
    expect(first.seenByClass).toBe(first.seen);
    expect(game.scene.getAutoload('Audio')).toBeInstanceOf(Audio);
    expect(game.scene.getAutoload('Nope')).toBeNull();
    // The autoload's onStart ran first, and its first onUpdate ran before the scene's onStart saw it.
    expect(journal.slice(0, 3)).toEqual([
      'GameState.attach',
      'GameState.start',
      'GameState.update',
    ]);
    expect(journal.indexOf('GameState.start')).toBeLessThan(journal.indexOf('Probe.start@SceneA'));
    expect(first.ticksAtStart).toBe(1);

    await game.step(10);
    const singleton = first.seen as GameState;
    expect(singleton.ticks).toBe(11);

    await game.scene.changeScene('scenes/b.pix3scene', { transition: 'none' });
    await game.flush();
    const second = probeOf(game);
    expect(second.node?.name).toBe('SceneB');
    // The same instance, its state kept: no second attach/start, no detach.
    expect(second.seen).toBe(singleton);
    expect(second.ticksAtStart).toBe(12);
    expect(journal.filter(e => e === 'GameState.attach')).toHaveLength(1);
    expect(journal.filter(e => e === 'GameState.start')).toHaveLength(1);
    expect(journal).not.toContain('GameState.detach');
    expect(journal).toContain('Probe.detach@SceneA');

    await game.step(5);
    expect(singleton.ticks).toBe(17);
    // Ticked every frame, before the scene's script.
    const lastUpdates = journal.filter(e => e.includes('.update')).slice(-2);
    expect(lastUpdates).toEqual(['GameState.update', 'Probe.update@SceneB']);

    // The session ends: the scene detaches first, then the autoloads in reverse order.
    journal = [];
    game.runner.stop();
    expect(journal).toEqual(['Probe.detach@SceneB', 'Audio.detach', 'GameState.detach']);
    expect(singleton.node).toBeNull();
    expect(game.errors).toEqual([]);
  });

  it('a new session after stop() builds fresh singletons', async () => {
    game = await createHeadlessGame({
      files: FILES,
      scripts: { GameState, Probe },
      autoloads: [{ singleton: 'GameState', scriptPath: 'scripts/GameState.ts', enabled: true }],
    });
    await game.start('scenes/a.pix3scene');
    const before = probeOf(game).seen;
    await game.step(3);
    game.runner.stop();
    await game.start('scenes/a.pix3scene');
    const after = probeOf(game).seen;
    expect(after).toBeInstanceOf(GameState);
    expect(after).not.toBe(before);
    expect(after?.ticks).toBe(1);
  });

  it('skips a disabled entry and reports one whose type does not resolve', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    game = await createHeadlessGame({
      files: FILES,
      scripts: { GameState, Probe },
      autoloads: [
        { singleton: 'GameState', scriptPath: 'scripts/GameState.ts', enabled: false },
        { singleton: 'Missing', scriptPath: 'scripts/Missing.ts', enabled: true },
      ],
    });
    await game.start('scenes/a.pix3scene');
    expect(probeOf(game).seen).toBeNull();
    expect(game.scene.getAutoload('Missing')).toBeNull();
    expect(game.errors).toHaveLength(1);
    expect(game.errors[0]).toMatchObject({ phase: 'attach', componentType: 'user:Missing' });
    expect(game.errors[0].message).toContain('scripts/Missing.ts');
    // The game runs on without it.
    expect(await game.step(2)).toBe(2);
  });
});

describe('autoload manifest rules', () => {
  it('derives the component type from the file name', () => {
    expect(autoloadComponentType('scripts/GameState.ts')).toBe('user:GameState');
    expect(autoloadComponentType('res://src/scripts/ui/Hud.js')).toBe('user:Hud');
    expect(autoloadComponentType('scripts\\Win.mts')).toBe('user:Win');
  });

  it('normalises the list the way every host reads it', () => {
    expect(
      normalizeAutoloads([
        { singleton: ' A ', scriptPath: ' scripts/A.ts ' },
        { singleton: 'B', scriptPath: 'scripts/B.ts', enabled: false },
        { singleton: 'A', scriptPath: 'scripts/Other.ts' },
        { singleton: '', scriptPath: 'scripts/C.ts' },
        { scriptPath: 'scripts/D.ts' },
        'junk',
      ])
    ).toEqual([
      { singleton: 'A', scriptPath: 'scripts/A.ts', enabled: true },
      { singleton: 'B', scriptPath: 'scripts/B.ts', enabled: false },
    ]);
    expect(normalizeAutoloads(undefined)).toEqual([]);
  });
});
