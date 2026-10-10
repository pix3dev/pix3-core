import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { ifDefined } from 'lit/directives/if-defined.js';
import type { AssetActivation } from '@/services/assets/AssetFileActivationService';
import type { FileDescriptor } from '@/services/project/file-descriptor';
import { AssetsPreviewService } from '@/services/assets/AssetsPreviewService';
import { ProjectService } from '@/services/project/ProjectService';
import { AssetImportService } from '@/services/assets/AssetImportService';
import { IconService } from '@/services/editor/IconService';
import { computeDirectoryStats } from '@/services/assets/asset-folder-stats';
import { appState, type AssetBrowserViewMode } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { ASSET_CATEGORY_BY_ID, type AssetCategoryId } from '@/core/asset-categories';
import {
  buildGroupedTree,
  collectGroupedExpandedKeys,
  categoryIdFromPath,
  isCategoryPath,
  type AssetTreeNode as Node,
} from './grouped-asset-tree';
import './asset-tree.ts.css';
import { isReadOnlyTab } from '@/services/editor/read-only';

@customElement('pix3-asset-tree')
export class AssetTree extends ComponentBase {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;
  @inject(AssetImportService)
  private readonly assetImportService!: AssetImportService;
  @inject(IconService)
  private readonly iconService!: IconService;
  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;
  // Parent will handle actions via 'asset-activate' event

  // root path to show, defaults to project root
  @property({ type: String }) rootPath = '.';

  @state()
  private tree: Node[] = [];

  @state()
  private selectedPath: string | null = null;

  @state()
  private viewMode: AssetBrowserViewMode = 'folders';

  /** The mode `this.tree` was actually built for (lags `viewMode` during a switch). */
  private treeViewMode: AssetBrowserViewMode = 'folders';

  /** Disambiguates selection when the same real path appears under two categories. */
  private selectedCategoryId: AssetCategoryId | null = null;

  /** Public getter for selected path (avoid accessing private internals) */
  public getSelectedPath(): string | null {
    if (isCategoryPath(this.selectedPath)) {
      return null;
    }
    return this.selectedPath;
  }

  public getViewMode(): AssetBrowserViewMode {
    return this.viewMode;
  }

  public async setViewMode(mode: AssetBrowserViewMode): Promise<void> {
    if (mode === this.viewMode) {
      return;
    }
    this.viewMode = mode;
    appState.project.assetBrowserViewMode = mode;
    if (mode === 'folders') {
      this.selectedCategoryId = null;
    }
    await this.loadRoot();
    this.saveState();
  }

  /**
   * Resolves the directory that new assets should be placed in, based on the
   * current selection: a selected folder is used directly, a selected file
   * resolves to its parent directory, and no selection falls back to the
   * project root (`.`). Virtual category rows also fall back to the root.
   */
  public getTargetDirectory(): string {
    const selected = this.selectedPath;
    if (!selected || isCategoryPath(selected)) {
      return '.';
    }
    const found = this.findNodeByPath(selected);
    if (found?.node?.kind === 'directory') {
      return selected;
    }
    return this.getParentPath(selected);
  }

  /** Folder row (or `__TREE_ROOT__`) under an OS-file / generated-image drag. */
  @state()
  private dragOverPath: string | null = null;

  private disposeSubscription?: () => void;

  private treeRefreshQueue: Promise<void> = Promise.resolve();

  /** Recursively enumerates every project entry (files and directories). */
  private async walkProjectEntries(): Promise<FileDescriptor[]> {
    const collected: FileDescriptor[] = [];
    const collect = async (path: string): Promise<void> => {
      const entries = await this.listDirectory(path || '.');
      for (const entry of entries) {
        collected.push(entry);
        if (entry.kind === 'directory') {
          await collect(entry.path);
        }
      }
    };
    await collect(this.rootPath || '.');
    return collected;
  }

  /**
   * Clears the current tree selection (used by the panel's project-root row,
   * which selects the root outside the tree).
   */
  public clearSelection(): void {
    this.selectedPath = null;
    this.selectedCategoryId = null;
    this.requestUpdate();
    this.saveState();
  }

