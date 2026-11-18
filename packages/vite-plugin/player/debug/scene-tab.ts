import type { LiveObjectDetail, LiveMaterial, Vec3 } from './inspect';
import { escapeHtml, row, section } from './markup';
import type { DebugSession } from './session';
import type { LiveTree, LiveTreeNode } from './tree';

/**
 * The overlay's Scene tab: the live object tree (`DebugSession.tree()`) with a text filter, the
 * detail of the selected object (`node()`) and its highlight in the game (`highlight()`).
 * Read-only, but for two draw switches over the game — Colliders and Axes. The tree is read when
 * the tab opens and on Refresh, never on a timer: a scene of hundreds of objects is a walk and a
 * DOM rebuild the game should not pay every frame.
 */

const INDENT_PX = 12;

const vec = (v: Vec3): string => `${v.x}, ${v.y}, ${v.z}`;

const materialRows = (materials: readonly LiveMaterial[]): string =>
  materials
    .map((m, i) => {
      const at = materials.length > 1 ? `[${i}] ` : '';
      const props = [
        m.color ? `<i class="swatch" style="background:${m.color}"></i>${m.color}` : '',
        m.opacity !== undefined ? `opacity ${m.opacity}` : '',
        m.transparent ? 'transparent' : '',
        m.map ? 'map' : '',
        m.side ?? '',
      ].filter(Boolean);
      return row(`${at}${m.type}`, props.join(' · ') || '–');
    })
    .join('');

const entries = (record: Record<string, string>): string =>
  Object.entries(record)
    .map(([key, value]) => row(key, escapeHtml(value)))
    .join('');

const renderDetail = (d: LiveObjectDetail, inEditor: boolean): string => {
  const chips =
    (d.instances !== null ? `<span class="chip">×${d.instances}</span>` : '') +
    (d.visible ? '' : '<span class="chip off">HIDDEN</span>');
  const parts = [
    `<div class="detail-head"><span class="type">${escapeHtml(d.type)}</span><span class="name">${escapeHtml(d.name)}</span>${chips}${inEditor && d.nodeId ? '<button type="button" data-action="show-in-editor" title="Select this node in the Pix3 editor">Show in editor</button>' : ''}<button type="button" data-action="clear" title="Clear the selection and the highlight">Clear</button></div>`,
    section(
      'Object',
      row('id', escapeHtml(d.id)) +
        row('node', d.nodeId ? 'authored' : '<span class="muted">made at run time</span>') +
        row('render order / layers', `${d.renderOrder} / ${d.layers.join(', ')}`) +
        row('children', String(d.childCount))
    ),
    section(
      'World',
      row('position', vec(d.world.position)) +
        row('rotation°', vec(d.world.rotationDeg)) +
        row('scale', vec(d.world.scale))
    ),
    section(
      'Local',
      row('position', vec(d.local.position)) +
        row('rotation°', vec(d.local.rotationDeg)) +
        row('scale', vec(d.local.scale))
    ),
  ];
  if (d.geometry) {
    parts.push(
      section(
        'Geometry',
        row('type', escapeHtml(d.geometry.type)) +
          row('vertices', d.geometry.vertices === null ? '–' : String(d.geometry.vertices)) +
          entries(d.geometry.params)
      )
    );
  }
  if (d.materials.length > 0) parts.push(section('Material', materialRows(d.materials)));
  if (d.components.length > 0) {
    parts.push(
      section('Components', d.components.map(type => `<div>${escapeHtml(type)}</div>`).join(''))
    );
  }
  if (Object.keys(d.properties).length > 0)
    parts.push(section('Properties', entries(d.properties)));
  if (Object.keys(d.userData).length > 0) parts.push(section('userData', entries(d.userData)));
  return parts.join('');
};

const drawOf = (input: HTMLInputElement): 'physicsWireframe' | 'directionAxes' =>
  input.dataset.draw === 'physicsWireframe' ? 'physicsWireframe' : 'directionAxes';

const matches = (node: LiveTreeNode, filter: string): boolean =>
  node.type.toLowerCase().includes(filter) ||
  node.name.toLowerCase().includes(filter) ||
  (node.nodeId?.toLowerCase().includes(filter) ?? false);

export class SceneTab {
  private readonly filterInput: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  /** The Colliders / Axes switches (`DebugSession.physicsWireframe` / `directionAxes`). */
  private readonly draws: readonly HTMLInputElement[];
  private tree: LiveTree | null = null;
  private filter = '';
  private selected: string | null = null;
  /** Rows whose open state the user flipped from its default. */
  private readonly toggled = new Set<string>();

