/**
 * The intrinsic pixel size of an image, read from its header without decoding it: PNG, JPEG,
 * WebP (VP8 / VP8L / VP8X), GIF and SVG (`width`/`height` attributes in px or unitless, else the
 * `viewBox`). Null when the format is unknown or the header carries no size.
 *
 * Hosts that cannot decode (`pix3 validate`, the plugin) size an un-sized `Sprite2D` with it, so a
 * scene normalises to the same document there as in the editor, whose loader decodes the image
 * (plan §C.2; `.plans/write-model.md` W2).
 */
export interface ImageHeaderSize {
  readonly width: number;
  readonly height: number;
}

export function readImageHeaderSize(bytes: Uint8Array): ImageHeaderSize | null {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(at, at + length));

  // PNG: signature, then the IHDR chunk (width, height as big-endian u32 at 16 / 20).
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(12, 4) === 'IHDR') {
    return sized(view.getUint32(16), view.getUint32(20));
  }

  // GIF: logical screen size, little-endian u16 at 6 / 8.
  if (ascii(0, 4) === 'GIF8') {
    return sized(view.getUint16(6, true), view.getUint16(8, true));
  }

  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = view.getUint16(at + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return sized(view.getUint16(at + 7), view.getUint16(at + 5));
      at += 2 + length;
    }
    return null;
  }

  // WebP: RIFF container, the first chunk says which bitstream.
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') {
      return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === 'VP8L') {
      const b = view.getUint32(21, true);
      return sized((b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') {
      const u24 = (at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      return sized(u24(24) + 1, u24(27) + 1);
    }
    return null;
  }

  return readSvgSize(bytes);
}

function sized(width: number, height: number): ImageHeaderSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function readSvgSize(bytes: Uint8Array): ImageHeaderSize | null {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
  const open = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!open) return null;
  const attr = (name: string): string | null =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(open)?.[1] ?? null;
  const length = (value: string | null): number | null => {
    const match = value ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value) : null;
    return match ? Number(match[1]) : null;
  };
  const width = length(attr('width'));
  const height = length(attr('height'));
  if (width !== null && height !== null) return sized(width, height);
  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!box || box.length !== 4 || box.some(n => !Number.isFinite(n))) return null;
  const [, , boxWidth, boxHeight] = box;
  if (width !== null) return sized(width, (width * boxHeight) / boxWidth);
  if (height !== null) return sized((height * boxWidth) / boxHeight, height);
  return sized(boxWidth, boxHeight);
}
