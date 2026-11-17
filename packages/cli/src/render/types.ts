// What the CLI asks `page-host.ts` for and gets back (types only, no runtime imports: the CLI's Node
// half reads it). `info` is the runtime's `ModelSheetInfo` plus the scene's merges.

export interface RenderRequest {
  readonly scene: string;
  readonly node?: string;
  /** `iso,front` / `30:20` / `all` — parsed in the page (`parseModelViews`). */
  readonly views: string;
  readonly size: number;
  readonly frames: number;
  readonly lights: 'auto' | 'studio' | 'scene';
  readonly background: string;
  /** The reference image, served by the CLI; drawn as the first tile and compared. */
  readonly reference?: {
    readonly url: string;
    readonly label: string;
    /** Hex colour to key the reference's background with (`--reference-background`). */
    readonly background?: string;
  };
}

export interface RenderResult {
  readonly sheet: string;
  /** The names of the views drawn, in sheet order. */
  readonly views: string[];
  /** The runtime's `LookStats` of all views pooled, plus `views`: each view's alone (JSON only). */
  readonly look: object;
  /** The runtime's `ReferenceReport` (JSON only). */
  readonly reference?: object;
  /** `look` and `reference` as one printed line each (`describeLook` / `describeReference`). */
  readonly summary: { readonly look: string; readonly reference?: string };
  readonly info: {
    readonly meshes: number;
    readonly drawCalls: number;
    readonly triangles: number;
    readonly size: [number, number, number];
    readonly center: [number, number, number];
    readonly lights: string;
    /** Every core:MergeStatic in the scene: its node and what its merge did. */
    readonly merges: {
      node: string;
      merged: number;
      vertices: number;
      ms: number;
      cached: boolean;
    }[];
  };
}
