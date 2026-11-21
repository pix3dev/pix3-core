import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A PNG codec on `node:zlib`, for `pix3 slice` and the pixel checks of `pix3 validate`: the CLI
 * adds no image dependency. Reads 8-bit grey, grey+alpha, RGB, RGBA and palette images (with
 * `tRNS` transparency) — what image generators and editors save; refuses 16-bit, sub-byte depths
 * and Adam7 interlacing with a message that says how to re-save. Writes 8-bit RGBA.
 */

/** RGBA, 4 bytes per pixel, rows top to bottom. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per colour type (PNG spec table 11.1). */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && SIGNATURE.every((value, i) => bytes[i] === value);

/** Decodes a PNG into RGBA. Throws an `Error` whose message names the unsupported feature. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new Error('not a PNG (the signature does not match)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR' && length >= 13) {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      [depth, colorType, interlace] = [body[8], body[9], body[12]];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || channels === undefined) throw new Error('a PNG with no valid IHDR');
  if (depth !== 8) {
    throw new Error(`${depth}-bit PNG is not supported — re-save it with 8 bits per channel`);
  }
  if (interlace !== 0) {
    throw new Error('interlaced (Adam7) PNG is not supported — re-save it without interlacing');
  }
  if (colorType === 3 && !palette) throw new Error('a palette PNG with no PLTE chunk');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG image data');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[row + i - channels] : 0;
      const b = y > 0 ? px[row - stride + i] : 0;
      const c = y > 0 && i >= channels ? px[row - stride + i - channels] : 0;
      let value = raw[src + i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} in row ${y}`);
      px[row + i] = value & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      data.set(px.subarray(s, s + 4), d);
    } else if (colorType === 2) {
      data.set(px.subarray(s, s + 3), d);
      data[d + 3] = 255;
    } else if (colorType === 3) {
      const index = px[s];
      data[d] = palette![index * 3];
      data[d + 1] = palette![index * 3 + 1];
      data[d + 2] = palette![index * 3 + 2];
      data[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else {
      data[d] = data[d + 1] = data[d + 2] = px[s];
      data[d + 3] = colorType === 4 ? px[s + 1] : 255;
    }
  }
  return { width, height, data };
}

const chunk = (type: string, body: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

/** Encodes RGBA as an 8-bit RGBA PNG (Paeth filter on every row, deflate level 9). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 4;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const a = i >= 4 ? data[at - 4] : 0;
      const b = y > 0 ? data[at - stride] : 0;
      const c = y > 0 && i >= 4 ? data[at - stride - 4] : 0;
      raw[dst + 1 + i] = (data[at] - paeth(a, b, c)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
