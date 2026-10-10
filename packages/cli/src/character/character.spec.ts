// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { normalizeAnimationResource, type AnimationResource } from '@pix3/runtime';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { USAGE } from '../usage.ts';
import { validateProject } from '../validate/validate.ts';
import { runCharacterCompileCli, slugOf } from './command.ts';
import {
  clipFilePrefix,
  compileCharacter,
  defaultLoopForState,
  readPngSize,
  scanNumberedSequences,
  type CharacterCompileSpec,
} from './compiler.ts';

/**
 * `pix3 character-compile` (plan §F.5 (в)): the 1.x `character-compiler.ts` cases ported, the
 * output held to the runtime's `AnimationResource` and the editor's frame naming, and the command
 * run end to end on a starter: files written, `pix3 validate` clean, refusals all-or-nothing.
 * A headless boot of the compiled prefab is `character.headless.spec.ts`.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-character-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const px = (path: string, width = 100, height = 100) => ({ path, width, height });

// --- PNG fixtures -------------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** A real, decodable RGBA PNG of one colour. */
const png = (width: number, height: number, rgba: [number, number, number, number]): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgba).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
};

const writeFiles = (root: string, files: Record<string, string | Uint8Array>): void => {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
};

// --- the compiler (ported 1.x cases) ------------------------------------------------------------

describe('scanNumberedSequences', () => {
  it('groups by directory + stem, sorts numerically and reports gaps and duplicates', () => {
    const scan = scanNumberedSequences([
      px('Goblin/Sword/idle0010.png'),
      px('Goblin/Sword/idle0002.png'),
      px('Goblin/Sword/idle0001.png'),
      px('Goblin/Sword/attack_03.png'),
      px('Goblin/Sword/attack_003.png'),
      px('Goblin/Sword/attack_1.png'),
      px('Goblin\\Bow\\run 0001.png', 100, 120),
      px('Goblin/Bow/run 0002.png'),
      px('cover.jpg', 573, 378),
    ]);

    expect(scan.unnumbered.map(f => f.path)).toEqual(['cover.jpg']);
    expect(scan.sequences.map(s => s.key)).toEqual([
      'Goblin/Bow/run',
      'Goblin/Sword/attack',
      'Goblin/Sword/idle',
    ]);
    const idle = scan.sequences[2];
    expect(idle.frames.map(f => f.number)).toEqual([1, 2, 10]);
    expect(idle.gaps).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(idle.duplicates).toEqual([]);
    const attack = scan.sequences[1];
    expect(attack.frames.map(f => f.number)).toEqual([1, 3, 3]);
    expect(attack.duplicates).toEqual([3]);
    expect(attack.gaps).toEqual([2]);
    const run = scan.sequences[0];
    expect(run.frames[0].path).toBe('Goblin/Bow/run 0001.png'); // backslashes normalized
    expect(run.mixedSizes).toEqual(['100x120', '100x100']);
  });
});

const GOBLIN: CharacterCompileSpec = {
  name: 'Goblin',
  slug: 'goblin',
  defaultVariant: 'sword',
  defaultState: 'idle',
  clips: [
    { variant: 'sword', state: 'idle', frames: [px('S/idle1.png'), px('S/idle2.png')] },
    { variant: 'sword', state: 'attack', frames: [px('S/att1.png')], fps: 15 },
    { variant: 'bow', state: 'idle', frames: [px('B/idle1.png')], loop: true },
    { variant: '', state: 'die', frames: [px('die1.png'), px('die2.png')] },
  ],
};

