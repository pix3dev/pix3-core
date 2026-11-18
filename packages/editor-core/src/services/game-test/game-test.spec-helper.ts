import { vi } from 'vitest';
import type { RuntimeRenderer, SceneRunner } from '@pix3/runtime';
import { errors as capturedErrors } from '@/core/agent-introspection';
import { InMemoryReachabilityStore } from '@/services/game-test/reachability-journal';
import type { GameRuntimeHandle, GameTestHost } from '@/services/game-test/game-runtime-handle';

/** A runtime as a spec builds it: any runner-shaped object, canvas and window optional. */
export interface FakeRuntime {
  runner: unknown;
  canvas?: unknown;
  windowRef?: unknown;
}

/**
 * A {@link GameRuntimeHandle} over a spec's fake runtime. The pause levers are spies; pass
 * `levers` to route them somewhere real.
 */
export const fakeRuntimeHandle = (
  runtime: FakeRuntime,
  levers: Partial<Pick<GameRuntimeHandle, 'setPauseRequested' | 'setFocusPauseSuppressed'>> = {}
): GameRuntimeHandle => ({
  runner: runtime.runner as SceneRunner,
  renderer: {} as RuntimeRenderer,
  canvas: (runtime.canvas ?? document.createElement('canvas')) as HTMLCanvasElement,
  windowRef: (runtime.windowRef ?? window) as Window,
  setPauseRequested: levers.setPauseRequested ?? vi.fn(),
  setFocusPauseSuppressed: levers.setFocusPauseSuppressed ?? vi.fn(),
});

/** Mutable play state a spec flips between cases. */
export interface FakePlayState {
  playing: boolean;
  sceneId: string;
}

/**
 * A {@link GameTestHost} for specs: playing, the editor's error capture, real timers, an in-memory journal, no
 * policies, no scene restart. Override any member.
 */
export const fakeGameTestHost = (
  runtime: () => GameRuntimeHandle | null,
  overrides: Partial<GameTestHost> = {},
  state: FakePlayState = { playing: true, sceneId: '' }
): GameTestHost => ({
  isPlaying: () => state.playing,
  runtime,
  sceneId: () => state.sceneId,
  targetPlatform: () => undefined,
  errors: () => capturedErrors(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  yieldToHost: () => new Promise(resolve => setTimeout(resolve, 0)),
  reachabilityStore: () => new InMemoryReachabilityStore(),
  loadBot: async name => ({ error: `no policy "${name}" in this spec` }),
  ...overrides,
});
