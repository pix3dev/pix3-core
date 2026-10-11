import { describe, expect, it } from 'vitest';

import { ResourceManager } from './ResourceManager';

const HELLO_BASE64 = btoa('hello');

describe('ResourceManager embedded resources', () => {
  it('reads an embedded entry through the same path normalization for every spelling', async () => {
    const manager = new ResourceManager('./', {
      'assets/greeting.txt': { base64: HELLO_BASE64, mimeType: 'text/plain' },
    });

    // res:// prefix, leading slash and backslashes all resolve to the same entry.
    await expect(manager.readText('res://assets/greeting.txt')).resolves.toBe('hello');
    await expect(manager.readText('/assets/greeting.txt')).resolves.toBe('hello');
    await expect(manager.readText('assets\\greeting.txt')).resolves.toBe('hello');
  });
});
