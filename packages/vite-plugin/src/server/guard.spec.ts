// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hostNameOf, isAllowedHost, isLoopbackAddress } from './guard.ts';

describe('request guard', () => {
  it('parses Host names and refuses malformed ones', () => {
    expect(hostNameOf('LocalHost:5173')).toBe('localhost');
    expect(hostNameOf('[::1]:5173')).toBe('[::1]');
    expect(hostNameOf('localhost:')).toBeNull();
    expect(hostNameOf('localhost:abc')).toBeNull();
    expect(hostNameOf('[::1]x')).toBeNull();
  });

  it('allows loopback names and Vite allowedHosts, nothing else', () => {
    expect(isAllowedHost('localhost:5173', [])).toBe(true);
    expect(isAllowedHost('127.0.0.1', [])).toBe(true);
    expect(isAllowedHost('[::1]:1', [])).toBe(true);
    expect(isAllowedHost('evil.example', [])).toBe(false);
    expect(isAllowedHost('dev.example.com', ['.example.com'])).toBe(true);
    expect(isAllowedHost('example.com', ['.example.com'])).toBe(true);
    expect(isAllowedHost('notexample.com', ['.example.com'])).toBe(false);
    expect(isAllowedHost('anything', true)).toBe(true);
  });

  it('recognises loopback peers, IPv4-mapped included', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