describe('compileCharacter', () => {
  it('emits a managed sprite folder, <variant>.<state> clips and a prefab with the component', () => {
    const out = compileCharacter(GOBLIN);

    expect(out.animationPath).toBe('sprites/goblin/goblin.pix3anim');
    expect(out.prefabPath).toBe('scenes/prefabs/Goblin.pix3scene'); // the 2.x starter layout
    expect(out.animation.clips.map(c => c.name)).toEqual([
      'sword.idle',
      'sword.attack',
      'bow.idle',
      'die',
    ]);
    expect(out.frameFiles).toEqual([
      { sourcePath: 'S/idle1.png', targetPath: 'sprites/goblin/sword_idle_0001.png' },
      { sourcePath: 'S/idle2.png', targetPath: 'sprites/goblin/sword_idle_0002.png' },
      { sourcePath: 'S/att1.png', targetPath: 'sprites/goblin/sword_attack_0001.png' },
      { sourcePath: 'B/idle1.png', targetPath: 'sprites/goblin/bow_idle_0001.png' },
      { sourcePath: 'die1.png', targetPath: 'sprites/goblin/die_0001.png' },
      { sourcePath: 'die2.png', targetPath: 'sprites/goblin/die_0002.png' },
    ]);
    const idle = out.animation.clips[0];
    expect(idle.frames[1].texturePath).toBe('res://sprites/goblin/sword_idle_0002.png');
    expect(idle.frames[1].sourceSize).toEqual({ width: 100, height: 100 });
    expect(idle.fps).toBe(12);
    expect(idle.loop).toBe(true);
    expect(out.animation.clips[1].fps).toBe(15);
    expect(out.animation.clips[1].loop).toBe(false); // attack is one-shot by default
    expect(out.animation.clips[3].loop).toBe(false); // die too

    expect(out.prefabYaml).toContain('type: core:CharacterVisual2D');
    expect(out.prefabYaml).toContain('type: AnimatedSprite2D'); // the root IS the sprite
    expect(out.prefabYaml).not.toContain('Group2D');
    expect(out.prefabYaml).toContain('animationResourcePath: res://sprites/goblin/goblin.pix3anim');
    expect(out.prefabYaml).toContain('currentClip: sword.idle');
    expect(out.prefabYaml).toContain('sizeMode: native');
    expect(out.prefabYaml).not.toMatch(/[&*]a\d/); // no YAML anchors/aliases
    // Source paths never leak into written files.
    expect(out.prefabYaml).not.toContain('S/idle1.png');
    expect(out.animationJson).not.toContain('S/idle1.png');
  });

  it('is deterministic and warns instead of guessing about fps/loop and mixed sizes', () => {
    const a = compileCharacter(GOBLIN);
    const b = compileCharacter(GOBLIN);
    expect(b.prefabYaml).toBe(a.prefabYaml);
    expect(b.animationJson).toBe(a.animationJson);
    expect(a.warnings).toContain('sword.idle: fps defaulted to 12.');
    expect(a.warnings).toContain('sword.idle: loop defaulted to true.');
    expect(a.warnings).not.toContain('sword.attack: fps defaulted to 12.');

    const mixed = compileCharacter({
      ...GOBLIN,
      clips: [{ variant: 'sword', state: 'idle', frames: [px('a1.png'), px('a2.png', 90, 100)] }],
    });
    expect(mixed.warnings.some(w => w.startsWith('sword.idle: frames differ in size'))).toBe(true);
  });

  it('refuses input that cannot become a valid bundle', () => {
    expect(() => compileCharacter({ ...GOBLIN, clips: [] })).toThrow(/at least one clip/);
    expect(() =>
      compileCharacter({
        ...GOBLIN,
        clips: [
          { variant: 'sword', state: 'idle', frames: [px('a.png')] },
          { variant: 'sword', state: 'idle', frames: [px('b.png')] },
        ],
      })
    ).toThrow(/duplicate clip "sword.idle"/);
    expect(() =>
      compileCharacter({ ...GOBLIN, defaultVariant: 'staff', defaultState: 'idle' })
    ).toThrow(/default pair staff\/idle has no clip/);
    expect(() =>
      compileCharacter({ ...GOBLIN, clips: [{ variant: 'sword', state: 'idle', frames: [] }] })
    ).toThrow(/has no frames/);
    expect(() => compileCharacter({ ...GOBLIN, slug: '../goblin' })).toThrow(/plain folder name/);
    expect(() => compileCharacter({ ...GOBLIN, prefabDirectory: '../out' })).toThrow(
      /inside the project/
    );
    // `Sword.Idle` and `sword.idle` are two clips but one frame-file prefix.
    expect(() =>
      compileCharacter({
        ...GOBLIN,
        clips: [
          { variant: 'sword', state: 'idle', frames: [px('a.png')] },
          { variant: 'Sword', state: 'Idle', frames: [px('b.png')] },
        ],
      })
    ).toThrow(/two frames would be written/);
  });

  it('treats attack/die/hit as one-shot and everything else as looping by default', () => {
    expect(defaultLoopForState('idle')).toBe(true);
    expect(defaultLoopForState('run')).toBe(true);
    expect(defaultLoopForState('Attack')).toBe(false);
    expect(defaultLoopForState('die')).toBe(false);
  });
});

// --- held to the runtime and the editor ----------------------------------------------------------

