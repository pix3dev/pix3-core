/**
 * What `pix3 play --screens` measures on the page of each picture: the CSS px size of every press
 * target and every caption's font, and the captions hidden for a second frame (the glyph mask of
 * the contrast check, `packages/cli/src/play/screen-checks.ts`).
 *
 * A press target is what the runtime picks: a control at a point where `UIControl2D.pointerTargetAt`
 * answers that very control. Its area is measured by asking that over the screen, 1 CSS px apart,
 * from the node's origin outwards — so the size is the area a finger really gets, through every
 * projection on the way (`setDesignFit`, the safe area, a Camera2D, the overlay band, the screen's
 * edges), less what a blocker or another control covers; a rotated control is measured by its own
 * sides. A target covered everywhere is left out, as is a disabled one.
 *
 * A caption is **covered** when something drawn after it hides its box: every sample point of the
 * box (its centre and four points near the corners) lies inside a visible mesh of a later paint
 * slot — the overlay band (`CanvasLayer2D`) after the main 2D pass, then `renderOrder`, which the
 * runtime stamps from the tree order and z each frame — whose material is at least
 * {@link COVER_MIN_OPACITY} opaque. Another caption's glyph plane never covers (it is mostly
 * empty). A covered caption is reported, not judged: a modal's dimmer over the HUD is meant to
 * dim it. What this misses: a mesh's box is taken as solid, so a sprite whose picture is mostly
 * transparent over the caption (a glow, a frame with a hole) covers it here though the text shows.
 *
 * No value imports, `three` and `@pix3/runtime` included: the CLI bundles this file into a page
 * script for a built page too (`packages/cli/src/play/bundle.ts`); nodes are read by shape.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A rectangle in CSS px of the page, axis-aligned. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const applyAffine = (m: Affine, p: Point): Point => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

export const invertAffine = (m: Affine): Affine | null => {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
};

/**
 * The affine map a projection is, read from three of its points. The 2D pass is orthographic, so
 * screen → world (`Node2D.screenPointToWorld`) is affine and three samples give all of it.
 */
export const affineFromSamples = (map: (x: number, y: number) => Point | null): Affine | null => {
  const span = 100;
  const o = map(0, 0);
  const x = map(span, 0);
  const y = map(0, span);
  if (!o || !x || !y) return null;
  return {
    a: (x.x - o.x) / span,
    b: (x.y - o.y) / span,
    c: (y.x - o.x) / span,
    d: (y.y - o.y) / span,
    e: o.x,
    f: o.y,
  };
};

/**
 * The connected area `hit` accepts around `seed`, as the centres of `step`-sized cells inside
 * `bounds` (from 0 to `width` / `height`); null when it grows past `cap` cells.
 */
export const fillRegion = (
  seed: Point,
  step: number,
  bounds: { readonly width: number; readonly height: number },
  hit: (x: number, y: number) => boolean,
  cap: number
): Point[] | null => {
  const columns = Math.floor(bounds.width / step);
  const rows = Math.floor(bounds.height / step);
  const start = { i: Math.floor(seed.x / step), j: Math.floor(seed.y / step) };
  const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < columns && j < rows;
  const centre = (i: number, j: number): Point => ({ x: (i + 0.5) * step, y: (j + 0.5) * step });
  if (!inside(start.i, start.j)) return null;
  const seen = new Set<number>([start.j * columns + start.i]);
  const queue = [start];
  const cells: Point[] = [];
  while (queue.length > 0) {
    const { i, j } = queue.pop()!;
    const at = centre(i, j);
    if (!hit(at.x, at.y)) continue;
    cells.push(at);
    if (cells.length > cap) return null;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ni = i + di;
      const nj = j + dj;
      const key = nj * columns + ni;
      if (!inside(ni, nj) || seen.has(key)) continue;
      seen.add(key);
      queue.push({ i: ni, j: nj });
    }
  }
  return cells;
};

