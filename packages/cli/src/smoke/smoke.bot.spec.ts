// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runSmokeCli } from './command.ts';

/**
 * `pix3 smoke --bot` and the grid in Node: the real CLI path (smoke bundle with editor-core's
 * `bot-host`, a worker per run) on a small project — a policy on `direct-action` plays a seeded
 * round to its verdict, and a grid of seeds × args comes out as rows and an aggregate that is the
 * same on every run, pinned by a golden.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-smoke-bot-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const files: Record<string, string> = {
  'pix3project.yaml': 'version: 1.0.0\nviewportBaseSize:\n  width: 1080\n  height: 1920\n',
  'scenes/main.pix3scene': `version: 1.0.0
root:
  - id: game-root
    type: Group2D
    components:
      - id: dice
        type: user:Dice
`,
  'scripts/Dice.ts': `import { Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

export class Dice extends Script {
  private score = 0;
  private rolls = 0;
  static getPropertySchema(): PropertySchema {
    return { nodeType: 'Dice', properties: [] };
  }
  onStart(): void {
    registerGameDebug({
      name: 'dice',
      snapshot: () => ({ score: this.score, rolls: this.rolls, result: this.score > 8 ? 'win' : 'lose' }),
    });
    this.scene?.commands.register('roll', () => {
      this.rolls += 1;
      this.score += this.scene!.random.int(1, 6);
    });
  }
}
`,
  'design/tests/bots/roller.ts': `export default () => ({
  tick(bot) {
    if (bot.frame <= bot.args.rolls) bot.command('roll');
    if (bot.frame === 10) bot.done(bot.gameState().result === 'win', 'rolled');
  },
});
`,
};

const project = (): string => {
  const root = join(scratch, 'game');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const smoke = async (root: string, argv: string[]) => {
  let out = '';
  let err = '';
  const code = await runSmokeCli(['scenes/main.pix3scene', '--no-sync', ...argv], {
    cwd: root,
    stdout: text => void (out += text),
    stderr: text => void (err += text),
  });
  return { code, out, err };
};

describe('pix3 smoke --bot', () => {
  it('plays a policy on direct-action to its verdict, and a grid with an aggregate', async () => {
    const root = project();
    const one = await smoke(root, ['--bot', 'roller', '--bot-args', '{"rolls":3}', '--seed', '2']);
    expect(one.out).toMatch(/bot roller \(direct-action\): (PASS|FAIL) at frame 10 — rolled/);
    expect(one.out).toContain('10/7200 frames');

    const grid = [
      '--bot',
      'roller',
      '--seed',
      '1..4',
      '--bot-args',
      '{"rolls":1}',
      '--bot-args',
      '{"rolls":4}',
      '--parallel',
      '3',
      '--json',
    ];
    const first = await smoke(root, [...grid, '--check-determinism']);
    expect(first.err).toBe('');
    const report = JSON.parse(first.out) as {
      runs: { label: string; verdict: string; frames: number; determinism: { same: boolean } }[];
      aggregate: {
        runs: number;
        numbers: Record<string, { min: number; max: number }>;
        outcomes: Record<string, Record<string, number>>;
      };
    };
    expect(report.runs).toHaveLength(8);
    expect(report.runs[0].label).toBe('bot-args={"rolls":1} seed=1');
    expect(report.runs.every(run => run.determinism.same && run.frames === 10)).toBe(true);
    // One roll never reaches 9: every such round is lost — a result, not a failure.
    expect(report.runs.slice(0, 4).every(run => run.verdict === 'fail')).toBe(true);
    expect(report.aggregate.runs).toBe(8);
    expect(report.aggregate.numbers['gameState.rolls']).toMatchObject({ min: 1, max: 4 });
    expect(report.aggregate.outcomes['gameState.result'].lose).toBeGreaterThanOrEqual(0.5);
    expect(first.code).toBe(0);

    const golden = join(root, 'grid.json');
    expect((await smoke(root, [...grid, '--golden', golden, '--write'])).code).toBe(0);
    expect(JSON.parse(readFileSync(golden, 'utf8')).aggregate).toEqual(report.aggregate);
    const again = await smoke(root, [...grid, '--golden', golden]);
    expect(JSON.parse(again.out).golden.status).toBe('match');
  }, 60_000);

  it('refuses what it cannot run before a worker starts', async () => {
    const root = project();
    expect((await smoke(root, ['--bot', 'gone'])).err).toContain('no bot policy');
    expect((await smoke(root, ['--bot-args', '{}'])).err).toContain('--bot-args goes with --bot');
    expect((await smoke(root, ['--seed', '1..2', '--record', 'r.pix3replay'])).err).toContain(
      '--record takes one run'
    );
  });
});