  /**
   * Programmatically select a file/folder by its path
   * Expands parent directories if needed and ensures the path is visible
   */
  public async selectPath(targetPath: string): Promise<boolean> {
    if (this.viewMode === 'by-type') {
      return await this.selectPathInGroupedTree(targetPath);
    }

    const normalizedPath = targetPath.startsWith('.') ? targetPath.slice(1) : targetPath;
    const searchPath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;

    const findAndSelectNode = async (nodes: Node[], pathSegments: string[]): Promise<boolean> => {
      const [currentSegment, ...remainingSegments] = pathSegments;

      for (const node of nodes) {
        if (node.name !== currentSegment) {
          continue;
        }

        if (remainingSegments.length === 0) {
          // Found the target node (a directory — files are no longer tree rows).
          this.selectedPath = node.path;
          void this.assetsPreviewService.syncFromAssetSelection(node.path, node.kind);
          this.tree = [...this.tree];
          return true;
        }

        if (node.kind === 'directory') {
          // Ensure this directory is expanded (loads children if needed).
          if (node.children === null || !node.expanded) {
            await this.expandNode(node);
          }
          if (node.children && (await findAndSelectNode(node.children, remainingSegments))) {
            return true;
          }
          // File fallback: the only unmatched segment left is the final one and
          // it isn't a directory node — it's a file, which no longer exists in
          // the folders-only tree. Select this deepest matched directory and let
          // the content grid select the parent folder + highlight the file.
          if (remainingSegments.length === 1) {
            this.selectedPath = node.path;
            void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
            this.tree = [...this.tree];
            return true;
          }
        }
      }
      return false;
    };

    // Split path into segments
    const pathSegments = this.splitPath(searchPath);

    // Start searching from root
    const found = await findAndSelectNode(this.tree, pathSegments);

    if (!found) {
      // Force refresh and try again
      await this.loadRoot();
      const retryFound = await findAndSelectNode(this.tree, pathSegments);
      if (retryFound) {
        this.saveState();
        return true;
      }

      // Root-level file: it has no parent directory node to anchor on (and is not
      // itself a tree row in the folders-only tree). Select the project root and
      // let the content grid highlight the file.
      const parent = this.getParentPath(targetPath);
      if (parent === '.' || parent === '') {
        this.selectedPath = null;
        this.selectedCategoryId = null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        this.saveState();
        return true;
      }

      console.warn('[AssetTree] Path not found in tree:', targetPath);
      return false;
    }

    this.saveState();
    return true;
  }

