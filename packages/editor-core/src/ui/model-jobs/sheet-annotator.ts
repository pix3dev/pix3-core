import { svg } from 'lit';

import { ComponentBase, customElement, html, property, state } from '@/fw';
import type { ModelFeedbackMark, ModelPassSheet } from '@/core/model-jobs-format';

export type AnnotationTool = 'rect' | 'point' | 'path' | 'arrow';

type Point = readonly [number, number];

/**
 * Marks are drawn in this colour on screen and burned into the PNG the agent reads, so both show
 * the same thing (pixels of a picture, not editor chrome — no theme token applies to them).
 */
const MARK_COLOR = '#ff4d4f';
const MARK_OUTLINE = 'rgba(0, 0, 0, 0.8)';

/** A sheet's size in px: square tiles, `cols` per row (`model-sheet.ts`). */
const sheetSize = (sheet: ModelPassSheet): { width: number; height: number } => ({
  width: sheet.cols * sheet.tile,
  height: Math.ceil(sheet.views.length / sheet.cols) * sheet.tile,
});

/** Stroke width and point radius in sheet px, the same on screen and in the PNG. */
const lineOf = (sheet: ModelPassSheet): number => Math.max(3, Math.round(sheet.tile / 100));

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** An arrow in px: the shaft and the two barbs of its head, each `[x1, y1, x2, y2]`. */
const arrowLines = (
  from: Point,
  to: Point,
  width: number,
  height: number,
  line: number
): [number, number, number, number][] => {
  const [x1, y1, x2, y2] = [from[0] * width, from[1] * height, to[0] * width, to[1] * height];
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.min(line * 10, Math.hypot(x2 - x1, y2 - y1) * 0.6);
  const barb = (side: number): [number, number, number, number] => [
    x2,
    y2,
    x2 - head * Math.cos(angle + side * (Math.PI / 6)),
    y2 - head * Math.sin(angle + side * (Math.PI / 6)),
  ];
  return [[x1, y1, x2, y2], barb(1), barb(-1)];
};

/** The view of the tile under `(x, y)` (0..1 of the sheet); an empty last-row slot → last view. */
export const viewAt = (sheet: ModelPassSheet, x: number, y: number): string => {
  const rows = Math.ceil(sheet.views.length / sheet.cols);
  const col = Math.min(sheet.cols - 1, Math.floor(clamp01(x) * sheet.cols));
  const row = Math.min(rows - 1, Math.floor(clamp01(y) * rows));
  return sheet.views[Math.min(sheet.views.length - 1, row * sheet.cols + col)];
};

/** Where a mark sits for {@link viewAt}: a rect's centre, a point, a stroke's start, an arrow's head. */
const anchorOf = (mark: ModelFeedbackMark): Point => {
  if (mark.shape === 'rect') {
    const [x, y, w, h] = mark.rect;
    return [x + w / 2, y + h / 2];
  }
  if (mark.shape === 'arrow') return mark.to;
  return mark.shape === 'point' ? mark.point : mark.path[0];
};

/** Give a mark the view of its tile. */
export const withView = (sheet: ModelPassSheet, mark: ModelFeedbackMark): ModelFeedbackMark => ({
  ...mark,
  view: viewAt(sheet, ...anchorOf(mark)),
});

/**
 * The sheet at its natural size with the marks drawn over it, as PNG bytes — what
 * `feedback/<fid>.png` holds for the agent to Read.
 */
