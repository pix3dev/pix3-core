import type { Pix3DebugContext } from './context';
import { DebugOverlay } from './overlay';
import { DebugSession } from './session';

/**
 * Debug mode (`/?debug` on the dev server; `virtual:pix3/dev` imports this only then, and a
 * build never). Mounts the overlay over the running game and exposes
 * `__PIX3_PLAYER__.debug.snapshot()` for an agent. `editorUrl` (null with `editor: false`) adds
 * the header's Editor button. Returns the teardown.
 */
export function mountDebugOverlay(
  context: Pix3DebugContext,
  options: { readonly editorUrl?: string | null } = {}
): () => void {
  const session = new DebugSession(context);
  session.start();
  const overlay = new DebugOverlay(session, options.editorUrl ?? null);
  overlay.mount();
  context.state.debug = { snapshot: () => session.snapshot() };
  return () => {
    overlay.dispose();
    session.dispose();
    delete context.state.debug;
  };
}
