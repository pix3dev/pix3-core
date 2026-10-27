// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { newCdpToken } from '../editor/cdp-token.ts';
import { runBridgeCli } from './command.ts';

/**
 * `pix3 bridge` against a stand-in for the token proxy: `/json/list` and a page-level WebSocket,
 * both refusing a request without the token, the page answering `Runtime.evaluate` the way the
 * editor's `__PIX3_DEBUG__.call` would. What is pinned: the CLI finds the proxy and the token
 * from `~/.pix3`, picks the editor tab, sends the tool and its params, and never prints the token.
 */

const TOKEN = newCdpToken();

let home: string;
let server: Server;
let wss: WebSocketServer;
let evaluated: string[];
let playStatus: string;

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      cwd: home,
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
      env: { PIX3_HOME: join(home, '.pix3') },
    },
    out,
    err,
  };
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'pix3-bridge-'));
  evaluated = [];
  playStatus = 'playing';
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 'other', type: 'page', url: 'https://example.com/' },
          { id: 'editor', type: 'page', url: 'http://localhost:5173/__pix3/' },
        ])
      );
      return;
    }
    res.writeHead(404).end();
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}` || req.url !== '/pix3/page/editor') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        const message = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params: { expression?: string };
        };
        if (message.method === 'Page.captureScreenshot') {
          ws.send(JSON.stringify({ id: message.id, result: { data: '' } }));
          return;
        }
        if (message.method !== 'Runtime.evaluate') {
          ws.send(JSON.stringify({ id: message.id, result: {} })); // Input.dispatch*, …
          return;
        }
        evaluated.push(message.params.expression ?? '');
        const tool = /call\("([^"]+)"/.exec(message.params.expression ?? '')?.[1];
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              result: {
                value: {
                  ok: tool !== 'pix3_fail',
                  tool,
                  ...(tool === 'pix3_play' ? { status: playStatus } : {}),
                },
              },
            },
          })
        );
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(home, '.pix3'), { recursive: true });
  writeFileSync(
    join(home, '.pix3', 'chrome.json'),
    JSON.stringify({ port, profile: '/p', startedAt: new Date().toISOString() })
  );
  writeFileSync(join(home, '.pix3', 'cdp-token'), `${TOKEN}\n`);
});

afterEach(async () => {
  wss.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe('pix3 bridge', () => {
  it('calls a tool in the editor tab through the token proxy, with its params', async () => {
    const run = io();
    const code = await runBridgeCli(['sync', '{"timeoutMs":1500}'], run.io);
    expect(run.err).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(run.out.join(''))).toEqual({ ok: true, tool: 'pix3_sync' });
    expect(evaluated[0]).toContain('{"timeoutMs":1500}');
    expect(`${run.out.join('')}${run.err.join('')}`).not.toContain(TOKEN);
  });

  it('exits 1 on a tool that answers ok:false, 2 on bad params or no editor Chrome', async () => {
    expect(await runBridgeCli(['pix3_fail'], io().io)).toBe(1);
    const bad = io();
    expect(await runBridgeCli(['sync', 'not json'], bad.io)).toBe(2);
    expect(bad.err.join('')).toContain('one JSON object');
    rmSync(join(home, '.pix3', 'chrome.json'));
    const none = io();
    expect(await runBridgeCli(['status'], none.io)).toBe(2);
    expect(none.err.join('')).toContain('pix3 editor');
  });

  it('screenshot --aspect sets the Game tab frame first (core-tests/game7)', async () => {
    const run = io();
    const out = join(home, 'shot.png');
    const code = await runBridgeCli(['screenshot', '--aspect', '9:16', '--out', out], run.io);
    expect(run.err).toEqual([]);
    expect(code).toBe(0);
    expect(evaluated[0]).toContain('call("pix3_play", {"action":"status","aspect":"9:16"})');
    expect(evaluated[1]).toContain('call("pix3_screenshot"');
  });

  it('tap into a paused game says so: game_run leaves play paused (core-tests/game8)', async () => {
    const running = io();
    expect(await runBridgeCli(['tap', '10', '20'], running.io)).toBe(0);
    expect(running.err).toEqual([]);
    playStatus = 'paused';
    const paused = io();
    expect(await runBridgeCli(['tap', '10', '20'], paused.io)).toBe(0);
    expect(paused.err.join('')).toContain(`play '{"action":"resume"}'`);
  });
});
