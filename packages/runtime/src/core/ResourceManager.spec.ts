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

describe('ResourceManager schemes', () => {
  it('passes data: and blob: URLs through instead of reading them as project paths', () => {
    // Both lack the `//` the scheme match required, so they became `<base>data:…`.
    const manager = new ResourceManager('/game/');
    expect(manager.normalize('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(manager.normalize('blob:http://localhost/x')).toBe('blob:http://localhost/x');
    expect(manager.normalize('res://sprites/a.png')).toBe('/game/sprites/a.png');
    expect(manager.normalize('sprites/a.png')).toBe('/game/sprites/a.png');
  });
});
