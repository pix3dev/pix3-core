// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isUnlitModelFile, unlitModelReader } from './unlit-model.ts';

const dir = mkdtempSync(join(tmpdir(), 'pix3-unlit-model-'));

/** A GLB: 12-byte header, a padded JSON chunk, then a BIN chunk the reader must not need. */
const glb = (json: object): Buffer => {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = Buffer.from(text);
  const bin = Buffer.alloc(16);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length + 8 + bin.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, body, binHeader, bin]);
};

const UNLIT = { extensions: { KHR_materials_unlit: {} } };
const model = (materials: object[], primitives: object[]) => ({
  asset: { version: '2.0' },
  meshes: [{ primitives }],
  materials,
});

describe('isUnlitModelFile', () => {
  it('is true only when every primitive has a KHR_materials_unlit material', () => {
    const write = (name: string, json: object) => {
      writeFileSync(join(dir, name), glb(json));
      return join(dir, name);
    };
    expect(
      isUnlitModelFile(
        write('unlit.glb', model([UNLIT, UNLIT], [{ material: 0 }, { material: 1 }]))
      )
    ).toBe(true);
    expect(
      isUnlitModelFile(write('mixed.glb', model([UNLIT, {}], [{ material: 0 }, { material: 1 }])))
    ).toBe(false);
    // A primitive without a material gets three's default, a lit one.
    expect(isUnlitModelFile(write('default.glb', model([UNLIT], [{ material: 0 }, {}])))).toBe(
      false
    );
    expect(isUnlitModelFile(write('empty.glb', model([], [])))).toBe(false);
    // A JSON chunk that claims more bytes than the file has is not read (nor allocated).
    const lying = glb(model([UNLIT], [{ material: 0 }]));
    lying.writeUInt32LE(0x7fffffff, 12);
    writeFileSync(join(dir, 'lying.glb'), lying);
    expect(isUnlitModelFile(join(dir, 'lying.glb'))).toBe(false);
    writeFileSync(join(dir, 'junk.glb'), 'not a model');
    expect(isUnlitModelFile(join(dir, 'junk.glb'))).toBe(false);
    expect(isUnlitModelFile(join(dir, 'missing.glb'))).toBe(false);
  });

  it('reads a res:// path of the project, once', () => {
    writeFileSync(join(dir, 'ship.gltf'), JSON.stringify(model([UNLIT], [{ material: 0 }])));
    const read = unlitModelReader(dir);
    expect(read('res://ship.gltf')).toBe(true);
    expect(read('https://example.com/ship.gltf')).toBe(false);
  });
});
