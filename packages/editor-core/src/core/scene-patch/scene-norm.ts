import { SceneSaver, type SavedSceneDocument, type SceneGraph } from '@pix3/runtime';

const saver = new SceneSaver();

/**
 * `norm` of a live graph (plan §C.1/§C.2): the saver's plain document, with `undefined` dropped as
 * YAML drops it, deep-copied so it is an immutable snapshot. In the editor every side of a diff is
 * normalised this way from a graph the editor's own loader built (`.plans/write-model.md` W1).
 */
export function normOfGraph(graph: SceneGraph): SavedSceneDocument {
  return JSON.parse(JSON.stringify(saver.serializeSceneDocument(graph))) as SavedSceneDocument;
}

/** Full serialization — the writer's fallback (W6). */
export function serializeGraph(graph: SceneGraph): string {
  return saver.serializeScene(graph);
}
