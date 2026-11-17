/**
 * MergeStaticBehavior (`core:MergeStatic`) — on a model's group node: when the scene starts, its
 * static parts become one mesh (one draw call), optionally with sun light, shadows and ambient
 * occlusion baked into vertex colours. Parts under a node that carries any other component (a
 * `core:Rotate` sail, a `core:Sine` buoy) keep moving on their own. See `mergeStatic`.
 *
 * Runs in `onReady`, after every component of the starting scene ran `onStart`, so a script that
 * builds or reshapes parts at start has finished first. A script that changes the model later calls
 * `unmergeStatic(node)` and `mergeStatic(node, …)` itself.
 */

import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import {
  mergeStatic,
  unmergeStatic,
  type MergeStaticOptions,
  type MergeStaticResult,
} from '../nodes/3D/static-merge';

export class MergeStaticBehavior extends Script {
  /** What the last merge did (for tools and tests). */
  lastResult: MergeStaticResult | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      bake: true,
      sunDirection: [-0.6, 1, 0.45],
      shadows: true,
      aoSamples: 24,
      subdivide: -1,
      exposure: 1,
      saturation: 1,
      cacheKey: '',
    };
  }

  static getPropertySchema(): PropertySchema {
    const config = (c: unknown) => (c as MergeStaticBehavior).config;
    return {
      nodeType: 'MergeStaticBehavior',
      properties: [
        {
          name: 'bake',
          type: 'boolean',
          ui: {
            label: 'Bake Light',
            description:
              'Bake sun, shadows and ambient occlusion into vertex colours (the merged mesh is then unlit)',
            group: 'Component',
          },
          getValue: c => config(c).bake !== false,
          setValue: (c, v) => void (config(c).bake = Boolean(v)),
        },
        {
          name: 'sunDirection',
          type: 'vector3',
          ui: {
            label: 'Sun Direction',
            description: 'World direction toward the sun',
            group: 'Component',
            step: 0.05,
          },
          getValue: c => {
            const [x, y, z] = sunOf(config(c).sunDirection);
            return { x, y, z };
          },
          setValue: (c, v) => {
            const vec = v as { x?: unknown; y?: unknown; z?: unknown };
            config(c).sunDirection = [Number(vec?.x), Number(vec?.y), Number(vec?.z)];
          },
        },
        {
          name: 'shadows',
          type: 'boolean',
          ui: { label: 'Shadows', description: 'Parts shade each other', group: 'Component' },
          getValue: c => config(c).shadows !== false,
          setValue: (c, v) => void (config(c).shadows = Boolean(v)),
        },
        {
          name: 'aoSamples',
          type: 'number',
          ui: {
            label: 'AO Samples',
            description: 'Ambient-occlusion rays per vertex (0 = none)',
            group: 'Component',
            min: 0,
            max: 128,
            step: 1,
          },
          getValue: c => Number(config(c).aoSamples ?? 24),
          setValue: (c, v) => void (config(c).aoSamples = Math.max(0, Math.round(Number(v)))),
        },
        {
          name: 'subdivide',
          type: 'number',
          ui: {
            label: 'Subdivide',
            description:
              'Split faces longer than this before baking (model units); -1 = automatic, 0 = off',
            group: 'Component',
            min: -1,
            step: 0.05,
          },
          getValue: c => Number(config(c).subdivide ?? -1),
          setValue: (c, v) => void (config(c).subdivide = Number(v)),
        },
        {
          name: 'exposure',
          type: 'number',
          ui: {
            label: 'Exposure',
            description:
              'Multiplies the baked colour (linear RGB, after shadows and AO); 1 = as lit',
            group: 'Component',
            min: 0,
            step: 0.05,
          },
          getValue: c => Number(config(c).exposure ?? 1),
          setValue: (c, v) => void (config(c).exposure = Math.max(0, Number(v))),
        },
        {
          name: 'saturation',
          type: 'number',
          ui: {
            label: 'Saturation',
            description:
              'Baked colour saturation around its luma, after exposure; 1 = as lit, 0 = grey',
            group: 'Component',
            min: 0,
            step: 0.05,
          },
          getValue: c => Number(config(c).saturation ?? 1),
          setValue: (c, v) => void (config(c).saturation = Math.max(0, Number(v))),
        },
        {
          name: 'cacheKey',
          type: 'string',
          ui: {
            label: 'Cache Key',
            description: 'Identical models with the same key share one merged geometry (bake once)',
            group: 'Component',
          },
          getValue: c => String(config(c).cacheKey ?? ''),
          setValue: (c, v) => void (config(c).cacheKey = String(v ?? '')),
        },
      ],
      groups: {
        Component: { label: 'Merge Static', expanded: true },
      },
    };
  }

  /** Present so the runner queues {@link onReady} (it only readies components that start). */
  onStart(): void {}

  onReady(): void {
    if (this.node) this.lastResult = mergeStatic(this.node, mergeStaticOptionsOf(this.config));
  }

  onDetach(): void {
    if (this.node) unmergeStatic(this.node);
  }
}

/** The `mergeStatic` options a `core:MergeStatic` config asks for (also the editor's `pix3_bake`). */
export function mergeStaticOptionsOf(c: Record<string, unknown>): MergeStaticOptions {
  const subdivide = Number(c.subdivide ?? -1);
  return {
    bake:
      c.bake === false
        ? false
        : {
            sunDirection: sunOf(c.sunDirection),
            shadows: c.shadows !== false,
            aoSamples: Number(c.aoSamples ?? 24),
            subdivide: subdivide < 0 ? true : subdivide,
            exposure: Number(c.exposure ?? 1),
            saturation: Number(c.saturation ?? 1),
          },
    cacheKey: typeof c.cacheKey === 'string' && c.cacheKey ? c.cacheKey : undefined,
  };
}

function sunOf(value: unknown): [number, number, number] {
  const v = Array.isArray(value) ? value.map(Number) : [];
  return v.length >= 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : [-0.6, 1, 0.45];
}
