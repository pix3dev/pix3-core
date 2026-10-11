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

  it('takes only a literal 127.0.0.0/8 or ::1 address for loopback, never a name that starts like one', () => {
    // DNS rebinding: an attacker's name that resolves to 127.0.0.1 is sent as itself.
    expect(isAllowedHost('127.evil.com:5173', [])).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.com', [])).toBe(false);
    expect(isAllowedHost('127.0.0.1.nip.io:5173', [])).toBe(false);
    expect(isAllowedHost('127.1', [])).toBe(false);
    expect(isAllowedHost('127.0.0.2:5173', [])).toBe(true);
    expect(isAllowedHost('127.255.255.254', [])).toBe(true);
    expect(isAllowedHost('[0:0:0:0:0:0:0:1]:5173', [])).toBe(true);
    expect(isAllowedHost('[::ffff:127.0.0.1]:5173', [])).toBe(true);
    expect(isAllowedHost('[::2]:5173', [])).toBe(false);
    // A remote peer is the guard's other check; the Host alone never makes a name loopback.
    expect(isAllowedHost('127.evil.com:5173', [], { allowRemote: true })).toBe(false);
  });

  it('takes an IP-literal Host under allowRemote (Vite does too), a LAN name only from allowedHosts', () => {
    expect(isAllowedHost('192.168.1.5:5173', [])).toBe(false);
    expect(isAllowedHost('192.168.1.5:5173', [], { allowRemote: true })).toBe(true);
    expect(isAllowedHost('[fe80::1]:5173', [], { allowRemote: true })).toBe(true);
    expect(isAllowedHost('devbox.lan:5173', [], { allowRemote: true })).toBe(false);
    expect(isAllowedHost('devbox.lan:5173', ['devbox.lan'], { allowRemote: true })).toBe(true);
  });

  it('recognises loopback peers, IPv4-mapped included', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('127.evil')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