describe('character-compile output vs the runtime and the editor', () => {
  it('the .pix3anim is an AnimationResource the runtime loads without changing a field', () => {
    const out = compileCharacter({ ...GOBLIN, anchor: { x: 0.5, y: 0.9 } });
    // Type level: the compiler's own shape is assignable to the runtime's interfaces.
    const typed: AnimationResource = out.animation;
    // Value level: normalizing the written JSON is the identity — every field is the runtime's,
    // and none is defaulted away or added.
    const parsed = JSON.parse(out.animationJson) as unknown;
    expect(normalizeAnimationResource(parsed)).toEqual(parsed);
    expect(typed.clips[0].frames[0].anchor).toEqual({ x: 0.5, y: 0.9 });
  });

  it('names frame files by the managed sprite folder convention: <folder>/<clip>_<nnnn>.png', () => {
    // The convention the kit documents (pix3anim.md); the editor no longer creates frames.
    expect(
      ['sword.idle', 'Bow Attack!', 'die', '...', 'a-b_c'].map(clip => clipFilePrefix(clip))
    ).toEqual(['sword_idle', 'bow_attack', 'die', 'frame', 'a_b_c']);
    const out = compileCharacter(GOBLIN);
    const folder = out.animationPath.slice(0, out.animationPath.lastIndexOf('/'));
    out.animation.clips.forEach(clip => {
      clip.frames.forEach((frame, index) => {
        expect(frame.texturePath).toBe(
          `res://${folder}/${clipFilePrefix(clip.name)}_${String(index + 1).padStart(4, '0')}.png`
        );
      });
    });
  });

  it('reads PNG sizes from the header, and nothing else', () => {
    for (const [w, h] of [
      [1, 1],
      [64, 32],
      [300, 7],
    ]) {
      const bytes = png(w, h, [255, 0, 0, 255]);
      expect(readPngSize(bytes)).toEqual({ width: w, height: h });
    }
    expect(readPngSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readPngSize(new Uint8Array(4))).toBeNull();
  });
});

// --- the command ----------------------------------------------------------------------------------

let counter = 0;
const starter = (): string => {
  const template = listTemplates().find(t => t.id === '2d');
  if (!template) throw new Error('2d starter missing');
  const dir = join(scratch, `game-${++counter}`);
  createProject({ template, dir });
  return dir;
};

/** Frames outside the project (an art drop), and a spec beside them. */
const artDrop = (root: string): string => {
  const art = join(root, '..', `art-${counter}`);
  writeFiles(art, {
    'sword/idle_1.png': png(48, 64, [200, 40, 40, 255]),
    'sword/idle_2.png': png(48, 64, [210, 40, 40, 255]),
    'sword/attack_01.png': png(64, 64, [40, 200, 40, 255]),
    'sword/attack_02.png': png(64, 64, [40, 210, 40, 255]),
    'sword/attack_03.png': png(64, 64, [40, 220, 40, 255]),
    'bow/idle_1.png': png(48, 64, [40, 40, 200, 255]),
    'die/die_1.png': png(48, 32, [90, 90, 90, 255]),
    'goblin.yaml': [
      'name: Goblin Scout',
      'anchor: { x: 0.5, y: 0.9 }',
      'defaultVariant: sword',
      'defaultState: idle',
      'clips:',
      '  - { variant: sword, state: idle, fps: 8, frames: [sword/idle_1.png, sword/idle_2.png] }',
      '  - { variant: sword, state: attack, fps: 15, sequence: sword/attack_ }',
      '  - { variant: bow, state: idle, fps: 8, sequence: bow/idle_ }',
      '  - { state: die, sequence: die/die_ }',
      '',
    ].join('\n'),
  });
  return join(art, 'goblin.yaml');
};

