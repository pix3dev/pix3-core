import { Vector2 } from 'three';

import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import { ChildClip2D } from '../../core/child-clip-2d';

export interface Group2DProps extends Omit<Node2DProps, 'type'> {
  width?: number;
  height?: number;
  /** Clip the children's drawing to this group's rect (see {@link Group2D.clipChildren}). */
  clipChildren?: boolean;
}

export class Group2D extends Node2D {
  private _width: number;
  private _height: number;
  private _clipChildren: boolean;
  private childClip: ChildClip2D | null = null;

  constructor(props: Group2DProps, nodeType: string = 'Group2D') {
    super(props, nodeType);

    this._width = Number.isFinite(props.width) ? Math.max(0, props.width ?? 0) : 100;
    this._height = Number.isFinite(props.height) ? Math.max(0, props.height ?? 0) : 100;
    this._clipChildren = props.clipChildren === true;
    this.isContainer = true;
  }

  /**
   * Clip everything under this group to its `width`×`height` rect (centred on the group,
   * axis-aligned): a match-3 board whose new gems fall in from above, an inventory strip, a ticker.
   * Applied in play mode each frame, so spawned children clip too; the editor viewport shows the
   * children unclipped. A nested clipping group or `ScrollContainer2D` wins over this one on its
   * own subtree.
   */
  get clipChildren(): boolean {
    return this._clipChildren;
  }

  set clipChildren(value: boolean) {
    this._clipChildren = Boolean(value);
    if (!this._clipChildren) {
      this.childClip?.clear();
    }
  }

  override tick(dt: number): void {
    super.tick(dt);
    // After the children's ticks: spawned this frame or moved, they are clipped before the render.
    if (this._clipChildren) {
      this.childClip ??= new ChildClip2D();
      this.childClip.apply(this, this._width, this._height, this.children);
    }
  }

  protected override disposeResources(): void {
    this.childClip?.clear();
    super.disposeResources();
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    const nextValue = Number.isFinite(value) ? Math.max(0, value) : this._width;
    if (this._width === nextValue) {
      return;
    }

    this._width = nextValue;
    this.reflowAnchoredChildren();
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    const nextValue = Number.isFinite(value) ? Math.max(0, value) : this._height;
    if (this._height === nextValue) {
      return;
    }

    this._height = nextValue;
    this.reflowAnchoredChildren();
  }

  getSize(): Vector2 {
    return new Vector2(this._width, this._height);
  }

  setSize(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) ? Math.max(0, width) : this._width;
    const nextHeight = Number.isFinite(height) ? Math.max(0, height) : this._height;
    const changed = this._width !== nextWidth || this._height !== nextHeight;

    this._width = nextWidth;
    this._height = nextHeight;

    if (changed) {
      this.reflowAnchoredChildren();
    }
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();

    return {
      nodeType: 'Group2D',
      extends: 'Node2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            group: 'Size',
            step: 1,
            precision: 0,
            min: 0,
          },
          getValue: (node: unknown) => (node as Group2D).width,
          setValue: (node: unknown, value: unknown) => {
            (node as Group2D).width = Number(value);
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            group: 'Size',
            step: 1,
            precision: 0,
            min: 0,
          },
          getValue: (node: unknown) => (node as Group2D).height,
          setValue: (node: unknown, value: unknown) => {
            (node as Group2D).height = Number(value);
          },
        },
        {
          name: 'clipChildren',
          type: 'boolean',
          ui: {
            label: 'Clip Children',
            description:
              "Clip the children's drawing to this group's rect in play mode (masks a board, a strip)",
            group: 'Size',
          },
          getValue: (node: unknown) => (node as Group2D).clipChildren,
          setValue: (node: unknown, value: unknown) => {
            (node as Group2D).clipChildren = value === true || value === 'true';
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Size: {
          label: 'Size',
          description: 'Group dimensions',
          expanded: true,
        },
      },
    };
  }
}