export const burnMarks = async (
  src: string,
  sheet: ModelPassSheet,
  marks: readonly ModelFeedbackMark[]
): Promise<Uint8Array> => {
  const image = new Image();
  image.src = src;
  await image.decode();
  const { width, height } = {
    width: image.naturalWidth || sheetSize(sheet).width,
    height: image.naturalHeight || sheetSize(sheet).height,
  };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas to draw the marks on.');
  ctx.drawImage(image, 0, 0, width, height);
  const line = lineOf(sheet);
  const trace = (mark: ModelFeedbackMark): void => {
    ctx.beginPath();
    if (mark.shape === 'rect') {
      const [x, y, w, h] = mark.rect;
      ctx.rect(x * width, y * height, w * width, h * height);
    } else if (mark.shape === 'point') {
      ctx.arc(mark.point[0] * width, mark.point[1] * height, line * 3, 0, Math.PI * 2);
    } else if (mark.shape === 'arrow') {
      for (const [x1, y1, x2, y2] of arrowLines(mark.from, mark.to, width, height, line)) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    } else {
      mark.path.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x * width, y * height) : ctx.lineTo(x * width, y * height)
      );
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [color, lineWidth] of [
    [MARK_OUTLINE, line + 3],
    [MARK_COLOR, line],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (const mark of marks) {
      trace(mark);
      ctx.stroke();
    }
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the marked sheet.');
  return new Uint8Array(await blob.arrayBuffer());
};

/**
 * A pass's sheet with marks over it, and — when `tool` is set — drawing a new one: drag a rect,
 * click a point, drag a freehand stroke, drag an arrow from its tail to what it points at. Coordinates are 0..1 of the whole sheet; the panel gives
 * each mark its view ({@link withView}). Emits `mark-add` with the mark (`view` still empty).
 */
@customElement('pix3-sheet-annotator')
export class SheetAnnotator extends ComponentBase {
  @property({ attribute: false }) src = '';
  @property({ attribute: false }) sheet: ModelPassSheet | null = null;
  @property({ attribute: false }) marks: readonly ModelFeedbackMark[] = [];
  /** Null: look only. */
  @property({ attribute: false }) tool: AnnotationTool | null = null;
  @property({ attribute: false }) label = '';

  @state() private draft: ModelFeedbackMark | null = null;
  /** The pointer drawing `draft`; others are ignored. */
  private pointerId: number | null = null;

  /** A stroke in progress belongs to the sheet (`src`: one file per pass) and tool it began on. */
  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('src') || changed.has('tool')) this.cancel();
  }

  disconnectedCallback(): void {
    this.cancel();
    super.disconnectedCallback();
  }

  private cancel(): void {
    this.draft = null;
    this.pointerId = null;
  }

  private toSheet(event: PointerEvent): Point {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    return [
      clamp01((event.clientX - box.left) / (box.width || 1)),
      clamp01((event.clientY - box.top) / (box.height || 1)),
    ];
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.tool || event.button !== 0 || this.pointerId !== null) return;
    event.preventDefault();
    const at = this.toSheet(event);
    if (this.tool === 'point') {
      this.emit({ view: '', shape: 'point', point: at });
      return;
    }
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    this.pointerId = event.pointerId;
    this.draft =
      this.tool === 'rect'
        ? { view: '', shape: 'rect', rect: [at[0], at[1], 0, 0] }
        : this.tool === 'arrow'
          ? { view: '', shape: 'arrow', from: at, to: at }
          : { view: '', shape: 'path', path: [at] };
  }

  private onPointerMove(event: PointerEvent): void {
    const draft = this.draft;
    if (!draft || event.pointerId !== this.pointerId) return;
    const [x, y] = this.toSheet(event);
    if (draft.shape === 'rect') {
      this.draft = {
        ...draft,
        rect: [draft.rect[0], draft.rect[1], x - draft.rect[0], y - draft.rect[1]],
      };
    } else if (draft.shape === 'arrow') {
      this.draft = { ...draft, to: [x, y] };
    } else if (draft.shape === 'path') {
      const [lx, ly] = draft.path[draft.path.length - 1];
      if (Math.hypot(x - lx, y - ly) > 0.003)
        this.draft = { ...draft, path: [...draft.path, [x, y]] };
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    const draft = this.draft;
    this.cancel();
    if (draft?.shape === 'rect') {
      const [x, y, w, h] = draft.rect;
      if (Math.abs(w) < 0.005 || Math.abs(h) < 0.005) return;
      this.emit({
        ...draft,
        rect: [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)],
      });
    } else if (draft?.shape === 'path' && draft.path.length >= 2) {
      this.emit(draft);
    } else if (
      draft?.shape === 'arrow' &&
      Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) >= 0.01
    ) {
      this.emit(draft);
    }
  }

  private emit(mark: ModelFeedbackMark): void {
    this.dispatchEvent(
      new CustomEvent('mark-add', { detail: mark, bubbles: true, composed: true })
    );
  }

  private renderMark(mark: ModelFeedbackMark, width: number, height: number, line: number) {
    if (mark.shape === 'rect') {
      const [x, y, w, h] = mark.rect;
      return svg`<rect x=${Math.min(x, x + w) * width} y=${Math.min(y, y + h) * height}
        width=${Math.abs(w) * width} height=${Math.abs(h) * height} />`;
    }
    if (mark.shape === 'point')
      return svg`<circle cx=${mark.point[0] * width} cy=${mark.point[1] * height}
        r=${line * 3} />`;
    if (mark.shape === 'arrow')
      return svg`${arrowLines(mark.from, mark.to, width, height, line).map(
        ([x1, y1, x2, y2]) => svg`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`
      )}`;
    return svg`<polyline points=${mark.path.map(([x, y]) => `${x * width},${y * height}`).join(' ')} />`;
  }

  protected render() {
    if (!this.sheet || !this.src) return html``;
    const { width, height } = sheetSize(this.sheet);
    const marks = this.draft ? [...this.marks, this.draft] : this.marks;
    const line = lineOf(this.sheet);
    const shapes = () => marks.map(m => this.renderMark(m, width, height, line));
    return html`
      <div class="sheet-annotator ${this.tool ? 'is-drawing' : ''}">
        <img src=${this.src} alt=${this.label} draggable="false" />
        <svg
          class="sheet-annotator__marks"
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          style="--mark-color: ${MARK_COLOR}; --mark-outline: ${MARK_OUTLINE}; --mark-line: ${line}"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${() => this.cancel()}
          @lostpointercapture=${() => this.cancel()}
        >
          <g class="sheet-annotator__outline">${shapes()}</g>
          <g class="sheet-annotator__stroke">${shapes()}</g>
        </svg>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-sheet-annotator': SheetAnnotator;
  }
}
