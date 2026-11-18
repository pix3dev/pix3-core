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
 * `pix3 bridge` when the editor plays on the game's own page (plan play-in-page S4, D9): the game
 * is another CDP target. Pinned: the screenshot is taken of the page `pix3_screenshot` names (after
 * bringing it to the front), tap / swipe go to the agent's page and never the human's
 * (`not_your_page`), coordinates read from an older load are refused (`page_reloaded`), and a
 * `pix3_play start` the popup blocker refused is opened with `Target.createTarget` in the owned
 * Chrome (unless the window turned up late).
 */

const TOKEN = newCdpToken();
const ORIGIN = 'http://localhost:5173';
const AGENT_URL = `${ORIGIN}/?debug&role=agent&mute`;
const DESIGNER_URL = `${ORIGIN}/?debug&role=designer`;

let home: string;
let server: Server;
let wss: WebSocketServer;
/** CDP methods each target received, in order. */
let sent: Record<string, string[]>;
let targets: { id: string; type: string; url: string }[];
let agentLoadId: string;
let createdUrl: string | null;
/** The editor's answer per tool. */
let tools: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>;

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

const pageInfo = (role: string, url: string, loadId: string) => ({
  role,
  url,
  loadId,
  paused: false,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'pix3-bridge-pages-'));
  sent = {};
  createdUrl = null;
  agentLoadId = 'load-a';
  targets = [
    { id: 'editor', type: 'page', url: `${ORIGIN}/__pix3/` },
    { id: 'designer', type: 'page', url: DESIGNER_URL },
    { id: 'agent', type: 'page', url: AGENT_URL },
  ];
  tools = {
    pix3_status: () => ({
      ok: true,
      play: {
        playHost: 'page',
        pages: targets
          .filter(target => target.id !== 'editor')
          .map(target =>
            pageInfo(target.id, target.url, target.id === 'agent' ? agentLoadId : 'load-d')
          ),
      },
    }),
    pix3_scene: params => ({
      ok: true,
      screen: { x: 12, y: 34 },
      page: { role: params.page ?? 'designer', loadId: 'load-a' },
    }),
    pix3_screenshot: params => ({
      ok: true,
      page: {
        role: params.page ?? 'designer',
        url: params.page === 'agent' ? AGENT_URL : DESIGNER_URL,
      },
    }),
  };
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end();
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    const target = req.url === '/pix3' ? 'browser' : req.url?.replace('/pix3/page/', '');
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        const message = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params: { expression?: string; url?: string };
        };
        (sent[target ?? '?'] ??= []).push(message.method);
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
        if (message.method === 'Target.createTarget') {
          createdUrl = message.params.url ?? null;
          targets.push({ id: 'agent', type: 'page', url: createdUrl ?? '' });
          return reply({ targetId: 'agent' });
        }
        if (message.method === 'Page.captureScreenshot') return reply({ data: '' });
        if (message.method !== 'Runtime.evaluate') return reply({});
        const expression = message.params.expression ?? '';
        if (target === 'agent') return reply({ result: { value: agentLoadId } });
        const tool = /call\("([^"]+)", (.*)\);/.exec(expression);
        const answer = tools[tool?.[1] ?? '']?.(JSON.parse(tool?.[2] ?? '{}')) ?? { ok: true };
        // A second, read-only editor tab (the writer is `editor`).
        if (target === 'editor-ro')
          return reply({ result: { value: { ...answer, writer: 'other' } } });
        if (tool?.[1] === 'pix3_status')
          return reply({ result: { value: { ...answer, writer: 'self' } } });
        return reply({ result: { value: answer } });
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

describe('pix3 bridge on the game page (playHost: page)', () => {
  it('screenshots the page pix3_screenshot names, brought to the front', async () => {
    const run = io();
    expect(
      await runBridgeCli(['screenshot', '--page', 'agent', '--out', join(home, 'a.png')], run.io)
    ).toBe(0);
    // The debug overlay is hidden for the capture and shown again.
    expect(sent.agent).toEqual([
      'Page.bringToFront',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
    expect(sent.editor).not.toContain('Page.captureScreenshot');
    expect(await runBridgeCli(['screenshot', '--out', join(home, 'd.png')], io().io)).toBe(0);
    expect(sent.designer).toEqual([
      'Page.bringToFront',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
  });

  it("taps the agent's page, never the human's", async () => {
    const run = io();
    expect(await runBridgeCli(['tap', '--node', 'hero'], run.io)).toBe(0);
    expect(run.out.join('')).toContain('tapped (12, 34)');
    expect(sent.agent?.filter(method => method.startsWith('Input.'))).toHaveLength(3);
    expect(sent.designer).toBeUndefined();
    expect(sent.editor?.some(method => method.startsWith('Input.'))).toBe(false);

    const refused = io();
    expect(await runBridgeCli(['tap', '1', '2', '--page', 'designer'], refused.io)).toBe(2);
    expect(refused.err.join('')).toContain('not_your_page');
  });

  it('refuses coordinates read from another load of the page: page_reloaded', async () => {
    agentLoadId = 'load-b';
    const run = io();
    expect(await runBridgeCli(['swipe', '--from', 'a', '--to', 'b'], run.io)).toBe(1);
    expect(run.err.join('')).toContain('page_reloaded');
    expect(sent.agent?.some(method => method.startsWith('Input.'))).toBe(false);
  });

  it('talks to the writer when two editor tabs are open', async () => {
    targets.unshift({ id: 'editor-ro', type: 'page', url: `${ORIGIN}/__pix3/` });
    const run = io();
    expect(await runBridgeCli(['pix3_play', '{"action":"restart"}'], run.io)).toBe(0);
    expect(sent['editor-ro']).toEqual(['Runtime.evaluate']); // only its pix3_status
    expect(sent.editor).toEqual(['Runtime.evaluate', 'Runtime.evaluate']);
  });

  it('says no_game_page when the agent has no page yet', async () => {
    targets = targets.filter(target => target.id !== 'agent');
    const run = io();
    expect(await runBridgeCli(['tap', '1', '2'], run.io)).toBe(2);
    expect(run.err.join('')).toContain('no_game_page');
  });

  it('opens a start the popup blocker refused with Target.createTarget', async () => {
    targets = targets.filter(target => target.id !== 'agent');
    tools.pix3_play = () => ({
      ok: false,
      reason: 'popup_blocked',
      detail: 'blocked',
      url: AGENT_URL,
    });
    const run = io();
    expect(await runBridgeCli(['play', '{"action":"start"}'], run.io)).toBe(0);
    expect(createdUrl).toBe(AGENT_URL);
    expect(JSON.parse(run.out.join(''))).toMatchObject({
      ok: true,
      opened: 'Target.createTarget',
      page: { role: 'agent', loadId: 'load-a' },
    });
  });

  it('opens no second page when the window was only slower than the editor waited', async () => {
    targets = targets.map(target =>
      target.id === 'agent' ? { ...target, url: `${AGENT_URL}&start=3` } : target
    );
    tools.pix3_play = () => ({
      ok: false,
      reason: 'popup_blocked',
      detail: 'blocked',
      url: `${AGENT_URL}&start=3`,
    });
    const run = io();
    expect(await runBridgeCli(['play', '{"action":"start"}'], run.io)).toBe(0);
    expect(createdUrl).toBeNull();
    expect(JSON.parse(run.out.join(''))).toMatchObject({ ok: true, opened: 'window.open' });
  });
});