/** Andrew's monotone chain, counter-clockwise, collinear points dropped. */
export const convexHull = (points: readonly Point[]): Point[] => {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (sorted.length <= 2) return sorted;
  const cross = (o: Point, p: Point, q: Point): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const half = (list: readonly Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
};

/**
 * How far `hit` holds from `from` along the unit `direction`: walked in `step`s to the first miss,
 * then bisected to a 64th of a step.
 */
const reach = (
  from: Point,
  direction: Point,
  step: number,
  hit: (x: number, y: number) => boolean
): number => {
  const at = (t: number): boolean => hit(from.x + direction.x * t, from.y + direction.y * t);
  let inside = 0;
  while (inside < 1e4 && at(inside + step)) inside += step;
  let outside = inside + step;
  for (let round = 0; round < 6; round += 1) {
    const middle = (inside + outside) / 2;
    if (at(middle)) inside = middle;
    else outside = middle;
  }
  return (inside + outside) / 2;
};

/**
 * The sides of the narrowest box around cells of `step` (its short side is the area's least
 * width, taken flush with a hull edge — the rotating-calipers rule): a rotated rectangle gives its
 * own sides, a disc its diameter twice. `width` is the side nearer the horizontal. With `hit`, both
 * sides are then measured exactly through the cells' centre along those two directions (a convex
 * area; one whose centre misses keeps the cell count, good to a `step`).
 */
export const regionSides = (
  cells: readonly Point[],
  step: number,
  hit?: (x: number, y: number) => boolean
): { width: number; height: number } => {
  const hull = convexHull(cells);
  if (hull.length === 0) return { width: 0, height: 0 };
  let best = { across: 0, along: 0, u: { x: 1, y: 0 } };
  if (hull.length > 1) {
    best.across = Infinity;
    for (let index = 0; index < hull.length; index += 1) {
      const p = hull[index];
      const q = hull[(index + 1) % hull.length];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length === 0) continue;
      const u = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
      let across = 0;
      let low = Infinity;
      let high = -Infinity;
      for (const r of hull) {
        across = Math.max(across, Math.abs((r.x - p.x) * -u.y + (r.y - p.y) * u.x));
        const along = r.x * u.x + r.y * u.y;
        low = Math.min(low, along);
        high = Math.max(high, along);
      }
      if (across < best.across) best = { across, along: high - low, u };
    }
  }
  let short = best.across + step;
  let long = best.along + step;
  const centre = {
    x: cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length,
    y: cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length,
  };
  if (hit && hit(centre.x, centre.y)) {
    const { u } = best;
    const n = { x: -u.y, y: u.x };
    const span = (d: Point): number =>
      reach(centre, d, step, hit) + reach(centre, { x: -d.x, y: -d.y }, step, hit);
    long = span(u);
    short = span(n);
  }
  return Math.abs(best.u.x) >= Math.abs(best.u.y)
    ? { width: long, height: short }
    : { width: short, height: long };
};

