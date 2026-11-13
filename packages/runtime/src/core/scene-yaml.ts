import { Document, isScalar, isMap, visit } from 'yaml';

const VECTOR_KEYS = new Set(['x', 'y', 'z']);

/**
 * The one YAML style for scene and prefab files: every array of scalars (`position`, `groups`,
 * `points`, tile rows…) and every `{x, y[, z]}` number map is written on ONE line —
 * `position: [0, 1, 0]`, not a key followed by three `- n` lines. Nested containers (arrays of
 * arrays, node lists) stay block; their scalar leaves go inline. No line folding (`lineWidth: 0`),
 * so a long string or array stays one line instead of being wrapped mid-value.
 *
 * `SceneSaver.serializeScene` writes whole files with it; the editor's scene patch writer renders
 * the values it inserts with it, so a file the editor touches never gains the expanded form.
 */
export function stringifySceneYaml(value: unknown): string {
  const doc = new Document(value);
  visit(doc, {
    Seq(_, node) {
      if (node.items.length > 0 && node.items.every(item => isScalar(item))) node.flow = true;
    },
    Map(_, node) {
      if (!isMap(node)) return;
      const n = node.items.length;
      if (
        (n === 2 || n === 3) &&
        node.items.every(
          pair =>
            isScalar(pair.key) &&
            VECTOR_KEYS.has(String(pair.key.value)) &&
            isScalar(pair.value) &&
            typeof pair.value.value === 'number'
        )
      ) {
        node.flow = true;
      }
    },
  });
  return doc.toString({ indent: 2, indentSeq: true, flowCollectionPadding: false, lineWidth: 0 });
}
