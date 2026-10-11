import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeKeyframeAnimationSet } from '@pix3/runtime';

import { appState, resetAppState } from '@/state';

import './animation-timeline-panel';

/**
 * A keyframe drag commits a coalesced operation on every pointer move: it is a gesture, so the
 * idle flush waits for the release instead of writing the scene mid-drag (plan §C.1).
 */
describe('animation-timeline-panel — the keyframe drag is a gesture', () => {
  beforeEach(() => resetAppState());
  afterEach(() => {
    document.body.innerHTML = '';
    resetAppState();
  });

  it('sets gestureInProgress on the key press and clears it on the release', () => {
    const panel = document.createElement('pix3-animation-timeline-panel');
    const set = normalizeKeyframeAnimationSet({
      version: '1.0.0',
      clips: [
        {
          name: 'idle',
          duration: 1,
          loop: false,
          tracks: [
            {
              id: 't1',
              kind: 'property',
              path: '',
              property: 'x',
              enabled: true,
              keys: [{ time: 0.5, value: 1 }],
            },
          ],
        },
      ],
    });
    const track = set.clips[0].tracks[0];
    const internals = panel as unknown as {
      animationSet: unknown;
      activeClipName: string | null;
      bound: unknown;
      onKeyPointerDown(event: PointerEvent, track: unknown, keyTime: number): void;
      onKeyPointerUp(event: PointerEvent): void;
    };
    internals.animationSet = set;
    internals.activeClipName = 'idle';
    internals.bound = { nodeId: 'n', nodeName: 'N', componentId: 'anim' };
    const target = document.createElement('div');
    const event = (overrides: Record<string, unknown>): PointerEvent =>
      ({
        button: 0,
        pointerId: 7,
        clientX: 100,
        clientY: 20,
        shiftKey: false,
        currentTarget: target,
        stopPropagation: () => undefined,
        ...overrides,
      }) as unknown as PointerEvent;

    internals.onKeyPointerDown(event({}), track, 0.5);
    expect(appState.ui.gestureInProgress).toBe(true);
    internals.onKeyPointerUp(event({ clientX: 104 }));
    expect(appState.ui.gestureInProgress).toBe(false);
  });
});
