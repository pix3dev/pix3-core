/** One opacity flag per pixel of a decoded image. */
export interface AlphaMask {
  readonly width: number;
  readonly height: number;
  /** Row-major `width * height` flags, origin top-left: 1 = opaque, 0 = fully transparent. */
  readonly data: Uint8Array;
}

/**
 * Decode an image and reduce it to one opacity flag per pixel — the input the inspector's
 * auto-collision-polygon tracer (`contour-trace.ts`) walks. Returns null when the image can't be
 * decoded (no canvas in this context): callers must treat that as "unknown", never as "empty".
 */
export async function readAlphaMask(blob: Blob): Promise<AlphaMask | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return null;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = data[index * 4 + 3] > 0 ? 1 : 0;
    }
    return { width, height, data: mask };
  } finally {
    bitmap.close();
  }
}
