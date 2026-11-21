// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runSmokeCli } from './command.ts';

/**
 * `pix3 smoke --record` / `--replay`: the real CLI path (smoke bundle, worker thread) on a small
 * project — a run recorded in Node replays to the same checkpoints, a code change between record
 * and replay is named by its interval and path, and a file that is not a recording is refused.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-smoke-replay-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SCENE = `version: 1.0.0
root:
  - id: game-root
    type: Group2D
    name: Game Root
    properties:
      width: 1080
      height: 1920
    components:
      - id: count
        type: user:Count
        enabled: true
        config: {}
`;

const script = (
  bonus: string
): string => `import { Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

export class Count extends Script {
  private score = 0;
  private ticks = 0;
  static getPropertySchema(): PropertySchema {
    return { nodeType: 'Count', properties: [] };
  }
  onStart(): void {
    registerGameDebug({ name: 'count', snapshot: () => ({ score: this.score }) });
    this.scene?.commands.register('boost', () => {
      this.score += 1;
    });
  }
  onUpdate(): void {
    this.ticks += 1;
    ${bonus}
  }
}
`;

const project = (): string => {
  const root = join(scratch, 'game');
  const files: Record<string, string> = {
    'pix3project.yaml': 'version: 1.0.0\nviewportBaseSize:\n  width: 1080\n  height: 1920\n',
    'scenes/main.pix3scene': SCENE,
    'scripts/Count.ts': script(''),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe('pix3 smoke --record / --replay', () => {
  it('records a run, replays it to a match, and names where a code change made it diverge', async () => {
    const root = project();
    let out = '';
    let err = '';
    const io = {
      cwd: root,
      stdout: (text: string) => void (out += text),
      stderr: (text: string) => void (err += text),
    };
    const file = join(root, 'run.pix3replay');

    expect(
      await runSmokeCli(
        [
          'scenes/main.pix3scene',
          '--frames',
          '90',
          '--command',
          'boost@40',
          '--record',
          'run.pix3replay',
        ],
        io
      )
    ).toBe(0);
    expect(out).toContain(`recorded 90 tick(s): ${file}`);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: 'header', build: expect.stringMatching(/^sha256:/) });
    expect(lines.find(line => line.type === 'tick' && line.in)).toMatchObject({
      tick: 40,
      in: [{ kind: 'command', name: 'boost', phase: 'before' }],
    });

    out = '';
    expect(await runSmokeCli(['--replay', 'run.pix3replay', '--json'], io)).toBe(0);
    const matched = JSON.parse(out) as { replay: Record<string, unknown> };
    expect(matched.replay).toMatchObject({
      ok: true,
      ticks: 90,
      checkpoints: 3,
      divergence: null,
      buildChanged: false,
    });

    // The game changed after the recording: the score goes another way from tick 70 on.
    writeFileSync(
      join(root, 'scripts/Count.ts'),
      script('if (this.ticks === 71) this.score += 5;')
    );
    out = '';
    expect(await runSmokeCli(['--replay', 'run.pix3replay'], io)).toBe(1);
    expect(out).toContain('replay');
    expect(out).toMatch(/DIVERGED between tick 60 and 90/);
    expect(out).toContain('differs at: state.score');
    expect(out).toContain('build hash differs');
    expect(out).toContain('record again with --every 1');
    const recorded = join(root, 'run.tick-90.recorded.json');
    expect(JSON.parse(readFileSync(recorded, 'utf8'))).toMatchObject({ state: { score: 1 } });
    expect(JSON.parse(readFileSync(join(root, 'run.tick-90.replayed.json'), 'utf8'))).toMatchObject(
      { state: { score: 6 } }
    );
    expect(err).toBe('');
  }, 60_000);

  it('refuses what is not a recording, and flags that do not go with a replay', async () => {
    const root = project();
    let out = '';
    let err = '';
    const io = {
      cwd: root,
      stdout: (text: string) => void (out += text),
      stderr: (text: string) => void (err += text),
    };
    writeFileSync(join(root, 'bad.pix3replay'), '{"type":"tick","tick":1}\n');
    expect(await runSmokeCli(['--replay', 'bad.pix3replay'], io)).toBe(2);
    expect(err).toContain('is not a Pix3 recording');

    const header = {
      type: 'header',
      format: 1,
      build: null,
      scene: 'scenes/main.pix3scene',
      run: {},
      time: { mode: 'manual', fixedDeltaSec: 1 / 60 },
      viewport: { width: 1080, height: 1920, dpr: 1 },
      locale: null,
      checkpointEvery: 30,
    };
    writeFileSync(
      join(root, 'cut.pix3replay'),
      `${JSON.stringify(header)}\n{"type":"tick","tick":1}\n`
    );
    expect(await runSmokeCli(['--replay', 'cut.pix3replay'], io)).toBe(2);
    expect(out).toMatch(/E_SMOKE_REPLAY_FILE: not a recording this engine replays: no end line/);

    err = '';
    expect(await runSmokeCli(['--replay', 'cut.pix3replay', '--seed', '3'], io)).toBe(2);
    expect(err).toContain('--replay plays the recording');
    expect(await runSmokeCli(['--every', '1'], io)).toBe(2);
    expect(err).toContain('--every sets the checkpoints of a recording');
    expect(existsSync(join(root, 'cut.tick-0.recorded.json'))).toBe(false);
  }, 60_000);
});
