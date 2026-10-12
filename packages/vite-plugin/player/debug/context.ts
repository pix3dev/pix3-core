import type { AudioService, RuntimeRenderer, SceneRunner } from '@pix3/runtime';

import type { Pix3PlayerState } from '../index';

/** What the player hands the debug overlay (`virtual:pix3/dev`'s `installDevTools`). */
export interface Pix3DebugContext {
  readonly runner: SceneRunner;
  readonly renderer: RuntimeRenderer;
  readonly audio: AudioService;
  readonly state: Pix3PlayerState;
}