  /**
   * Reveal a real file/folder path inside the grouped view: expand its category and
   * the directory chain leading to it. Paths compacted away (intermediate chain
   * segments) are not present in the grouped tree and report a miss.
   */
  private async selectPathInGroupedTree(targetPath: string): Promise<boolean> {
    const normalized = this.normalizePath(this.normalizeTreePath(targetPath));
    if (!normalized || normalized === '.') {
      return false;
    }

    const tryReveal = (): boolean => {
      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.children) {
          continue;
        }
        const trail = this.findGroupedTrail(category.children, normalized);
        if (!trail) {
          continue;
        }
        category.expanded = true;
        for (const ancestor of trail.ancestors) {
          ancestor.expanded = true;
        }
        this.selectedPath = trail.node.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(trail.node.path, trail.node.kind);
        this.tree = [...this.tree];
        return true;
      }
      return false;
    };

    // File fallback: the path points at a file (no longer a grouped-tree node).
    // Select the deepest matched directory (or the category that lifted the
    // file's folder) and let the content grid highlight the file.
    const tryRevealFile = (): boolean => {
      const lastSlash = normalized.lastIndexOf('/');
      if (lastSlash < 0) {
        return false;
      }
      const parentPath = normalized.slice(0, lastSlash);

      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.children) {
          continue;
        }
        const trail = this.findGroupedTrail(category.children, parentPath);
        if (!trail || trail.node.kind !== 'directory') {
          continue;
        }
        category.expanded = true;
        for (const ancestor of trail.ancestors) {
          ancestor.expanded = true;
        }
        trail.node.expanded = true;
        this.selectedPath = trail.node.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        return true;
      }

      // The parent folder may have been lifted into its category row.
      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.folderPath) {
          continue;
        }
        if (this.normalizePath(category.folderPath) !== parentPath) {
          continue;
        }
        category.expanded = true;
        this.selectedPath = category.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        return true;
      }

      return false;
    };

    if (tryReveal()) {
      this.saveState();
      return true;
    }

    // Force refresh and try again (mirrors the folder-mode retry).
    await this.loadRoot();
    if (tryReveal()) {
      this.saveState();
      return true;
    }

    if (tryRevealFile()) {
      this.saveState();
      return true;
    }

    console.warn('[AssetTree] Path not found in grouped tree:', targetPath);
    return false;
  }

  private findGroupedTrail(
    nodes: Node[],
    normalizedPath: string,
    ancestors: Node[] = []
  ): { node: Node; ancestors: Node[] } | null {
    for (const node of nodes) {
      const nodePath = this.normalizePath(node.path);
      if (nodePath === normalizedPath) {
        return { node, ancestors: [...ancestors] };
      }
      if (
        node.kind === 'directory' &&
        node.children &&
        node.children.length > 0 &&
        normalizedPath.startsWith(`${nodePath}/`)
      ) {
        const found = this.findGroupedTrail(node.children, normalizedPath, [...ancestors, node]);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^[\\/]+/, '')
      .replace(/\\+/g, '/')
      .split('/')
      .filter(segment => segment.length > 0 && segment !== '.');
  }

  private normalizePath(path: string): string {
    const normalized = path
      .replace(/\\+/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return normalized || '.';
  }

  private sortNodes(nodes: Node[]): Node[] {
    return nodes.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name)
    );
  }

  private collectExpandedPaths(nodes: Node[], expandedPaths: Set<string>): void {
    for (const node of nodes) {
      if (node.kind === 'directory') {
        if (node.expanded) {
          expandedPaths.add(this.normalizePath(node.path));
        }
        if (node.children && node.children.length > 0) {
          this.collectExpandedPaths(node.children, expandedPaths);
        }
      }
    }
  }

  private async buildTreeFromExpandedPaths(
    directoryPath: string,
    expandedPaths: ReadonlySet<string>
  ): Promise<Node[]> {
    const entries = await this.listDirectory(directoryPath);
    const nextNodes: Node[] = [];

    for (const entry of entries) {
      // Folders-only tree: files are shown in the content grid, not as tree rows.
      // `listDirectory` still returns files (folder-size walk, external-change
      // signature, and create-existence checks depend on them) — exclude them
      // only here, at node-build time.
      if (entry.kind === 'file') {
        continue;
      }
      nextNodes.push(await this.createNodeFromEntry(entry, expandedPaths));
    }

    return this.sortNodes(nextNodes);
  }

  private async runSerializedTreeRefresh(task: () => Promise<void>): Promise<void> {
    const next = this.treeRefreshQueue.then(task, task);
    this.treeRefreshQueue = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  protected async firstUpdated(): Promise<void> {
    // Restore asset browser state (expanded folders and selected path) from localStorage
    await this.restoreState();

    // Subscribe only to lastModifiedDirectoryPath changes (file system changes)
    // Do not subscribe to lastOpenedScenePath (scene loading UI state)
    let previousModifiedDir = appState.project.lastModifiedDirectoryPath;
    let previousFileRefreshSignal = appState.project.fileRefreshSignal;
    let previousProjectId = appState.project.id;
    this.disposeSubscription = subscribe(appState.project, async () => {
      const modifiedDir = appState.project.lastModifiedDirectoryPath;
      const fileRefreshSignal = appState.project.fileRefreshSignal;
      const currentProjectId = appState.project.id;

      // Check if project changed - restore state for new project
      if (currentProjectId !== previousProjectId) {
        console.debug('[AssetTree] Project changed, restoring asset browser state', {
          previousProjectId,
          newProjectId: currentProjectId,
        });
        previousProjectId = currentProjectId;
        if (currentProjectId) {
          await this.loadRoot();
          await this.restoreState();
        }
        return;
      }

      // fileRefreshSignal guarantees refresh even for repeated updates in the same directory.
      if (fileRefreshSignal !== previousFileRefreshSignal) {
        previousFileRefreshSignal = fileRefreshSignal;
        previousModifiedDir = modifiedDir;
        console.debug('[AssetTree] Project file refresh signal received', {
          modifiedDirectory: modifiedDir,
          fileRefreshSignal,
        });
        if (modifiedDir) {
          await this.refreshDirectory(modifiedDir);
        } else {
          await this.loadRoot();
        }
        return;
      }

      // Fallback for code paths that still update only lastModifiedDirectoryPath.
      if (modifiedDir !== previousModifiedDir) {
        console.debug('[AssetTree] Project file refresh signal received', {
          modifiedDirectory: modifiedDir,
        });
        previousModifiedDir = modifiedDir;
        if (modifiedDir) {
          // Refresh only the affected directory
          await this.refreshDirectory(modifiedDir);
        } else {
          // If no specific directory indicated, refresh root
          await this.loadRoot();
        }
      }
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeSubscription?.();
  }

  /**
   * Saves current asset browser state (view mode, expanded paths/keys and selected path)
   * to appState and localStorage. Only the live tree's mode is re-collected; the other
   * mode keeps its last-saved expansion state.
   */
  private saveState(): void {
    if (this.treeViewMode === 'folders') {
      const expandedPaths = new Set<string>();
      this.collectExpandedPaths(this.tree, expandedPaths);
      appState.project.assetBrowserExpandedPaths = Array.from(expandedPaths);
    } else {
      const expandedKeys = new Set<string>();
      collectGroupedExpandedKeys(this.tree, expandedKeys);
      appState.project.assetBrowserGroupedExpandedKeys = Array.from(expandedKeys);
    }

    appState.project.assetBrowserSelectedPath = this.selectedPath;
    appState.project.assetBrowserViewMode = this.viewMode;

    this.projectService.saveAssetBrowserState({
      expandedPaths: appState.project.assetBrowserExpandedPaths,
      selectedPath: this.selectedPath,
      viewMode: this.viewMode,
      groupedExpandedKeys: appState.project.assetBrowserGroupedExpandedKeys,
    });
  }

  /**
   * Restores asset browser state (view mode, expanded paths and selected path) from localStorage.
   */
  private async restoreState(): Promise<void> {
    // First, load state from localStorage
    const loadedState = this.projectService.loadAssetBrowserState();

    if (loadedState) {
      // Update appState with loaded state
      appState.project.assetBrowserExpandedPaths = loadedState.expandedPaths;
      appState.project.assetBrowserSelectedPath = loadedState.selectedPath;
      appState.project.assetBrowserViewMode = loadedState.viewMode;
      appState.project.assetBrowserGroupedExpandedKeys = loadedState.groupedExpandedKeys;
      this.viewMode = loadedState.viewMode;
    }

    await this.loadRoot();

    if (loadedState && loadedState.selectedPath) {
      if (isCategoryPath(loadedState.selectedPath)) {
        this.selectedPath = loadedState.selectedPath;
        this.selectedCategoryId = categoryIdFromPath(loadedState.selectedPath);
        this.requestUpdate();
      } else {
        this.selectedPath = loadedState.selectedPath;
        await this.selectPath(loadedState.selectedPath);
      }
    }
  }

  private async listDirectory(path: string): Promise<FileDescriptor[]> {
    try {
      const entries = await this.projectService.listDirectory(path);
      return entries.filter(entry => !this.shouldExcludeEntry(entry));
    } catch {
      return [];
    }
  }

  private shouldExcludeEntry(entry: FileDescriptor): boolean {
    const normalizedPath = this.normalizePath(entry.path);
    const pathSegments = normalizedPath.split('/').filter(segment => segment.length > 0);

    if (entry.name.startsWith('.')) {
      return true;
    }

    if (entry.name === 'node_modules') {
      return true;
    }

    if (pathSegments.some(segment => segment.startsWith('.'))) {
      return true;
    }

    if (pathSegments.includes('node_modules')) {
      return true;
    }

    return false;
  }

  private async loadRoot(): Promise<void> {
    if (this.viewMode === 'by-type') {
      await this.loadGroupedRoot();
      return;
    }
    await this.loadFolderRoot();
  }

  private async loadFolderRoot(): Promise<void> {
    await this.runSerializedTreeRefresh(async () => {
      const expandedPaths = new Set<string>(appState.project.assetBrowserExpandedPaths || []);
      if (this.treeViewMode === 'folders') {
        this.collectExpandedPaths(this.tree, expandedPaths);
      }

      const nextTree = await this.buildTreeFromExpandedPaths(this.rootPath || '.', expandedPaths);
      this.tree = nextTree;
      this.treeViewMode = 'folders';

      if (this.selectedPath && !this.findNodeByPath(this.selectedPath)) {
        this.selectedPath = null;
        this.selectedCategoryId = null;
      }
    });
  }

  private async loadGroupedRoot(): Promise<void> {
    await this.runSerializedTreeRefresh(async () => {
      const expandedKeys = new Set<string>(appState.project.assetBrowserGroupedExpandedKeys || []);
      // Expand all categories only on first entry into the grouped view; while the
      // grouped tree is live, an empty set means the user collapsed everything.
      const defaultCategoryExpanded = expandedKeys.size === 0 && this.treeViewMode !== 'by-type';
      if (this.treeViewMode === 'by-type') {
        collectGroupedExpandedKeys(this.tree, expandedKeys);
      }

      const entries = await this.walkProjectEntries();
      const files = entries.filter(entry => entry.kind === 'file');
      this.tree = buildGroupedTree(files, {
        expandedKeys,
        defaultCategoryExpanded,
        // Folders-only tree: keep files in the trie (for compaction / sizes /
        // counts) but omit the file leaf nodes.
        includeFiles: false,
      });
      this.treeViewMode = 'by-type';

      if (this.selectedPath && !this.findNodeByPath(this.selectedPath)) {
        this.selectedPath = null;
        this.selectedCategoryId = null;
      }
    });
  }

  private async refreshDirectory(targetPath: string): Promise<void> {
    console.debug('[AssetTree] Refreshing tree from directory signal', { targetPath });
    await this.loadRoot();
  }

  private async expandNode(node: Node): Promise<void> {
    if (node.kind !== 'directory') return;
    if (node.children === null) {
      const entries = await this.listDirectory(node.path);
      const children: Node[] = [];
      for (const entry of entries) {
        // Folders-only tree: skip files (see buildTreeFromExpandedPaths).
        if (entry.kind === 'file') {
          continue;
        }
        children.push(await this.createNodeFromEntry(entry));
      }
      node.children = this.sortNodes(children);
    }
    node.expanded = true;
    // trigger update
    this.tree = [...this.tree];
    // Save state after expanding
    this.saveState();
  }

  private collapseNode(node: Node): void {
    node.expanded = false;
    this.tree = [...this.tree];
    // Save state after collapsing
    this.saveState();
  }

  private toggleNode(node: Node): void {
    if (node.expanded) this.collapseNode(node);
    else void this.expandNode(node);
  }

  private onSelect(node: Node): void {
    this.selectedCategoryId = node.categoryId ?? null;
    this.selectedPath = node.path;
    this.notifyAssetSelected(node);
    this.requestUpdate();

    // Save state after selection changes
    this.saveState();
  }

  private onNodeDoubleClick(event: MouseEvent, node: Node): void {
    event.preventDefault();
    event.stopPropagation();
    if (node.kind === 'directory') {
      this.toggleNode(node);
      return;
    }
    this.activateAsset(node);
  }

  private onNodeKeyDown(event: KeyboardEvent, node: Node): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onSelect(node);
      if (event.key === 'Enter') {
        this.activateAsset(node);
      }
    }
  }

  private activateAsset(node: Node): void {
    if (node.kind !== 'file') {
      return;
    }

    const normalizedPath = this.normalizeTreePath(node.path);
    if (!normalizedPath) {
      console.warn('[AssetTree] Asset path is empty', node);
      return;
    }

    const activation: AssetActivation = {
      name: node.name,
      path: node.path,
      kind: node.kind,
      resourcePath: this.buildResourcePath(normalizedPath),
      extension: this.getFileExtension(node.name),
    };

    this.dispatchEvent(
      new CustomEvent<AssetActivation>('asset-activate', {
        detail: activation,
        bubbles: true,
        composed: true,
      })
    );
  }

  private notifyAssetSelected(node: Node): void {
    if (node.nodeType === 'category') {
      // A category that compacted a single project folder opens that folder in the
      // preview; categories spanning multiple folders keep the preview untouched.
      if (node.folderPath) {
        void this.assetsPreviewService.syncFromAssetSelection(node.folderPath, 'directory');
      }
      return;
    }
    void this.assetsPreviewService.syncFromAssetSelection(node.path, node.kind);
    this.dispatchEvent(
      new CustomEvent('asset-selected', {
        detail: { path: node.path, kind: node.kind },
        bubbles: true,
        composed: true,
      })
    );
  }

  private buildResourcePath(normalizedPath: string): string {
    return `res://${normalizedPath}`;
  }

  private normalizeTreePath(path: string): string {
    return path.replace(/^(\.?\/)+/, '').replace(/^\/+/, '');
  }

  private getFileExtension(name: string): string {
    const lastDot = name.lastIndexOf('.');
    if (lastDot === -1 || lastDot === name.length - 1) {
      return '';
    }
    return name.substring(lastDot + 1).toLowerCase();
  }

  private async createNodeFromEntry(
    entry: FileDescriptor,
    expandedPaths?: ReadonlySet<string>
  ): Promise<Node> {
    const sizeBytes = await this.getNodeSizeBytes(entry);

    if (entry.kind === 'directory') {
      const isExpanded = expandedPaths?.has(this.normalizePath(entry.path)) ?? false;
      // The folders-only tree only expands directories that contain subdirectories;
      // a shallow listing tells us whether to render the expand triangle at all.
      const childEntries = await this.listDirectory(entry.path);
      const hasChildDirectories = childEntries.some(child => child.kind === 'directory');
      const directoryNode: Node = {
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        sizeBytes,
        expanded: isExpanded && hasChildDirectories,
        hasChildDirectories,
        children: isExpanded && hasChildDirectories ? [] : null,
      };

      if (directoryNode.expanded && expandedPaths) {
        directoryNode.children = await this.buildTreeFromExpandedPaths(entry.path, expandedPaths);
      }

      return directoryNode;
    }

    return {
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      sizeBytes,
      children: [],
    };
  }

  private async getNodeSizeBytes(entry: FileDescriptor): Promise<number | null> {
    if (entry.kind === 'file') {
      return entry.size ?? null;
    }

    return await this.getDirectoryContentSize(entry.path);
  }

  private async getDirectoryContentSize(directoryPath: string): Promise<number> {
    return (await computeDirectoryStats(this.projectService, directoryPath)).sizeBytes;
  }

  private getNodeMetaLabel(node: Node): string | null {
    if (node.sizeBytes === null) {
      return null;
    }

    return this.formatFileSize(node.sizeBytes);
  }

  private formatFileSize(sizeBytes: number): string {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }

    const kb = sizeBytes / 1024;
    if (kb < 1024) {
      return `${kb.toFixed(1)} KB`;
    }

    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  private isNodeSelected(node: Node): boolean {
    if (this.selectedPath !== node.path) {
      return false;
    }
    if (node.categoryId === undefined || this.selectedCategoryId === null) {
      return true;
    }
    return this.selectedCategoryId === node.categoryId;
  }

  private renderNode(node: Node, depth = 0): ReturnType<typeof html> {
    const isCategory = node.nodeType === 'category';
    const isSelected = this.isNodeSelected(node);
    const isDragOver = this.dragOverPath === node.path && node.kind === 'directory' && !isCategory;
    const metaLabel = isCategory ? null : this.getNodeMetaLabel(node);
    // Only directories with subdirectories are expandable in the folders-only tree.
    // Folder mode: `hasChildDirectories` (computed at build). Grouped mode: derived
    // from `children`. A category is expandable only when it has child rows — a
    // category that compacted a lone folder holding just files (shown in the content
    // grid, not the tree) has no subfolders, so it gets no expand arrow.
    const isExpandable = isCategory
      ? (node.children?.length ?? 0) > 0
      : node.kind === 'directory' &&
        (node.hasChildDirectories ?? ((node.children?.length ?? 0) > 0 || node.children === null));
    const nameContent =
      isCategory && node.folderLabel
        ? html`${node.name}<span class="node-name-suffix"> (${node.folderLabel})</span>`
        : node.name;
    return html`<div
      class="tree-node"
      data-path=${node.path}
      role="treeitem"
      aria-expanded=${ifDefined(
        node.kind === 'directory' ? (node.expanded ? 'true' : 'false') : undefined
      )}
    >
      <div
        class="node-row ${isSelected ? 'selected' : ''} ${isDragOver
          ? 'drag-over'
          : ''} ${isCategory ? 'node-row--category' : ''}"
        @click=${() => this.onSelect(node)}
        @dblclick=${(e: MouseEvent) => this.onNodeDoubleClick(e, node)}
        @keydown=${(e: KeyboardEvent) => this.onNodeKeyDown(e, node)}
        @dragover=${(e: DragEvent) => this.onDragOver(e, node)}
        @dragleave=${(e: DragEvent) => this.onDragLeave(e, node)}
        @drop=${(e: DragEvent) => this.onDrop(e, node)}
        tabindex="0"
      >
        ${isExpandable
          ? html`<button
              type="button"
              class="expander expander--visible expander--button ${node.expanded
                ? ''
                : 'expander--collapsed'}"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.toggleNode(node);
              }}
              aria-label=${node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            ></button>`
          : html`<span class="expander" aria-hidden="true"></span>`}
        ${isCategory
          ? this.categoryIcon(node)
          : node.kind === 'directory'
            ? this.folderIcon(!!node.expanded)
            : this.fileIcon()}
        <span class="node-name">${nameContent}</span>
        ${isCategory && node.fileCount !== undefined
          ? html`<span class="node-meta node-count">${node.fileCount}</span>`
          : metaLabel
            ? html`<span class="node-meta">${metaLabel}</span>`
            : null}
      </div>
      ${node.expanded && node.children && node.children.length
        ? html`<div class="node-children" role="group">
            ${node.children.map(child => this.renderNode(child, depth + 1))}
          </div>`
        : null}
    </div>`;
  }

  /**
   * Folder rows accept one drop, a copy into that folder: files from the OS (through
   * {@link AssetImportService}, the same path as the Import… dialog). Nothing is moved: files are
   * reorganised by the agent or the IDE.
   */
  private onDragOver(event: DragEvent, node: Node): void {
    if (node.nodeType === 'category' || node.kind !== 'directory' || !isAcceptedDrop(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.dragOverPath = node.path;
  }

  private onDragLeave(_event: DragEvent, node: Node): void {
    if (this.dragOverPath === node.path) {
      // A small delay lets the next row's dragover take over without a flicker.
      setTimeout(() => {
        if (this.dragOverPath === node.path) {
          this.dragOverPath = null;
        }
      }, 10);
    }
  }

  private async onDrop(event: DragEvent, node: Node): Promise<void> {
    if (node.nodeType === 'category' || node.kind !== 'directory' || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dragOverPath = null;
    await this.handleDrop(event.dataTransfer, node.path);
  }

  private onTreeDragOver(event: DragEvent): void {
    // In the grouped view the tree background is the category list, not the project root.
    if (this.viewMode === 'by-type' || !isAcceptedDrop(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    // Only highlight the root when no folder row has the drag.
    if (!this.dragOverPath || this.dragOverPath === '__TREE_ROOT__') {
      this.dragOverPath = '__TREE_ROOT__';
    }
  }

  private onTreeDragLeave(_event: DragEvent): void {
    setTimeout(() => {
      if (this.dragOverPath === '__TREE_ROOT__') {
        this.dragOverPath = null;
      }
    }, 10);
  }

  private async onTreeDrop(event: DragEvent): Promise<void> {
    if (this.viewMode === 'by-type' || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await this.handleRootDrop(event.dataTransfer);
  }

  /** A drop on the project root (the tree background or the panel's root row). */
  public async handleRootDrop(dataTransfer: DataTransfer): Promise<void> {
    await this.handleDrop(dataTransfer, '.');
  }

  private async handleDrop(dataTransfer: DataTransfer, targetDirectory: string): Promise<void> {
    this.dragOverPath = null;
    if (isReadOnlyTab()) {
      return;
    }
    const files = Array.from(dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    const result = await this.assetImportService.importFiles(files, targetDirectory);
    for (const failure of result.failures) {
      console.error('[AssetTree] Failed to import dropped file', failure);
    }
    // The listing refreshes from the write signal; reveal what arrived.
    if (result.importedPaths.length > 0) {
      await this.selectPath(result.importedPaths[0]);
    }
  }

  private folderIcon(open: boolean) {
    const title = open ? 'Open folder' : 'Closed folder';

    return html`<span class="icon folder" role="img" aria-label=${title} title=${title}>
      ${this.iconService.getIcon('folder-solid', 16)}
    </span>`;
  }

  private fileIcon() {
    const title = 'File';
    return html`<span class="icon file" role="img" aria-label=${title} title=${title}>
      ${this.iconService.getIcon('file-solid', 16)}
    </span>`;
  }

  private categoryIcon(node: Node) {
    const definition = node.categoryId ? ASSET_CATEGORY_BY_ID[node.categoryId] : null;
    return html`<span class="icon category" role="img" aria-label=${node.name} title=${node.name}>
      ${this.iconService.getIcon(definition?.icon ?? 'folder', 16)}
    </span>`;
  }

  protected render() {
    const isDragOverRoot = this.dragOverPath === '__TREE_ROOT__';
    return html`<div class="asset-tree-root">
      <div
        class="tree ${isDragOverRoot ? 'drag-over-root' : ''}"
        role="tree"
        aria-label="Assets"
        @dragover=${this.onTreeDragOver}
        @dragleave=${this.onTreeDragLeave}
        @drop=${this.onTreeDrop}
      >
        ${this.tree.length === 0
          ? html`<p class="empty">No assets</p>`
          : this.tree.map(n => this.renderNode(n))}
      </div>
    </div>`;
  }

  private getParentPath(path: string): string {
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length <= 1) return '.';
    return parts.slice(0, -1).join('/');
  }

  private findNodeByPath(path: string): { node?: Node; parent?: Node | null } | null {
    const stack: Array<{ node: Node; parent: Node | null }> = this.tree.map(n => ({
      node: n,
      parent: null,
    }));
    while (stack.length) {
      const { node, parent } = stack.shift()!;
      if (node.path === path) return { node, parent };
      if (node.children && node.children.length) {
        for (const child of node.children) stack.push({ node: child, parent: node });
      }
    }
    return null;
  }
}

/** OS files: the only drop a folder row accepts. */
function isAcceptedDrop(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) {
    return false;
  }
  return Array.from(transfer.items ?? []).some(item => item.kind === 'file');
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-asset-tree': AssetTree;
  }
}
