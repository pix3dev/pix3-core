import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { ServiceContainer } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { PlayPageLink } from '@/services/play/PlayPageLink';
import { appState, resetAppState } from '@/state';

import { BRIDGE_TOOLS, PAGE_BRIDGE_TOOLS } from './bridge-tools';
import { callBridgeTool, thirdPartyToolGroup } from './debug-bridge';
import { HostService } from './HostService';
import { mountEditorWith, type EditorHandle } from './mount';
import { FakeHost } from './testing/fake-host';
import { fakeGamePage, type FakeGamePage } from './testing/fake-game-page';

/**
 * The bridge with the editor setting `playHost: 'page'` (plan play-in-page S4, §2.2): the same
 * tool names, the play ones aimed at the game's own pages — control at the agent's page only
 * (`not_your_page` on the human's), reads with `page`, `start` as a fresh load answered when the
 * page says hello, `pix3_game_run` on the page of the right load. With the setting off nothing of
 * it is reachable.
 */

const SCENE = `version: 1.0.0
metadata:
  description: page play spec
root:
  - id: hero
    type: Group2D
    name: Hero
`;

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

let handle: EditorHandle | null = null;
const pages: FakeGamePage[] = [];
const page = (...args: Parameters<typeof fakeGamePage>): FakeGamePage => {
  const created = fakeGamePage(...args);
  pages.push(created);
  return created;
};
const schemaOf = (name: string) =>
  thirdPartyToolGroup().tools.find(tool => tool.name === name)?.inputSchema;

beforeEach(async () => {
  resetAppState();
  const host = new FakeHost({
    files: {
      'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-page\n',
      'scenes/main.pix3scene': SCENE,
    },
  });
  await host.whenReady();
  handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
  await service(CommandDispatcher).execute(
    new LoadSceneCommand({ filePath: 'res://scenes/main.pix3scene' })
  );
});

afterEach(async () => {
  for (const created of pages.splice(0)) created.close();
  vi.restoreAllMocks();
  await handle?.dispose();
  handle = null;
  HostService.reset();
  resetAppState();
});

