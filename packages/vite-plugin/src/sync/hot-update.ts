import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DevEnvironment, EnvironmentModuleNode, HotUpdateOptions } from 'vite';

import { SCENE_MANIFEST_ID } from '../build/player-modules.ts';
import type { EditorServer } from '../dev-server.ts';
import { isGlobbedScript, resolvedId, sha256Hex, type ScriptGraph } from './script-graph.ts';

/**
 * The plugin's `hotUpdate` — not the legacy `handleHotUpdate`: Vite (6+, the environment API)
 * calls the legacy hook for `update` only, so a script file created or deleted outside a sync
 * never reached the editor — its roots kept the old glob until the next sync, and a play restart
 * ran without the new class (`.plans/done/scripts-vite.md` S13). This hook sees every kind.
 *
 * `undefined` leaves Vite's default propagation alone; `[]` means this hook did it.
 */
export const scriptHotUpdate = async (
  update: Pick<HotUpdateOptions, 'type' | 'file' | 'modules'>,
  environment: Pick<DevEnvironment, 'name' | 'moduleGraph'>,
  context: { readonly root: string; readonly scripts: ScriptGraph; readonly editor: EditorServer }
): Promise<EnvironmentModuleNode[] | undefined> => {
  const { type, file, modules } = update;
  const { scripts, editor } = context;
  // The player's scene manifest follows `pix3project.yaml` (entry scene, viewport, quality).
  if (file === join(context.root, 'pix3project.yaml')) {
    const manifest = environment.moduleGraph.getModuleById(resolvedId(SCENE_MANIFEST_ID));
    if (!manifest) return undefined;
    environment.moduleGraph.invalidateModule(manifest);
    return [...modules, manifest];
  }
  const wirePath = scripts.wirePathOf(file);
  if (wirePath === null) return undefined;
  const globbed = isGlobbedScript(wirePath);
  // A deleted helper has nothing to propagate (its importers fail on their next import, and
  // a sync reports that); a created one is not in the graph yet and Vite's default retries
  // the importers that failed to resolve it.
  if (!globbed && (type !== 'update' || !scripts.isEditorModule(wirePath))) return undefined;
  // The work is done once, on the client graph (the editor's and the game tab's environment);
  // every environment returns [] so Vite does not propagate a second time.
  if (environment.name !== 'client') return [];
  let sha: string | null;
  try {
    sha = sha256Hex(readFileSync(file));
  } catch {
    sha = null;
  }
  // A sync already propagated these bytes; the watcher's late echo must not do it twice.
  if (editor.barrier.alreadyPropagated(wirePath, sha)) return [];
  editor.barrier.notePropagated(wirePath, sha);
  // Propagate through the client environment's own nodes (never Vite 8's backward-compatible
  // mixed nodes — S1, finding 5): a changed file through its importers, an added or deleted
  // globbed script by re-running the roots' globs. Then tell the editor to re-import its roots.
  scripts.hardInvalidateRoots();
  if (type === 'update') await scripts.reload(wirePath);
  if (globbed && type !== 'update') await scripts.reloadRoots();
  editor.socket.broadcast({ type: 'pix3:scripts', path: wirePath, op: type });
  return [];
};
