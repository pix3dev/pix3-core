import { describe, expect, it, vi } from 'vitest';
import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { ScriptRegistry } from './ScriptRegistry';

// PipeBlast's board: dozens of instances of one cell prefab, and the browser fetched
// cell.pix3scene once per instance on every load.
const cell = `version: 1.0.0
root:
  - id: cell-root
    type: Group2D
    name: Cell
    children:
      - id: pipe
        instance: res://scenes/prefabs/pipe.pix3scene
`;
const pipe = `version: 1.0.0
root:
  - id: pipe-root
    type: Group2D
    name: Pipe
`;
const board = `version: 1.0.0
root:
  - id: board
    type: Group2D
    name: Board
    children:
${Array.from({ length: 8 }, (_, i) => `      - id: cell-${i}\n        instance: res://scenes/prefabs/cell.pix3scene`).join('\n')}
`;

function createLoader() {
  const resources = new ResourceManager('./', {
    'scenes/prefabs/cell.pix3scene': { text: cell },
    'scenes/prefabs/pipe.pix3scene': { text: pipe },
  });
  const readText = vi.spyOn(resources, 'readText');
  const loader = new SceneLoader(
    new AssetLoader(resources, new AudioService()),
    new ScriptRegistry(),
    resources
  );
  return { loader, readText };
}

describe('SceneLoader: one read per prefab per load', () => {
  it('reads a prefab (and its nested prefab) once however many instances the scene has', async () => {
    const { loader, readText } = createLoader();
    const graph = await loader.parseScene(board, { filePath: 'res://scenes/main.pix3scene' });

    const paths = readText.mock.calls.map(call => call[0]);
    expect(paths.filter(p => p.endsWith('cell.pix3scene'))).toHaveLength(1);
    expect(paths.filter(p => p.endsWith('pipe.pix3scene'))).toHaveLength(1);

    // Every instance is still its own subtree with unique ids.
    const cells = graph.rootNodes[0].children;
    expect(cells).toHaveLength(8);
    expect(new Set(cells.map(c => c.nodeId)).size).toBe(8);
    expect(new Set(cells.map(c => c.children[0]))).toHaveProperty('size', 8);
    expect(graph.nodeMap.size).toBe(1 + 8 * 2);
  });

  it('does not keep prefabs between loads, so an edited prefab is read again', async () => {
    const { loader, readText } = createLoader();
    await loader.parseScene(board);
    await loader.parseScene(board);
    expect(readText.mock.calls.filter(c => c[0].endsWith('cell.pix3scene'))).toHaveLength(2);
  });
});