const run = async (
  argv: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> => {
  let out = '';
  let err = '';
  const code = await runCharacterCompileCli(argv, {
    cwd,
    stdout: text => void (out += text),
    stderr: text => void (err += text),
  });
  return { code, out, err };
};

describe('pix3 character-compile', () => {
  it('is a command the CLI lists', () => {
    expect(USAGE).toContain('pix3 character-compile <spec>');
    expect(slugOf('Goblin Scout')).toBe('goblin-scout');
  });

  it('writes the character into a starter, and pix3 validate finds nothing wrong', async () => {
    const root = starter();
    const spec = artDrop(root);
    const result = await run([spec, '--json'], root);
    expect(result.err).toBe('');
    expect(result.out).toContain('"ok": true');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as {
      ok: boolean;
      animationPath: string;
      prefabPath: string;
      clips: { name: string; frames: number; fps: number; loop: boolean }[];
      files: { path: string; kind: string; action: string }[];
      warnings: string[];
    };
    expect(report.ok).toBe(true);
    expect(report.animationPath).toBe('sprites/goblin-scout/goblin-scout.pix3anim');
    expect(report.prefabPath).toBe('scenes/prefabs/Goblin Scout.pix3scene');
    expect(report.clips).toEqual([
      { name: 'sword.idle', frames: 2, fps: 8, loop: true },
      { name: 'sword.attack', frames: 3, fps: 15, loop: false },
      { name: 'bow.idle', frames: 1, fps: 8, loop: true },
      { name: 'die', frames: 1, fps: 12, loop: false },
    ]);
    expect(report.files.every(f => f.action === 'written')).toBe(true);
    expect(report.files.filter(f => f.kind === 'frame')).toHaveLength(7);
    expect(report.warnings).toEqual([
      'sword.idle: loop defaulted to true.',
      'sword.attack: loop defaulted to false.',
      'bow.idle: loop defaulted to true.',
      'die: fps defaulted to 12.',
      'die: loop defaulted to false.',
    ]);

    // The frames are the source bytes under their new names.
    expect(
      readFileSync(join(root, 'sprites/goblin-scout/sword_attack_0003.png')).equals(
        readFileSync(join(dirname(spec), 'sword/attack_03.png'))
      )
    ).toBe(true);
    const anim = JSON.parse(
      readFileSync(join(root, report.animationPath), 'utf8')
    ) as AnimationResource;
    expect(anim.clips[0].frames[0].sourceSize).toEqual({ width: 48, height: 64 });
    const prefab = parse(readFileSync(join(root, report.prefabPath), 'utf8')) as {
      root: { type: string; properties: Record<string, unknown>; components: unknown[] }[];
    };
    expect(prefab.root[0]).toMatchObject({
      type: 'AnimatedSprite2D',
      properties: { width: 48, height: 64, currentClip: 'sword.idle' },
      components: [{ type: 'core:CharacterVisual2D', config: { variant: 'sword', state: 'idle' } }],
    });

    // Instanced in the starter's scene, everything checks: types, keys, res:// paths, prefab.
    const main = join(root, 'scenes/main.pix3scene');
    writeFileSync(
      main,
      `${readFileSync(main, 'utf8').trimEnd()}\n      - id: scout\n        name: Scout\n        instance: res://${report.prefabPath}\n`
    );
    const validated = await validateProject({ projectRoot: root, hydrate: false });
    expect(validated.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  }, 60_000);

  it('dry run writes nothing; a second run is current; other content is refused whole', async () => {
    const root = starter();
    const spec = artDrop(root);
    const dry = await run([spec, '--dry-run'], root);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would write');
    expect(existsSync(join(root, 'sprites/goblin-scout'))).toBe(false);

    expect((await run([spec], root)).code).toBe(0);
    const again = await run([spec], root);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('wrote');
    expect(again.out).toContain('current');

    // A frame the user retouched, and a new frame in the drop: nothing is written.
    const retouched = join(root, 'sprites/goblin-scout/sword_idle_0001.png');
    writeFileSync(retouched, png(48, 64, [1, 2, 3, 255]));
    writeFiles(dirname(spec), { 'sword/attack_04.png': png(64, 64, [0, 0, 0, 255]) });
    const refused = await run([spec], root);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('EXISTS');
    expect(refused.out).toContain('sprites/goblin-scout/sword_idle_0001.png');
    expect(existsSync(join(root, 'sprites/goblin-scout/sword_attack_0004.png'))).toBe(false);

    const forced = await run([spec, '--force'], root);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('replaced');
    expect(existsSync(join(root, 'sprites/goblin-scout/sword_attack_0004.png'))).toBe(true);
  }, 60_000);

  it('says what is wrong with a spec, and writes nothing', async () => {
    const root = starter();
    const spec = artDrop(root);
    const bad = (body: string) => {
      const path = join(dirname(spec), `bad-${++counter}.yaml`);
      writeFileSync(path, body);
      return path;
    };
    const cases: [string, RegExp][] = [
      ['clips: []\n', /name is required/],
      ['name: X\nclips: []\n', /clips must be a non-empty list/],
      ['name: X\ncolour: red\nclips: [{ state: a, frames: [x.png] }]\n', /unknown key\(s\) colour/],
      ['name: X\nclips: [{ state: a }]\n', /exactly one of frames/],
      ['name: X\nclips: [{ state: a, frames: [nope.png] }]\n', /nope.png does not exist/],
      ['name: X\nclips: [{ state: a, frames: [goblin.yaml] }]\n', /is not a PNG/],
      [
        'name: X\nclips: [{ state: a, sequence: sword/run_ }]\n',
        /no numbered PNGs sword\/run<n>\.png/,
      ],
    ];
    for (const [body, message] of cases) {
      const result = await run([bad(body)], root);
      expect(result.code, body).toBe(1);
      expect(result.err, body).toMatch(message);
    }
    expect(existsSync(join(root, 'sprites/x'))).toBe(false);
    expect((await run([], root)).code).toBe(2);
    expect((await run([spec], scratch)).err).toContain('no pix3project.yaml');
  });
});
