import { describe, expect, it } from 'vitest';

import { inspectGltf, readImageHeader } from './gltf-inspect';

function pngHeader(width: number, height: number, padTo = 64): Uint8Array {
  const bytes = new Uint8Array(padTo);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then SOF0 with height/width.
  const bytes = new Uint8Array(40);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  const sof = 2 + 2 + 16;
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  const view = new DataView(bytes.buffer);
  view.setUint16(sof + 5, height);
  view.setUint16(sof + 7, width);
  return bytes;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function buildGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const jsonText = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonText.length);
  const binLength = align4(bin.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(jsonText, 20);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  out.set(bin, binStart + 8);
  return out;
}

describe('readImageHeader', () => {
  it('reads PNG and JPEG sizes from their headers', () => {
    expect(readImageHeader(pngHeader(512, 256))).toEqual({
      format: 'PNG',
      width: 512,
      height: 256,
    });
    expect(readImageHeader(jpegHeader(2048, 1024))).toEqual({
      format: 'JPEG',
      width: 2048,
      height: 1024,
    });
    expect(readImageHeader(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('inspectGltf', () => {
  it('breaks a GLB down into meshes, textures, materials and animations with byte shares', async () => {
    const png = pngHeader(1024, 512, 400);
    // Layout: [image 400][positions 120][indices 24][anim times 8][anim values 24][4 unused]
    const bin = new Uint8Array(400 + 120 + 24 + 8 + 24 + 4);
    bin.set(png, 0);
    const animTimes = new Float32Array([0, 2.5]);
    bin.set(new Uint8Array(animTimes.buffer), 544);

    const json = {
      asset: { version: '2.0', generator: 'spec' },
      extensionsUsed: ['KHR_materials_unlit'],
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 400 },
        { buffer: 0, byteOffset: 400, byteLength: 120 },
        { buffer: 0, byteOffset: 520, byteLength: 24 },
        { buffer: 0, byteOffset: 544, byteLength: 8 },
        { buffer: 0, byteOffset: 552, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 1, componentType: 5126, count: 10, type: 'VEC3' },
        { bufferView: 2, componentType: 5123, count: 12, type: 'SCALAR' },
        { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', max: [2.5], min: [0] },
        { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      images: [{ name: 'hull', mimeType: 'image/png', bufferView: 0 }],
      textures: [{ source: 0 }],
      materials: [
        {
          name: 'Hull',
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          extensions: { KHR_materials_unlit: {} },
          doubleSided: true,
        },
      ],
      meshes: [
        {
          name: 'Ship',
          primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
        },
        // A second mesh sharing the same accessors must not be charged again.
        { name: 'ShipLod', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
      ],
      animations: [
        {
          name: 'Bob',
          samplers: [{ input: 2, output: 3 }],
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        },
      ],
      nodes: [{ mesh: 0 }],
    };

    const glb = buildGlb(json, bin);
    const report = await inspectGltf(glb);

    expect(report.container).toBe('glb');
    expect(report.totalBytes).toBe(glb.length);
    expect(report.binaryBytes).toBe(bin.length);
    expect(report.textures).toEqual([
      {
        name: 'hull',
        format: 'PNG',
        width: 1024,
        height: 512,
        storage: 'embedded',
        usedBy: ['Hull · baseColor'],
        bytes: 400,
      },
    ]);
    expect(report.meshes[0]).toMatchObject({
      name: 'Ship',
      vertices: 10,
      triangles: 4,
      attributes: ['POSITION'],
      materials: ['Hull'],
      bytes: 144,
    });
    expect(report.meshes[1]).toMatchObject({ name: 'ShipLod', bytes: 0 });
    expect(report.totalTriangles).toBe(8);
    expect(report.materials[0]).toMatchObject({
      name: 'Hull',
      shading: 'Unlit',
      doubleSided: true,
      textures: [{ slot: 'baseColor', image: 'hull' }],
      textureBytes: 400,
    });
    expect(report.animations[0]).toMatchObject({
      name: 'Bob',
      channels: 1,
      durationSeconds: 2.5,
      bytes: 32,
    });
    expect(report.otherBinaryBytes).toBe(4);
    expect(report.extensionsUsed).toEqual(['KHR_materials_unlit']);
    expect(report.warnings).toEqual([]);
  });

  it('reads a .gltf with an external buffer and a data-URI image', async () => {
    const jpeg = jpegHeader(64, 32);
    let binary = '';
    for (const byte of jpeg) binary += String.fromCharCode(byte);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'ship.bin', byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      images: [{ uri: `data:image/jpeg;base64,${btoa(binary)}` }],
      textures: [{ source: 0 }],
      materials: [{ normalTexture: { index: 0 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    };
    const text = JSON.stringify(json);
    const requested: string[] = [];

    const report = await inspectGltf(new TextEncoder().encode(text), {
      readExternal: async uri => {
        requested.push(uri);
        return new Uint8Array(36);
      },
    });

    expect(requested).toEqual(['ship.bin']);
    expect(report.container).toBe('gltf');
    expect(report.externalBytes).toBe(36);
    expect(report.meshes[0]).toMatchObject({ vertices: 3, triangles: 1, bytes: 36 });
    expect(report.textures[0]).toMatchObject({
      format: 'JPEG',
      width: 64,
      height: 32,
      storage: 'data-uri',
      bytes: jpeg.length,
      usedBy: ['material 0 · normal'],
    });
    expect(report.jsonBytes).toBeLessThan(text.length);
    expect(report.otherBinaryBytes).toBe(0);
  });

  it('warns instead of failing when an external file is missing', async () => {
    const json = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'gone.bin', byteLength: 12 }],
    };
    const report = await inspectGltf(new TextEncoder().encode(JSON.stringify(json)), {
      readExternal: async () => {
        throw new Error('nope');
      },
    });
    expect(report.warnings).toEqual(['External file missing: gone.bin']);
  });
});
