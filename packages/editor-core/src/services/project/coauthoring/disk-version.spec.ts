import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAppState } from '@/state';
import { readDiskVersion } from './disk-version';
import { SceneDiskStateService } from './SceneDiskStateService';
import { MemoryStorage } from './memory-storage.spec-helper';

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const withBom = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM, 0);
  out.set(body, BOM.length);
  return out;
};
const nodeSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  resetAppState();
});

describe('co-authoring hashes raw bytes', () => {
  it('a BOM file hashes equal to node:crypto over its bytes (not over the decoded text)', async () => {
    const storage = new MemoryStorage();
    const bytes = withBom('version: 1.0.0\r\nroot: []\r\n');
    storage.setBytes('scenes/bom.pix3scene', bytes);

    const version = (await readDiskVersion(storage, 'scenes/bom.pix3scene'))!;
    expect(version.hash).toBe(nodeSha(bytes));
    expect(version.text.startsWith('version')).toBe(true); // the BOM is gone from the text…
    expect(version.hash).not.toBe(nodeSha(new TextEncoder().encode(version.text))); // …not the hash
    expect(await readDiskVersion(storage, 'scenes/missing.pix3scene')).toBeNull();

    const diskState = new SceneDiskStateService();
    await diskState.recordRead('res://scenes/bom.pix3scene', version.bytes, version.text);
    expect(diskState.isKnownHash('scenes/bom.pix3scene', nodeSha(bytes))).toBe(true);
  });
});