describe('the bridge on the game page (playHost: page)', () => {
  it('is off by default: the editor tools, no page param', async () => {
    expect(schemaOf('pix3_play')).toEqual(
      BRIDGE_TOOLS.find(t => t.name === 'pix3_play')?.inputSchema
    );
    expect(await callBridgeTool('pix3_play', { action: 'status', page: 'agent' })).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    expect(await callBridgeTool('pix3_status')).toMatchObject({ play: { playing: false } });
  });

  it('switches the table and the play tools with the setting', async () => {
    appState.ui.playHost = 'page';
    expect(thirdPartyToolGroup().tools.map(tool => tool.name)).toEqual(
      PAGE_BRIDGE_TOOLS.map(tool => tool.name)
    );
    expect(schemaOf('pix3_play')?.properties).not.toHaveProperty('aspect');
    expect(schemaOf('pix3_scene')?.properties).toHaveProperty('page');
    expect(PAGE_BRIDGE_TOOLS.find(t => t.name === 'pix3_game_run')?.description).toContain(
      'page_stale'
    );
    expect(await callBridgeTool('pix3_play', { action: 'status' })).toEqual({
      ok: true,
      playHost: 'page',
      pages: [],
    });
    expect(await callBridgeTool('pix3_status')).toMatchObject({
      play: { playHost: 'page', pages: [] },
    });
  });

  it("refuses control of the human's page: not_your_page; reads it", async () => {
    appState.ui.playHost = 'page';
    const designer = page('designer');
    designer.answer = (tool, params) =>
      tool === 'live_node'
        ? {
            ok: true,
            node: { nodeId: params.nodeId, type: 'Group2D', name: 'Hero' },
            screen: { x: 40, y: 50 },
            components: [],
          }
        : { ok: true };
    await service(PlayPageLink).discover(50);
    for (const call of [
      callBridgeTool('pix3_play', { action: 'restart', page: 'designer' }),
      callBridgeTool('pix3_play', { action: 'pause', page: 'designer' }),
      callBridgeTool('pix3_game_run', { page: 'designer', until: [{ kind: 'frames', n: 1 }] }),
    ]) {
      expect(await call).toMatchObject({ ok: false, reason: 'not_your_page' });
    }
    // The default read goes to the human's page while it is open.
    const read = await callBridgeTool('pix3_scene', { nodeId: 'hero' });
    expect(read).toMatchObject({
      ok: true,
      screen: { x: 40, y: 50 },
      live: { components: [] },
      page: { role: 'designer', loadId: designer.info.loadId },
    });
    expect(designer.calls.map(call => call.tool)).toEqual(['live_node']);
    expect(await callBridgeTool('pix3_scene', { nodeId: 'hero', page: 'agent' })).toMatchObject({
      ok: false,
      reason: 'no_game_page',
    });
    expect(await callBridgeTool('pix3_screenshot', { target: 'game' })).toMatchObject({
      ok: true,
      page: { role: 'designer', loadId: designer.info.loadId },
      next: 'take_screenshot',
    });
  });

  it('starts the agent page as a fresh load and answers once it says hello', async () => {
    appState.ui.playHost = 'page';
    let agent: FakeGamePage | null = null;
    const open = vi.spyOn(window, 'open').mockImplementation(url => {
      agent = page('agent', { url: String(url) });
      return {} as Window;
    });
    const started = await callBridgeTool('pix3_play', { action: 'start', run: { seed: 8 } });
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('?debug&role=agent&mute&scene=scenes%2Fmain.pix3scene&run='),
      'pix3-agent-play',
      expect.any(String)
    );
    expect(started).toMatchObject({ ok: true, page: { role: 'agent', loadId: 'agent-load-0' } });
    // A restart navigates the open page (no new window) with the same run.
    agent!.answer = tool => {
      if (tool === 'navigate') setTimeout(() => agent!.reload(), 0);
      return { ok: true };
    };
    const restarted = await callBridgeTool('pix3_play', { action: 'restart' });
    expect(restarted).toMatchObject({ ok: true, page: { loadId: 'agent-load-1' } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(agent!.calls[0].params.url).toContain(`run=${encodeURIComponent('{"seed":8}')}`);
    // A blocked window says so, with the URL to open.
    agent!.close();
    await vi.waitFor(() => expect(service(PlayPageLink).page('agent')).toBeNull());
    open.mockReturnValue(null);
    expect(await callBridgeTool('pix3_play', { action: 'start' })).toMatchObject({
      ok: false,
      reason: 'popup_blocked',
      url: expect.stringContaining('role=agent'),
    });
  });

  it('runs pix3_game_run on the agent page of the right load; a reload under it is page_reloaded', async () => {
    appState.ui.playHost = 'page';
    expect(await callBridgeTool('pix3_game_run', { until: [] })).toMatchObject({
      reason: 'no_game_page',
    });
    const agent = page('agent');
    await service(PlayPageLink).discover(50);
    const run = await callBridgeTool('pix3_game_run', {
      until: [{ kind: 'frames', n: 1 }],
      page: 'agent',
    });
    expect(run).toMatchObject({ ok: true, tool: 'game_run', page: { loadId: 'agent-load-0' } });
    expect(agent.calls[0].params).toEqual({ until: [{ kind: 'frames', n: 1 }] });

    agent.answer = () => new Promise(() => undefined);
    const reloaded = callBridgeTool('pix3_game_run', { until: [] });
    await vi.waitFor(() => expect(agent.calls).toHaveLength(2));
    agent.reload();
    expect(await reloaded).toMatchObject({ ok: false, reason: 'page_reloaded' });
  });

  it('waits for the reload a sync caused before it runs', async () => {
    appState.ui.playHost = 'page';
    const agent = page('agent', { rev: 1 });
    const link = service(PlayPageLink);
    await link.discover(50);
    link.noteSync(2);
    setTimeout(() => agent.reload({ rev: 2 }), 50);
    const run = await callBridgeTool('pix3_game_run', { until: [] });
    expect(run).toMatchObject({ ok: true, page: { loadId: 'agent-load-1' } });
    expect(agent.calls.map(call => call.loadId)).toEqual(['agent-load-1']);
  });

  it("tags the pages' errors and the editor's in pix3_errors", async () => {
    appState.ui.playHost = 'page';
    const agent = page('agent');
    agent.log('agent boom');
    await vi.waitFor(() => expect(service(PlayPageLink).errors()).toHaveLength(1));
    const answer = await callBridgeTool('pix3_errors', { page: 'agent', clear: true });
    expect(answer).toMatchObject({
      ok: true,
      count: 1,
      errors: [{ origin: 'agent', loadId: agent.info.loadId, message: 'agent boom' }],
    });
    expect(service(PlayPageLink).errors()).toEqual([]);
  });

  it('a read-only editor tab does not drive the agent page', async () => {
    appState.ui.playHost = 'page';
    appState.project.host.writer = 'other';
    expect(await callBridgeTool('pix3_play', { action: 'start' })).toMatchObject({
      reason: 'not_your_page',
    });
  });

  it('"Show in editor" on a page selects the node', async () => {
    const designer = page('designer');
    designer.select('hero');
    await vi.waitFor(() => expect(appState.selection.primaryNodeId).toBe('hero'));
  });
});
