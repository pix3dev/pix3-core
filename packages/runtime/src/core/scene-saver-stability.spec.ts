// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { installCanvasOnlyDocument } from '../node';
import { createSceneHarness, templateCorpus } from '../node/scene-corpus';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import type { NodeBase } from '../nodes/NodeBase';
import { readImageHeaderSize } from './image-header-size';

/**
 * The saver fixes plan §C.2 asks for (`.plans/write-model.md` W5): a stable key order, so a full
 * save is a fixed point after one round, and one-line inspector toggles for `layout`/`flow`.
 */

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installCanvasOnlyDocument();
  for (const level of ['debug', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});
afterAll(() => {
  uninstall();
  vi.restoreAllMocks();
});

const corpus = templateCorpus();

const changedLines = (a: string, b: string): number => {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0)
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  return x.length + y.length - 2 * lcs[0][0];
};

describe('SceneSaver is a fixed point after one round', () => {
  it.each(corpus.map(scene => [scene.name, scene] as const))('%s', async (_name, scene) => {
    const harness = createSceneHarness(scene.projectDir);
    const once = harness.save(await harness.parse(scene.text, scene.path));
    const twice = harness.save(await harness.parse(once, scene.path));
    expect(twice).toBe(once);
  });
});

describe('layout / flow toggles change one key, not a block', () => {
  const setProp = (node: NodeBase, name: string, value: unknown): void => {
    const prop = getNodePropertySchema(node).properties.find(p => p.name === name);
    if (!prop) throw new Error(`no ${name} on ${node.type}`);
    prop.setValue(node, value);
  };

  it('layoutEnabled on, then flow tuned and switched off, keeps its parameters', async () => {
    const harness = createSceneHarness(tmpdir());
    const text = [
      'version: 1.0.0',
      'root:',
      '  - id: box',
      '    type: Group2D',
      '    name: Box',
      '    properties:',
      '      width: 300',
      '      height: 200',
      '',
    ].join('\n');
    const graph = await harness.parse(text, 'a.pix3scene');
    const before = harness.save(graph);
    const box = graph.nodeMap.get('box') as NodeBase;

    setProp(box, 'layoutEnabled', true);
    const layoutOn = harness.save(graph);
    expect(changedLines(before, layoutOn)).toBeLessThanOrEqual(2);
    expect(harness.normOf(graph).root[0].properties?.layout).toEqual({ enabled: true });

    setProp(box, 'flowEnabled', true);
    setProp(box, 'flowGap', 12);
    const flowOn = harness.save(graph);
    setProp(box, 'flowEnabled', false);
    const flowOff = harness.save(graph);
    expect(changedLines(flowOn, flowOff)).toBe(2); // `enabled: true` → `enabled: false`

    const reloaded = harness.normOf(await harness.parse(flowOff, 'a.pix3scene'));
    expect(reloaded.root[0].properties?.flow).toEqual({ enabled: false, gap: 12 });
  });
});

describe('Node textures carry the size in the image header', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pix3-header-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an un-sized Sprite2D normalises to the image size', async () => {
    writeFileSync(join(dir, 'pic.png'), png(37, 21));
    const harness = createSceneHarness(dir);
    const doc = await harness.norm(
      'root:\n  - id: s\n    type: Sprite2D\n    properties:\n      texture: { type: texture, url: res://pic.png }\n',
      'a.pix3scene'
    );
    expect(doc.root[0].properties).toMatchObject({ width: 37, height: 21 });
  });
});

describe('readImageHeaderSize', () => {
  it('reads PNG, GIF, JPEG, WebP and SVG', () => {
    expect(readImageHeaderSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageHeaderSize(bytes('GIF89a', [0x40, 0x01, 0xf0, 0x00, 0, 0]))).toEqual({
      width: 320,
      height: 240,
    });
    // SOI, APP0 (len 4), SOF0: len, precision, height 0x0100, width 0x0200.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00,
      0x02, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(readImageHeaderSize(jpeg)).toEqual({ width: 512, height: 256 });
    const vp8x = new Uint8Array(30);
    vp8x.set(bytes('RIFF'), 0);
    vp8x.set(bytes('WEBP'), 8);
    vp8x.set(bytes('VP8X'), 12);
    vp8x.set([99, 0, 0, 49, 0, 0], 24); // (w-1, h-1) as u24 LE
    expect(readImageHeaderSize(vp8x)).toEqual({ width: 100, height: 50 });
    const svg = (attrs: string) =>
      new TextEncoder().encode(`<?xml version="1.0"?><svg ${attrs}></svg>`);
    expect(readImageHeaderSize(svg('width="64" height="32px"'))).toEqual({ width: 64, height: 32 });
    expect(readImageHeaderSize(svg('viewBox="0 0 10 20" width="40"'))).toEqual({
      width: 40,
      height: 80,
    });
    expect(readImageHeaderSize(svg('width="100%"'))).toBeNull();
    expect(readImageHeaderSize(bytes('not an image'))).toBeNull();
  });
});

function bytes(text: string, tail: number[] = []): Uint8Array {
  return new Uint8Array([...text].map(c => c.charCodeAt(0)).concat(tail));
}

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  out.set(bytes('IHDR'), 12);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}
