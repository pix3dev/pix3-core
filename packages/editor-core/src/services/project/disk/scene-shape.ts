import { parse } from 'yaml';

/**
 * Whether a scene file version on disk is readable at all — `ExternalChangeService` holds a
 * version that is not (an agent mid-write, a broken edit) instead of reloading it, and keeps
 * the last good graph. Not a validation of the scene's content: the loader does that.
 */
export function sceneShapeProblem(text: string): string | null {
  if (text.trim().length === 0) return 'the file is empty';
  let doc: unknown;
  try {
    doc = parse(text) as unknown;
  } catch (error) {
    return error instanceof Error ? error.message.split('\n')[0] : 'YAML error';
  }
  const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isMap(doc)) return 'scene document is not a map';
  if (!Array.isArray(doc.root)) return '`root` is not a list of nodes';
  const visit = (nodes: unknown[], where: string): string | null => {
    for (const [index, node] of nodes.entries()) {
      const at = `${where}[${index}]`;
      if (!isMap(node)) return `${at} is not a node map`;
      if (typeof node.id !== 'string' || node.id.length === 0) return `${at} has no string id`;
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) return `${at}.children is not a list`;
        const inner = visit(node.children, `${at}.children`);
        if (inner) return inner;
      }
    }
    return null;
  };
  return visit(doc.root, 'root');
}
