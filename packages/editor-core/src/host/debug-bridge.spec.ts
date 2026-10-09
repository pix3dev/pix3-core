import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { ServiceContainer } from '@/fw/di';
import { AgentKeepaliveService, RECENT_CALL_MS } from '@/services/core/AgentKeepaliveService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { appState, resetAppState } from '@/state';

import { BRIDGE_TOOLS, BRIDGE_TOOL_NAMES, validateParams } from './bridge-tools';
import { callBridgeTool, thirdPartyToolGroup, type Pix3DebugBridge } from './debug-bridge';
import { HostService } from './HostService';
import { mountEditorWith, type EditorHandle } from './mount';
import { FakeHost } from './testing/fake-host';

/**
 * The agent bridge (plan §D.1, §B.3): one tool table behind the 3p transport and the inline
 * `__PIX3_DEBUG__` fallback, owner rules for play, refusals that say why.
 */

const SCENE = `version: 1.0.0
metadata:
  description: bridge spec
root:
  - id: hero
    type: Group2D
    name: Hero
    properties:
      transform: { position: [10, 20], scale: [1, 1], rotation: 0 }
    children:
      - id: label
        type: Label2D
        name: Score
        properties:
          text: "0"
`;

const bridge = (): Pix3DebugBridge =>
  (window as { __PIX3_DEBUG__?: Pix3DebugBridge }).__PIX3_DEBUG__ as Pix3DebugBridge;

interface DiscoveryEvent extends Event {
  respondWith(group: unknown): void;
}

