import type { Pix3DebugContext } from './context';
import { DebugOverlay } from './overlay';
import { DebugSession } from './session';

/**
 * Debug mode (`/?debug` on the dev server; `virtual:pix3/debug` imports this only then, and a
 * build never). Mounts the overlay over the running game and exposes
 * `__PIX3_PLAYER__.debug.snapshot()` for an agent. Returns the teardown.
 */
export function mountDebugOverlay(context: Pix3DebugContext): () => void {
  const session = new DebugSession(context);
  session.start();
  const overlay = new DebugOverlay(session);
  overlay.mount();
  context.state.debug = { snapshot: () => session.snapshot() };
  return () => {
    overlay.dispose();
    session.dispose();
    delete context.state.debug;
  };
}
