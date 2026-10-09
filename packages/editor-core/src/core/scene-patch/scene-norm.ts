import { SceneSaver, type SavedSceneDocument, type SceneGraph } from '@pix3/runtime';
import { layoutDerivedLeaves, maskLayoutDerived } from '@/core/scene-patch/layout-derived';

const saver = new SceneSaver();

/**
 * `norm` of a live graph (plan §C.1/§C.2): the saver's plain document, with `undefined` dropped as
 * YAML drops it, deep-copied so it is an immutable snapshot. In the editor every side of a diff is
 * normalised this way from a graph the editor's own loader built (`.plans/write-model.md` W1).
 */
export function normOfGraph(graph: SceneGraph): SavedSceneDocument {
  return JSON.parse(JSON.stringify(saver.serializeSceneDocument(graph))) as SavedSceneDocument;
}

/**
 * The norm of the live graph as it is compared with a baseline (the G of `pending`, §C.1): values
 * the flow layout computed are given the baseline's value, so they are never an edit of their own
 * (`layout-derived.ts`). Use {@link normOfGraph} only for a graph no layout pass has touched yet
 * (a fresh parse — a baseline, an external version).
 */
export function editorNormOfGraph(
  graph: SceneGraph,
  baseline: SavedSceneDocument
): SavedSceneDocument {
  return maskLayoutDerived(normOfGraph(graph), baseline, layoutDerivedLeaves(graph));
}

/** Full serialization — the writer's fallback (W6). */
export function serializeGraph(graph: SceneGraph): string {
  return saver.serializeScene(graph);
}
