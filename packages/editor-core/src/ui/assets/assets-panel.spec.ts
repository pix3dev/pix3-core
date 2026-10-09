import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// golden-layout's CJS build (what Node resolves in specs) requires `tslib`, which it does not
// declare and the workspace does not install; nothing here needs a real layout.
vi.mock('golden-layout', () => ({ GoldenLayout: class {} }));

// Keep the heavy service and child-component modules out of the jsdom run: the panel
// only needs the injected classes to exist for the @inject decorators, and lightweight
// stub custom elements so the template renders and the `ref` callbacks resolve.
vi.mock('@/services', () => ({
  AssetFileActivationService: class AssetFileActivationService {},
  AssetsPreviewService: class AssetsPreviewService {},
  IconService: class IconService {},
  IconSize: { SMALL: 14, MEDIUM: 16, LARGE: 18, XLARGE: 24 },
}));
vi.mock('@/services/assets/AssetImportDialogService', () => ({
  AssetImportDialogService: class AssetImportDialogService {},
}));
vi.mock('@/services/project/ProjectService', () => ({ ProjectService: class ProjectService {} }));
vi.mock('@/services/scripting/ProjectScriptLoaderService', () => ({
  ProjectScriptLoaderService: class ProjectScriptLoaderService {},
}));

// Replace the real child/shared components with no-op modules; we register minimal
// stub elements below so the panel can query them and drive their public API.
vi.mock('../shared/pix3-panel', () => ({}));
vi.mock('../shared/pix3-toolbar', () => ({}));
vi.mock('../shared/pix3-toolbar-button', () => ({}));
vi.mock('./asset-tree', () => ({}));
vi.mock('./assets-content', () => ({}));

class StubAssetTree extends HTMLElement {
  clearSelection = vi.fn();
  selectPath = vi.fn(async () => true);
  setViewMode = vi.fn(async () => undefined);
  handleRootDrop = vi.fn(async () => undefined);
  getTargetDirectory = vi.fn(() => '.');
}

class StubAssetsContent extends HTMLElement {
  getSelectedPaths = vi.fn<() => string[]>(() => []);
}

class StubPassthrough extends HTMLElement {}

beforeAll(() => {
  customElements.define('pix3-asset-tree', StubAssetTree);
  customElements.define('pix3-assets-content', StubAssetsContent);
  customElements.define('pix3-panel', class extends StubPassthrough {});
  customElements.define('pix3-toolbar', class extends StubPassthrough {});
  customElements.define('pix3-toolbar-button', class extends StubPassthrough {});
});

await import('./assets-panel');
type AssetsPanelElement = HTMLElementTagNameMap['pix3-assets-panel'];

interface Stubs {
  assetsPreviewService: {
    subscribe: ReturnType<typeof vi.fn>;
    syncFromAssetSelection: ReturnType<typeof vi.fn>;
    clearSelectedItem: ReturnType<typeof vi.fn>;
  };
  projectService: {
    loadAssetBrowserState: ReturnType<typeof vi.fn>;
    saveAssetBrowserState: ReturnType<typeof vi.fn>;
  };
  assetImportDialogService: { showDialog: ReturnType<typeof vi.fn> };
}

function stubServices(panel: AssetsPanelElement, selectedFolderPath: string | null = '.'): Stubs {
  const assetsPreviewService = {
    subscribe: vi.fn((listener: (value: unknown) => void) => {
      listener({ selectedFolderPath });
      return () => undefined;
    }),
    syncFromAssetSelection: vi.fn(async () => undefined),
    clearSelectedItem: vi.fn(),
  };

  const projectService = {
    loadAssetBrowserState: vi.fn(() => null),
    saveAssetBrowserState: vi.fn(),
  };

  const assetImportDialogService = {
    showDialog: vi.fn(async () => ({ importedPaths: ['textures/hero.png'] })),
  };

  const iconService = { getIcon: vi.fn(() => 'icon') };

  const noop = {};
  for (const [key, value] of Object.entries({
    assetsPreviewService,
    projectService,
    iconService,
    assetFileActivation: noop,
    assetImportDialogService,
  })) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return { assetsPreviewService, projectService, assetImportDialogService } satisfies Stubs;
}

function tree(panel: AssetsPanelElement): StubAssetTree {
  return panel.querySelector('pix3-asset-tree') as unknown as StubAssetTree;
}

describe('AssetsPanel (Phase 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('root-row click clears the tree selection and syncs the project root', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    const stubs = stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    panel
      .querySelector<HTMLElement>('.tree-root-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tree(panel).clearSelection).toHaveBeenCalledTimes(1);
    expect(stubs.assetsPreviewService.syncFromAssetSelection).toHaveBeenCalledWith(
      '.',
      'directory'
    );
  });

  it('routes assets-preview:reveal-path window events to the tree', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    window.dispatchEvent(
      new CustomEvent('assets-preview:reveal-path', { detail: { path: 'textures/ui' } })
    );
    await Promise.resolve();

    expect(tree(panel).selectPath).toHaveBeenCalledWith('textures/ui');
  });

  it('group-by-type toggle calls setViewMode on the tree', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    panel
      .querySelector<HTMLButtonElement>('.root-action-btn[aria-label="Group by type"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tree(panel).setViewMode).toHaveBeenCalledWith('by-type');
  });

  it('offers Import… as the only root-row action besides grouping', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    const stubs = stubServices(panel, 'textures');
    document.body.appendChild(panel);
    await panel.updateComplete;

    const labels = Array.from(panel.querySelectorAll('.root-actions button')).map(button =>
      button.getAttribute('aria-label')
    );
    expect(labels).toEqual(['Import…', 'Group by type']);

    panel
      .querySelector<HTMLButtonElement>('.root-action-btn[aria-label="Import…"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(stubs.assetImportDialogService.showDialog).toHaveBeenCalledWith({
      targetDirectory: 'textures',
    });
    expect(tree(panel).selectPath).toHaveBeenCalledWith('textures/hero.png');
  });

  it('takes OS files on the root row and ignores an in-editor asset drag', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    const row = panel.querySelector<HTMLElement>('.tree-root-row');
    const dragOver = (dataTransfer: unknown): Event => {
      const event = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      row?.dispatchEvent(event);
      return event;
    };

    const assetDrag = dragOver({
      types: ['application/x-pix3-asset-path-list'],
      items: [{ kind: 'string' }],
      dropEffect: 'none',
    });
    expect(assetDrag.defaultPrevented).toBe(false);

    const osFiles = { types: ['Files'], items: [{ kind: 'file' }], dropEffect: 'none' };
    expect(dragOver(osFiles).defaultPrevented).toBe(true);
    expect(osFiles.dropEffect).toBe('copy');

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: osFiles });
    row?.dispatchEvent(drop);
    expect(tree(panel).handleRootDrop).toHaveBeenCalledWith(osFiles);
  });
});