describe('agent bridge', () => {
  let handle: EditorHandle | null = null;
  let host: FakeHost;

  beforeEach(async () => {
    resetAppState();
    host = new FakeHost({
      files: {
        'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-bridge\n',
        'scenes/main.pix3scene': SCENE,
      },
    });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
    const container = ServiceContainer.getInstance();
    await container
      .getService<CommandDispatcher>(container.getOrCreateToken(CommandDispatcher))
      .execute(new LoadSceneCommand({ filePath: 'res://scenes/main.pix3scene' }));
  });

  afterEach(async () => {
    await handle?.dispose();
    handle = null;
    HostService.reset();
    resetAppState();
  });

  it('registers the pix3 group on devtoolstooldiscovery with every tool of the table', () => {
    const event = new CustomEvent('devtoolstooldiscovery') as unknown as DiscoveryEvent;
    const groups: Array<{ name: string; tools: Array<{ name: string; execute: unknown }> }> = [];
    event.respondWith = group => groups.push(group as (typeof groups)[number]);
    window.dispatchEvent(event);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('pix3');
    expect(groups[0].tools.map(t => t.name)).toEqual(BRIDGE_TOOL_NAMES);
    for (const tool of groups[0].tools) expect(typeof tool.execute).toBe('function');
    // The inline surface lists the same table.
    expect(
      bridge()
        .tools()
        .map(t => t.name)
    ).toEqual(BRIDGE_TOOL_NAMES);
    expect(BRIDGE_TOOL_NAMES).toEqual([
      'pix3_status',
      'pix3_sync',
      'pix3_scene',
      'pix3_play',
      'pix3_game_run',
      'pix3_screenshot',
      'pix3_errors',
    ]);
  });

  it('answers the same through the 3p execute and the inline call', async () => {
    const group = thirdPartyToolGroup();
    const status3p = (await group.tools.find(t => t.name === 'pix3_status')?.execute({})) as Record<
      string,
      unknown
    >;
    const statusInline = await bridge().call('pix3_status');
    expect(status3p).toMatchObject({
      ok: true,
      activeScene: 'res://scenes/main.pix3scene',
      writer: 'self',
      dirty: [],
      pending: {},
      play: { playing: false, playOwner: null },
    });
    expect(statusInline).toEqual(status3p);
    expect(await bridge().status()).toEqual(status3p);
  });

  it('refuses an unknown tool and bad params with a reason', async () => {
    expect(await callBridgeTool('pix3_nope')).toMatchObject({ ok: false, reason: 'unknown_tool' });
    expect(await callBridgeTool('pix3_play', {})).toMatchObject({
      ok: false,
      reason: 'invalid_params',
      detail: 'params needs "action"',
    });
    expect(await callBridgeTool('pix3_play', { action: 'fly' })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    expect(await callBridgeTool('pix3_scene', { maxDepth: 1.5 })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
      detail: 'params.maxDepth must be an integer',
    });
    expect(await callBridgeTool('pix3_sync', { expect: 'abc' })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    expect(await callBridgeTool('pix3_status', { extra: 1 })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    // Every schema in the table accepts an empty object or names what it requires.
    for (const tool of BRIDGE_TOOLS) {
      const problem = validateParams(tool.inputSchema, {});
      expect(problem === null || problem.startsWith('params needs'), tool.name).toBe(true);
    }
  });

  it('reads the scene: tree, one node with saved + screen, find', async () => {
    const tree = await callBridgeTool('pix3_scene', { maxDepth: 2 });
    expect(tree).toMatchObject({ ok: true, path: 'res://scenes/main.pix3scene' });
    const scene = tree.scene as { children: Array<{ nodeId: string; children: unknown[] }> };
    expect(scene.children.map(c => c.nodeId)).toEqual(['hero']);
    expect(scene.children[0].children).toHaveLength(1);

    const node = await callBridgeTool('pix3_scene', { nodeId: 'label' });
    expect(node).toMatchObject({
      ok: true,
      node: { nodeId: 'label', type: 'Label2D', name: 'Score' },
      saved: { id: 'label', type: 'Label2D' },
    });
    expect('screen' in node).toBe(true);
    expect(await bridge().node('label')).toMatchObject({ nodeId: 'label', saved: { id: 'label' } });

    const found = await callBridgeTool('pix3_scene', { find: 'label' });
    expect((found.matches as Array<{ nodeId: string }>).map(m => m.nodeId)).toEqual(['label']);
    expect(await bridge().find('nothing-here')).toEqual([]);

    expect(await callBridgeTool('pix3_scene', { nodeId: 'ghost' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(await callBridgeTool('pix3_scene', { path: 'scenes/other.pix3scene' })).toMatchObject({
      ok: false,
      reason: 'no_scene',
    });
    // A project-relative path reaches the same scene as the res:// one.
    expect(await callBridgeTool('pix3_scene', { path: 'scenes/main.pix3scene' })).toMatchObject({
      ok: true,
      path: 'res://scenes/main.pix3scene',
    });
  });

  it('syncs through the host and keeps the editor awake for a minute after', async () => {
    const container = ServiceContainer.getInstance();
    const keepalive = container.getService<AgentKeepaliveService>(
      container.getOrCreateToken(AgentKeepaliveService)
    );
    // Earlier calls in this file left the recent-call window open; move the clock past it.
    let clock = Date.now() + 2 * RECENT_CALL_MS;
    keepalive.now = () => clock;
    keepalive.recompute();
    expect(keepalive.isKeepAlive()).toBe(false);
    const reply = await callBridgeTool('pix3_sync', { timeoutMs: 1000 });
    expect(reply).toMatchObject({ ok: true });
    expect(keepalive.isKeepAlive()).toBe(true);
    clock += RECENT_CALL_MS + 1;
    keepalive.recompute();
    expect(keepalive.isKeepAlive()).toBe(false);
    keepalive.now = () => Date.now();
    expect(await bridge().sync({ timeoutMs: 1000 })).toMatchObject({ ok: true });
  });

  it('play: the designer’s session is refused even with force; a sync during it is stale', async () => {
    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';
    appState.ui.playOwner = 'designer';
    appState.ui.playStartedAt = 123;
    const status = await callBridgeTool('pix3_play', { action: 'status' });
    expect(status).toMatchObject({
      ok: true,
      playing: true,
      playOwner: 'designer',
      startedAt: 123,
    });
    for (const action of ['stop', 'restart', 'pause']) {
      expect(await callBridgeTool('pix3_play', { action, force: true }), action).toMatchObject({
        ok: false,
        reason: 'not_owner',
        playing: true,
        playOwner: 'designer',
      });
    }
    expect(await bridge().play.stop({ force: true })).toMatchObject({
      ok: false,
      reason: 'not_owner',
    });
    expect(appState.ui.isPlaying).toBe(true);
    expect(await callBridgeTool('pix3_play', { action: 'start' })).toMatchObject({
      ok: false,
      reason: 'already_playing',
    });
    expect(await callBridgeTool('pix3_sync')).toMatchObject({
      ok: false,
      reason: 'stale',
      playing: 'designer',
    });
  });

  it('play: stop and pause without a session say not_playing; game_run needs play', async () => {
    expect(await callBridgeTool('pix3_play', { action: 'stop' })).toMatchObject({
      ok: false,
      reason: 'not_playing',
    });
    expect(await callBridgeTool('pix3_play', { action: 'pause' })).toMatchObject({
      ok: false,
      reason: 'not_playing',
    });
    expect(await callBridgeTool('pix3_game_run', { until: [{ kind: 'newErrors' }] })).toMatchObject(
      {
        ok: false,
        reason: 'not_playing',
      }
    );
    expect(await callBridgeTool('pix3_screenshot', { target: 'game' })).toMatchObject({
      ok: false,
      reason: 'not_playing',
    });
  });

  it('errors: lists, filters by since, clears', async () => {
    bridge().clearErrors();
    const before = Date.now() - 1;
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom from a script' }));
    const all = await callBridgeTool('pix3_errors', {});
    expect(all).toMatchObject({ ok: true });
    expect((all.errors as Array<{ message: string }>).some(e => /boom/.test(e.message))).toBe(true);
    const recent = await callBridgeTool('pix3_errors', { since: before });
    expect(recent.count).toBeGreaterThanOrEqual(1);
    await callBridgeTool('pix3_errors', { clear: true });
    expect(bridge().errors()).toEqual([]);
  });
});
