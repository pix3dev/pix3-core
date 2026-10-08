import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAppState, appState } from '@/state';
import { AgentKeepaliveService, RECENT_CALL_MS } from './AgentKeepaliveService';
import { isEditorKeepAlive } from './page-activity';

describe('AgentKeepaliveService', () => {
  let service: AgentKeepaliveService;
  let clock = 0;

  beforeEach(() => {
    resetAppState();
    clock = 1_000;
    service = new AgentKeepaliveService();
    service.now = () => clock;
    service.initialize();
  });

  afterEach(() => service.dispose());

  it('stays off with no agent activity', () => {
    expect(service.isKeepAlive()).toBe(false);
  });

  it('keeps alive during a call and for a minute after it', () => {
    service.noteCallStarted('a');
    expect(service.isKeepAlive()).toBe(true);
    service.noteCallFinished('a');
    clock += RECENT_CALL_MS - 1;
    service.recompute();
    expect(service.isKeepAlive()).toBe(true);
    clock += 2;
    service.recompute();
    expect(service.isKeepAlive()).toBe(false);
    expect(isEditorKeepAlive()).toBe(false);
  });

  it('keeps alive for agent play until play stops', () => {
    appState.ui.isPlaying = true;
    service.notePlayStartedByAgent();
    expect(service.isKeepAlive()).toBe(true);
    appState.ui.isPlaying = false;
    service.recompute();
    expect(service.isKeepAlive()).toBe(false);
  });

  it('respects the setting', () => {
    appState.ui.keepEditorRunningForAgent = false;
    service.noteCallStarted('a');
    expect(service.isKeepAlive()).toBe(false);
  });
});
