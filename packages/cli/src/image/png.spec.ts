// @vitest-environment node
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { decodePng, encodePng } from './png.ts';

/** A hand-built PNG: IHDR fields, optional extra chunks, rows already filtered. */
const rawPng = (options: {
  width: number;
  height: number;
  depth?: number;
  colorType: number;
  interlace?: number;
  rows: number[][];
  chunks?: [string, number[]][];
}): Buffer => {
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    out.set(body, 8);
    return out; // the decoder does not check CRCs
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width, 0);
  header.writeUInt32BE(options.height, 4);
  header[8] = options.depth ?? 8;
  header[9] = options.colorType;
  header[12] = options.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(options.chunks ?? []).map(([type, body]) => chunk(type, Uint8Array.from(body))),
    chunk('IDAT', deflateSync(Uint8Array.from(options.rows.flat()))),
    chunk('IEND', new Uint8Array(0)),
  ]);
};

describe('png codec', () => {
  it('round-trips RGBA through encode and decode', () => {
    const width = 7;
    const height = 5;
    const data = new Uint8Array(width * height * 4).map((_, i) => (i * 37 + (i >> 3)) & 0xff);
    const decoded = decodePng(encodePng({ width, height, data }));
    expect(decoded).toEqual({ width, height, data });
  });

  it('reads RGB, grey, grey+alpha and every row filter', () => {
    // RGB 2×2: row 0 unfiltered, row 1 filter Up (adds the byte above).
    const rgb = decodePng(
      rawPng({
        width: 2,
        height: 2,
        colorType: 2,
        rows: [
          [0, 10, 20, 30, 40, 50, 60],
          [2, 1, 1, 1, 0, 0, 0],
        ],
      })
    );
    expect([...rgb.data]).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 11, 21, 31, 255, 40, 50, 60, 255,
    ]);
    // Grey 3×1 with Sub (adds the left byte), Average and Paeth rows.
    const grey = decodePng(
      rawPng({
        width: 3,
        height: 3,
        colorType: 0,
        rows: [
          [1, 10, 5, 5],
          [3, 2, 2, 2],
          [4, 1, 1, 1],
        ],
      })
    );
    const greys = [...grey.data].filter((_, i) => i % 4 === 0);
    expect(greys).toEqual([10, 15, 20, 7, 13, 18, 8, 14, 19]);
    const greyAlpha = decodePng(
      rawPng({ width: 1, height: 1, colorType: 4, rows: [[0, 90, 128]] })
    );
    expect([...greyAlpha.data]).toEqual([90, 90, 90, 128]);
  });

  it('reads a palette image with tRNS transparency', () => {
    const image = decodePng(
      rawPng({
        width: 3,
        height: 1,
        colorType: 3,
        rows: [[0, 0, 1, 2]],
        chunks: [
          ['PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255]],
          ['tRNS', [0, 128]],
        ],
      })
    );
    expect([...image.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
  });

  it('refuses what it cannot read, saying how to re-save', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow(/not a PNG/);
    expect(() =>
      decodePng(
        rawPng({ width: 1, height: 1, colorType: 6, interlace: 1, rows: [[0, 0, 0, 0, 0]] })
      )
    ).toThrow(/interlaced.*without interlacing/);
    expect(() =>
      decodePng(
        rawPng({ width: 1, height: 1, colorType: 2, depth: 16, rows: [[0, 0, 0, 0, 0, 0, 0]] })
      )
    ).toThrow(/16-bit PNG is not supported — re-save it with 8 bits/);
  });
});