const boundsOf = (points: readonly Point[]): Rect => {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

// ---- the page side: live nodes read by shape -------------------------------------------------

interface ShapeMatrix {
  readonly elements: ArrayLike<number>;
}

/** A live object: what every node and mesh of the 2D tree has. */
interface ShapeObject {
  readonly type?: string;
  readonly name?: string;
  readonly nodeId?: unknown;
  readonly visible?: boolean;
  readonly children?: readonly ShapeObject[];
  readonly matrixWorld?: ShapeMatrix;
  updateWorldMatrix?(updateParents: boolean, updateChildren: boolean): void;
}

/** A mesh of the 2D tree, as the paint-order cover test reads it. */
interface ShapeMesh extends ShapeObject {
  readonly isMesh: true;
  readonly parent?: ShapeObject | null;
  readonly renderOrder: number;
  readonly layers: { readonly mask: number };
  readonly material: ShapeMaterial | readonly ShapeMaterial[];
  readonly geometry: {
    boundingBox: { min: Point; max: Point } | null;
    computeBoundingBox(): void;
  };
}

interface ShapeMaterial {
  readonly opacity: number;
}

/** A 2D node: what maps a screen point (input units) to world units in its own band. */
interface ShapeNode2D extends ShapeObject {
  screenPointToWorld(x: number, y: number): Point | null;
}

/** A `UIControl2D`: a press target, a caption, or both. */
interface ShapeControl extends ShapeObject {
  readonly nodeId: string;
  acceptsPressAt(x: number, y: number): boolean;
  pointerTargetAt(x: number, y: number): unknown;
  screenPointToWorld(x: number, y: number): Point | null;
  isVisibleInTree(): boolean;
  getDisplayText(): string;
  readonly labelFontSize: number;
  readonly labelOutlineWidth?: number;
  /** The caption's plane (1×1, scaled to the text box); protected in the runtime. */
  readonly labelMesh?: {
    visible: boolean;
    readonly matrixWorld: ShapeMatrix;
    readonly renderOrder?: number;
    readonly layers?: { readonly mask: number };
  } | null;
  readonly input?: ShapeInput;
}

interface ShapeInput {
  readonly width: number;
  readonly height: number;
  syncElementSize(): { left: number; top: number; width: number; height: number } | null;
}

/** The runner as `__PIX3_PLAYER__.runner` is. */
export interface ShapeRunner {
  getLiveRootNodes(): readonly unknown[];
  renderOnce(): boolean;
}

const isControl = (value: ShapeObject): value is ShapeControl => {
  const node = value as Partial<ShapeControl>;
  return (
    typeof node.nodeId === 'string' &&
    typeof node.acceptsPressAt === 'function' &&
    typeof node.pointerTargetAt === 'function' &&
    typeof node.getDisplayText === 'function'
  );
};

const controlsOf = (runner: ShapeRunner): ShapeControl[] => {
  const out: ShapeControl[] = [];
  const stack = [...(runner.getLiveRootNodes() as ShapeObject[])].reverse();
  while (stack.length > 0) {
    const object = stack.pop()!;
    if (isControl(object)) out.push(object);
    stack.push(...[...(object.children ?? [])].reverse());
  }
  return out;
};

/** One press target on the screen: its area's sides and its box, CSS px of the page. */
export interface ScreenTarget {
  readonly node: string;
  readonly type: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly box: Rect;
}

/** One caption on the screen: its font size and box, CSS px of the page. */
export interface ScreenText {
  readonly node: string;
  readonly type: string;
  readonly name: string;
  readonly fontPx: number;
  readonly outline: boolean;
  readonly box: Rect;
  /** What is drawn over the whole caption (over its centre), when something is. */
  readonly coveredBy?: { readonly node: string; readonly type: string; readonly name: string };
}

export interface ScreenMeasure {
  /** The page's viewport, CSS px: what the picture shows. */
  readonly viewport: { readonly width: number; readonly height: number };
  readonly targets: readonly ScreenTarget[];
  readonly texts: readonly ScreenText[];
}

/** Cells a target's area may have before it is measured on a coarser grid. */
const MAX_CELLS = 40_000;

/** The least material opacity of a mesh that covers a caption (a modal's dimmer is ~0.6–0.8). */
export const COVER_MIN_OPACITY = 0.5;

/** The overlay band's three.js layer (`LAYER_2D_OVERLAY` in the runtime: a `CanvasLayer2D`). */
const OVERLAY_LAYER_BIT = 1 << 3;

/** Where a mesh is in paint order: the overlay band after the main pass, then `renderOrder`. */
const paintSlot = (mesh: {
  readonly renderOrder?: number;
  readonly layers?: { readonly mask: number };
}): [number, number] => [
  (mesh.layers?.mask ?? 0) & OVERLAY_LAYER_BIT ? 1 : 0,
  mesh.renderOrder ?? 0,
];

const later = (one: [number, number], two: [number, number]): boolean =>
  one[0] !== two[0] ? one[0] > two[0] : one[1] > two[1];

/** A mesh that could cover a caption, with how to ask whether a screen point is on it. */
interface Cover {
  readonly slot: [number, number];
  readonly owner: { node: string; type: string; name: string };
  contains(x: number, y: number): boolean;
}

const isMesh = (value: ShapeObject): value is ShapeMesh =>
  (value as Partial<ShapeMesh>).isMesh === true && !!(value as Partial<ShapeMesh>).geometry;

/**
 * Every visible, mostly opaque mesh of the live 2D tree, but the captions' own planes (`captions`):
 * the candidates that can be drawn over a caption.
 */
const coversOf = (runner: ShapeRunner, captions: ReadonlySet<unknown>): Cover[] => {
  const out: Cover[] = [];
  const walk = (object: ShapeObject, owner: ShapeNode2D | null, node: ShapeObject | null): void => {
    if (object.visible === false) return;
    const asNode = object as Partial<ShapeNode2D>;
    const ownerHere =
      typeof asNode.screenPointToWorld === 'function' ? (object as ShapeNode2D) : owner;
    const nodeHere = typeof object.nodeId === 'string' ? object : node;
    if (isMesh(object) && ownerHere && nodeHere && !captions.has(object)) {
      const materials = Array.isArray(object.material)
        ? (object.material as readonly ShapeMaterial[])
        : [object.material as ShapeMaterial];
      const opaque = materials.some(material => (material?.opacity ?? 0) >= COVER_MIN_OPACITY);
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      const e = object.matrixWorld?.elements;
      const toLocal = e && invertAffine({ a: e[0], b: e[1], c: e[4], d: e[5], e: e[12], f: e[13] });
      if (opaque && bounds && toLocal) {
        const mapper = ownerHere;
        out.push({
          slot: paintSlot(object),
          owner: {
            node: String(nodeHere.nodeId),
            type: nodeHere.type ?? '',
            name: nodeHere.name ?? '',
          },
          contains: (x, y) => {
            const world = mapper.screenPointToWorld(x, y);
            if (!world) return false;
            const local = applyAffine(toLocal, { x: world.x, y: world.y });
            return (
              local.x >= bounds.min.x &&
              local.x <= bounds.max.x &&
              local.y >= bounds.min.y &&
              local.y <= bounds.max.y
            );
          },
        });
      }
    }
    for (const child of object.children ?? []) walk(child, ownerHere, nodeHere);
  };
  for (const root of runner.getLiveRootNodes() as ShapeObject[]) walk(root, null, null);
  return out;
};

/**
 * Measure the screen as it is now (`pix3 play --screens` pauses the runner and draws a frame
 * first, so the picture is the same frame). Null when no scene runs or nothing takes input.
 */
export const measureScreen = (runner: ShapeRunner | null): ScreenMeasure | null => {
  const controls = runner ? controlsOf(runner) : [];
  const input = controls.find(control => control.input)?.input;
  const rect = input?.syncElementSize();
  if (!input || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  for (const root of runner!.getLiveRootNodes() as ShapeObject[])
    root.updateWorldMatrix?.(true, true);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  // Canvas CSS px → input units (what `acceptsPressAt` takes), per axis.
  const sx = input.width / rect.width;
  const sy = input.height / rect.height;
  const toPage = (p: Point): Point => ({ x: rect.left + p.x / sx, y: rect.top + p.y / sy });
  // The part of the canvas on the page, canvas CSS px.
  const visible = {
    left: Math.max(0, -rect.left),
    top: Math.max(0, -rect.top),
    right: Math.min(rect.width, viewport.width - rect.left),
    bottom: Math.min(rect.height, viewport.height - rect.top),
  };

  const targets: ScreenTarget[] = [];
  const texts: ScreenText[] = [];
  const covers = coversOf(runner!, new Set(controls.map(control => control.labelMesh)));
  /** What covers the whole box (page CSS px) drawn after `slot`: the one over its centre. */
  const coverOf = (box: Rect, slot: [number, number]): Cover['owner'] | undefined => {
    const above = covers.filter(cover => later(cover.slot, slot));
    if (above.length === 0) return undefined;
    const inset = { x: box.width * 0.1, y: box.height * 0.1 };
    const points = [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + inset.x, y: box.y + inset.y },
      { x: box.x + box.width - inset.x, y: box.y + inset.y },
      { x: box.x + inset.x, y: box.y + box.height - inset.y },
      { x: box.x + box.width - inset.x, y: box.y + box.height - inset.y },
    ].map(p => ({ x: (p.x - rect.left) * sx, y: (p.y - rect.top) * sy }));
    const over = points.map(p => above.find(cover => cover.contains(p.x, p.y)));
    return over.every(Boolean) ? over[0]!.owner : undefined;
  };
  for (const control of controls) {
    // A copy each: the node answers in one scratch vector.
    const toWorld = affineFromSamples((x, y) => {
      const point = control.screenPointToWorld(x, y);
      return point && { x: point.x, y: point.y };
    });
    const toInput = toWorld && invertAffine(toWorld);
    if (!toInput) continue;
    const m = control.matrixWorld?.elements;
    const label = {
      node: control.nodeId,
      type: control.type ?? 'UIControl2D',
      name: control.name ?? '',
    };

    // Where a press lands on this control: it accepts it, and nothing above takes it first.
    const hit = (x: number, y: number): boolean =>
      x >= visible.left &&
      y >= visible.top &&
      x < visible.right &&
      y < visible.bottom &&
      control.acceptsPressAt(x * sx, y * sy) &&
      control.pointerTargetAt(x * sx, y * sy) === control;
    const origin = m ? applyAffine(toInput, { x: m[12], y: m[13] }) : null;
    let seed =
      origin && hit(origin.x / sx, origin.y / sy) ? { x: origin.x / sx, y: origin.y / sy } : null;
    // A hit shape off the node's origin: look for any point of it, 4 CSS px apart.
    for (let y = visible.top + 2; !seed && y < visible.bottom; y += 4)
      for (let x = visible.left + 2; !seed && x < visible.right; x += 4)
        if (hit(x, y)) seed = { x, y };
    if (seed) {
      let step = 1;
      let cells = fillRegion(seed, step, rect, hit, MAX_CELLS);
      while (!cells && step < 64) {
        step *= 2;
        cells = fillRegion(seed, step, rect, hit, MAX_CELLS);
      }
      if (cells) {
        const sides = regionSides(cells, step, hit);
        const box = boundsOf(cells);
        const half = step / 2;
        targets.push({
          ...label,
          ...sides,
          box: {
            x: rect.left + box.x - half,
            y: rect.top + box.y - half,
            width: box.width + step,
            height: box.height + step,
          },
        });
      }
    }

    const mesh = control.labelMesh;
    if (!m || !mesh || !mesh.visible || !control.isVisibleInTree() || !control.getDisplayText())
      continue;
    // The font's em, up the node's own y axis, through world → input → CSS px.
    const up = applyAffine(
      { ...toInput, e: 0, f: 0 },
      {
        x: m[4] * control.labelFontSize,
        y: m[5] * control.labelFontSize,
      }
    );
    const fontPx = Math.hypot(up.x / sx, up.y / sy);
    const e = mesh.matrixWorld.elements;
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ].map(([u, v]) =>
      toPage(
        applyAffine(toInput, { x: e[0] * u + e[4] * v + e[12], y: e[1] * u + e[5] * v + e[13] })
      )
    );
    const box = boundsOf(corners);
    const onScreen =
      box.x < viewport.width &&
      box.y < viewport.height &&
      box.x + box.width > 0 &&
      box.y + box.height > 0;
    if (onScreen) {
      const coveredBy = coverOf(box, paintSlot(mesh));
      texts.push({
        ...label,
        fontPx,
        outline: (control.labelOutlineWidth ?? 0) > 0,
        box,
        ...(coveredBy ? { coveredBy } : {}),
      });
    }
  }
  return { viewport, targets, texts };
};

let hiddenCaptions: { visible: boolean }[] = [];

/**
 * Hide every caption on the screen (or show again the ones this hid) and draw the frame: the
 * contrast check's second picture, the same frame without the glyphs.
 */
export const hideCaptions = (runner: ShapeRunner | null, hidden: boolean): boolean => {
  if (!runner) return false;
  if (hidden) {
    hiddenCaptions = controlsOf(runner)
      .map(control => control.labelMesh)
      .filter((mesh): mesh is NonNullable<typeof mesh> => !!mesh && mesh.visible);
    for (const mesh of hiddenCaptions) mesh.visible = false;
  } else {
    for (const mesh of hiddenCaptions) mesh.visible = true;
    hiddenCaptions = [];
  }
  return runner.renderOnce();
};