  constructor(
    private readonly session: DebugSession,
    container: HTMLElement,
    /** "Show in editor" on an authored node, on a page the editor opened (plan play-in-page S4). */
    private readonly showInEditor: ((nodeId: string) => void) | null = null
  ) {
    container.innerHTML = `<div class="scene-bar"><input type="search" placeholder="Filter: type, name, id" spellcheck="false" aria-label="Filter the tree"><button type="button" data-action="refresh" title="Read the live scene again">Refresh</button></div>
<div class="scene-bar draw"><label title="Draw the physics colliders over the game"><input type="checkbox" data-draw="physicsWireframe"> Colliders</label><label title="Draw every node's local axes (X red, Y green, Z blue)"><input type="checkbox" data-draw="directionAxes"> Axes</label></div>
<div class="scene-count muted"></div>
<div class="tree" role="tree"></div>
<div class="detail"></div>`;
    const pick = <T extends Element>(selector: string): T => container.querySelector(selector) as T;
    this.filterInput = pick('input[type="search"]');
    this.draws = [...container.querySelectorAll<HTMLInputElement>('[data-draw]')];
    this.count = pick('.scene-count');
    this.list = pick('.tree');
    this.detail = pick('.detail');
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.renderTree();
    });
    container.addEventListener('click', this.onClick);
    for (const input of this.draws) {
      input.addEventListener('change', () => this.session[drawOf(input)](input.checked));
    }
  }

  /** Read the live tree and the selected object again. */
  refresh(): void {
    // An agent may have flipped them through `__PIX3_PLAYER__.debug`.
    for (const input of this.draws) input.checked = this.session[drawOf(input)]();
    this.tree = this.session.tree();
    this.renderTree();
    this.renderDetail();
  }

  private readonly onClick = (event: Event): void => {
    const target = event.target as Element;
    const action = target.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'refresh') return this.refresh();
    if (action === 'clear') return this.select(null);
    if (action === 'show-in-editor') {
      const nodeId = this.selected === null ? null : this.session.node(this.selected)?.nodeId;
      if (nodeId) this.showInEditor?.(nodeId);
      return;
    }
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    if (!id) return;
    if (action === 'toggle') {
      if (!this.toggled.delete(id)) this.toggled.add(id);
      this.renderTree();
    } else {
      this.select(id);
    }
  };

  private select(id: string | null): void {
    this.selected = id;
    this.session.highlight(id);
    this.renderTree();
    this.renderDetail();
  }

  /** Open by default when it holds authored nodes; a mesh's raw internals stay closed. */
  private isOpen(node: LiveTreeNode): boolean {
    const open = node.children.some(child => child.nodeId !== null);
    return this.toggled.has(node.id) ? !open : open;
  }

  private renderTree(): void {
    const tree = this.tree;
    if (!tree) return;
    const filter = this.filter;
    const rows: string[] = [];
    let matched = 0;
    /** Rows of `node`'s subtree; with a filter only matches and their ancestors, all open. */
    const visit = (node: LiveTreeNode, depth: number): string[] => {
      const own = filter !== '' && matches(node, filter);
      if (own) matched += 1;
      const open = filter !== '' || this.isOpen(node);
      const below: string[] = [];
      if (open) {
        for (const child of node.children) below.push(...visit(child, depth + 1));
      }
      if (filter !== '' && !own && below.length === 0) return [];
      const twisty = node.children.length === 0 ? 'leaf' : open ? 'open' : 'closed';
      const chips =
        (node.instances !== null ? `<span class="chip">×${node.instances}</span>` : '') +
        (node.visible ? '' : '<span class="chip off">HIDDEN</span>') +
        (node.more > 0 ? `<span class="muted">+${node.more}</span>` : '');
      const cls = [
        'node',
        node.id === this.selected ? 'selected' : '',
        node.visible ? '' : 'hidden',
        own ? 'match' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const title = escapeHtml(node.nodeId ? `#${node.nodeId}` : node.id);
      return [
        `<div class="${cls}" data-id="${escapeHtml(node.id)}" role="treeitem" title="${title}" style="padding-left:${depth * INDENT_PX}px"><span class="twisty ${twisty}" data-action="toggle"></span><span class="type">${escapeHtml(node.type)}</span><span class="name">${escapeHtml(node.name)}</span>${chips}</div>`,
        ...below,
      ];
    };
    for (const root of tree.roots) rows.push(...visit(root, 0));
    this.list.innerHTML = rows.join('') || '<div class="muted">nothing matches</div>';
    this.count.textContent =
      `${tree.count.toLocaleString('en-US')} objects${tree.truncated ? ' (capped)' : ''}` +
      (filter ? ` · ${matched} match` : '');
  }

  private renderDetail(): void {
    const detail = this.selected === null ? null : this.session.node(this.selected);
    if (this.selected !== null && !detail) {
      // Gone from the scene since it was picked.
      this.selected = null;
      this.session.highlight(null);
    }
    this.detail.innerHTML = detail
      ? renderDetail(detail, this.showInEditor !== null)
      : '<div class="muted">Pick an object to see it in detail and box it in the game.</div>';
  }
}
