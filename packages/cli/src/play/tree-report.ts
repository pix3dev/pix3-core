/**
 * `pix3 play --tree`: the shape of the page's live object tree (`liveTree` in
 * `packages/vite-plugin/player/debug/tree.ts`, browser code the CLI bundles but does not import)
 * and its human lines.
 */

export interface PlayTreeNode {
  readonly id: string;
  readonly nodeId: string | null;
  readonly type: string;
  readonly name: string;
  readonly visible: boolean;
  readonly instances: number | null;
  readonly children: readonly PlayTreeNode[];
  readonly more: number;
}

export interface PlayTree {
  readonly count: number;
  readonly truncated: boolean;
  readonly roots: readonly PlayTreeNode[];
}

/** One line per object, two spaces a level: `Type#nodeId` for a node, `Type "name"` otherwise. */
export const formatTreeHuman = (tree: PlayTree | { error: string }): string[] => {
  if ('error' in tree) return [`tree: not read — ${tree.error}`];
  const lines = [`tree: ${tree.count} object(s)${tree.truncated ? ', capped' : ''}`];
  const visit = (node: PlayTreeNode, depth: number): void => {
    const label = node.nodeId
      ? `${node.type}#${node.nodeId}${node.name && node.name !== node.nodeId ? ` "${node.name}"` : ''}`
      : `${node.type}${node.name ? ` "${node.name}"` : ''}`;
    const marks = [
      node.instances !== null ? `×${node.instances}` : '',
      node.visible ? '' : 'hidden',
      node.more > 0 ? `(+${node.more} more)` : '',
    ].filter(Boolean);
    lines.push(`${'  '.repeat(depth + 1)}${[label, ...marks].join(' ')}`);
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of tree.roots) visit(root, 0);
  return lines;
};
