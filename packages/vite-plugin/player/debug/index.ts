import type { Pix3DebugContext } from './context';
import { DebugOverlay } from './overlay';
import { DebugSession } from './session';

/** `__PIX3_PLAYER__.debug`: the debug session's numbers, live scene and controls, for an agent. */
export type Pix3PlayerDebug = Pick<
  DebugSession,
  'snapshot' | 'tree' | 'node' | 'highlight' | 'pause' | 'resume' | 'step'
>;

/**
 * Debug mode (`/?debug` on the dev server; `virtual:pix3/dev` imports this only then, and a
 * build never). Mounts the overlay over the running game and exposes {@link Pix3PlayerDebug} as
 * `__PIX3_PLAYER__.debug` for an agent. `editorUrl` (null with `editor: false`) adds
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
  context.state.debug = {
    snapshot: () => session.snapshot(),
    tree: () => session.tree(),
    node: id => session.node(id),
    highlight: id => session.highlight(id),
    pause: () => session.pause(),
    resume: () => session.resume(),
    step: () => session.step(),
  };
  return () => {
    overlay.dispose();
    session.dispose();
    delete context.state.debug;
  };
}
