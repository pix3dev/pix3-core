import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  SRGBColorSpace,
  Sphere,
  Vector2,
  Vector3,
  type Light,
  type Mesh,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

import { NodeBase } from '../NodeBase';
import { foregroundMask, type LookTile } from './model-look';

/**
 * A model drawn from several sides into one labelled sheet, with what it costs to draw — the
 * model's feedback loop, shared by `pix3 render` (a private headless page) and the editor bridge's
 * `pix3_render_model` (the open scene, unsaved edits included). Everything it changes on the scene
 * (hidden objects, background, temporary lights, the renderer's size) is restored before it returns.
 */

export interface ModelView {
  readonly name: string;
  /** Degrees around Y; 0 looks from +Z (the front), 90 from +X (the right side). */
  readonly azimuth: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
}

/** Named views: azimuth (0 = from the front, +Z) and elevation, degrees. */
export const MODEL_VIEWS: Readonly<Record<string, Omit<ModelView, 'name'>>> = {
  iso: { azimuth: 35, elevation: 30 },
  front: { azimuth: 0, elevation: 8 },
  right: { azimuth: 90, elevation: 8 },
  back: { azimuth: 180, elevation: 8 },
  left: { azimuth: -90, elevation: 8 },
  top: { azimuth: 0, elevation: 89 },
  below: { azimuth: 35, elevation: -30 },
  game: { azimuth: 0, elevation: 50 },
};

export const DEFAULT_MODEL_VIEWS = 'iso,front,right,top';

/** `iso,front` / `30:20` (azimuth:elevation) / `all` → views. */
export function parseModelViews(value: string): ModelView[] | { error: string } {
  const names = value === 'all' ? Object.keys(MODEL_VIEWS) : value.split(',').filter(Boolean);
  const views: ModelView[] = [];
  for (const name of names) {
    const named = MODEL_VIEWS[name];
    const custom = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(name);
    if (named) views.push({ name, ...named });
    else if (custom) views.push({ name, azimuth: Number(custom[1]), elevation: Number(custom[2]) });
    else {
      return {
        error: `unknown view "${name}" (${Object.keys(MODEL_VIEWS).join(', ')}, all, or azimuth:elevation like 30:20)`,
      };
    }
  }
  return views.length > 0 ? views : { error: 'views needs at least one view' };
}

export interface ModelSheetOptions {
  readonly views: readonly ModelView[];
  /** Tile size in px (square). */
  readonly size: number;
  /** `auto` = the scene's lights when it has any, else a neutral studio rig. */
  readonly lights: 'auto' | 'studio' | 'scene';
  /** CSS colour behind the model. */
  readonly background: string;
  /** An image drawn as the first tile, letterboxed on the background and labelled `label`. */
  readonly reference?: {
    readonly image: CanvasImageSource;
    readonly width: number;
    readonly height: number;
    readonly label: string;
  };
  /**
   * Also return each view's pixels and the model's exact mask: every view is drawn a second time
   * against another clear colour, and a pixel is the model's where both drawings agree.
   */
  readonly capture?: boolean;
}

export interface ModelSheetCapture extends LookTile {
  readonly name: string;
}

export interface ModelSheetInfo {
  /** Visible meshes in the target (one draw call each, roughly). */
  readonly meshes: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly size: [number, number, number];
  readonly center: [number, number, number];
  readonly lights: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function shownInWorld(object: Object3D): boolean {
  for (let o: Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * Draw `targets` (and nothing else of `world`) from each view into a sheet of square tiles, two
 * columns, each labelled with its view. Only layer 0 (3D content) is drawn.
 */
export function renderModelSheet(
  gl: WebGLRenderer,
  world: Scene,
  targets: readonly Object3D[],
  options: ModelSheetOptions
): { sheet: HTMLCanvasElement; info: ModelSheetInfo; captures: ModelSheetCapture[] } {
  const inTarget = (object: Object3D): boolean => {
    for (let o: Object3D | null = object; o; o = o.parent) if (targets.includes(o)) return true;
    return false;
  };
  const restore: (() => void)[] = [];
  // Isolate: hide every drawable outside the targets. A node is hidden through `hiddenByEditor`
  // (its `visible` setter would write the authored property); anything else through `visible`.
  const hide = (object: Object3D): void => {
    if (object instanceof NodeBase) {
      if (object.hiddenByEditor) return;
      object.hiddenByEditor = true;
      restore.push(() => void (object.hiddenByEditor = false));
    } else if (object.visible) {
      object.visible = false;
      restore.push(() => void (object.visible = true));
    }
  };
  try {
    const box = new Box3();
    let meshes = 0;
    world.traverse(object => {
      const drawable = object as Mesh & {
        isLine?: boolean;
        isPoints?: boolean;
        isSprite?: boolean;
      };
      if (!(drawable.isMesh || drawable.isLine || drawable.isPoints || drawable.isSprite)) return;
      if (!inTarget(object)) return hide(object);
      if (!drawable.isMesh || !object.layers.isEnabled(0) || !shownInWorld(object)) return;
      meshes += 1;
      box.expandByObject(object, true);
    });
    if (box.isEmpty()) throw new Error('nothing 3D to render (no visible mesh)');
    const sphere = box.getBoundingSphere(new Sphere());

    let sceneLights = 0;
    world.traverse(o => {
      if ((o as Light).isLight && shownInWorld(o)) sceneLights += 1;
    });
    const studio = options.lights === 'studio' || (options.lights === 'auto' && sceneLights === 0);
    if (options.lights === 'studio') {
      world.traverse(o => {
        if ((o as Light).isLight) hide(o);
      });
    }
    if (studio) {
      const key = new DirectionalLight('#fff4e6', 2.2);
      key.position
        .copy(sphere.center)
        .add(new Vector3(-0.6, 1, 0.45).multiplyScalar(sphere.radius * 4));
      key.target.position.copy(sphere.center);
      for (const light of [
        key,
        key.target,
        new HemisphereLight('#c8d6f0', '#6b5b4b', 1.1),
        new AmbientLight('#ffffff', 0.15),
      ]) {
        world.add(light);
        restore.push(() => void light.removeFromParent());
      }
    }

    const background = world.background;
    const clear = new Color(options.background);
    // The capture's second clear colour: each sRGB channel pushed to the far end.
    const srgb = clear.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
    const altClear = new Color().setRGB(
      srgb.r < 0.5 ? 1 : 0,
      srgb.g < 0.5 ? 1 : 0,
      srgb.b < 0.5 ? 1 : 0
    );
    world.background = clear;
    restore.push(() => void (world.background = background));
    const pixelRatio = gl.getPixelRatio();
    const drawingSize = gl.getSize(new Vector2());
    const target = gl.getRenderTarget();
    gl.setPixelRatio(1);
    gl.setSize(options.size, options.size, false);
    restore.push(() => {
      gl.setPixelRatio(pixelRatio);
      gl.setSize(drawingSize.x, drawingSize.y, false);
      gl.setRenderTarget(target);
    });

    const camera = new PerspectiveCamera(30, 1, sphere.radius * 0.01, sphere.radius * 20);
    const distance = (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
    const { size } = options;
    const reference = options.reference;
    const tiles = options.views.length + (reference ? 1 : 0);
    const columns = tiles > 1 ? 2 : 1;
    const sheet = document.createElement('canvas');
    sheet.width = columns * size;
    sheet.height = Math.ceil(tiles / columns) * size;
    const ctx = sheet.getContext('2d')!;
    const fontPx = Math.max(12, Math.round(size / 28));
    ctx.font = `${fontPx}px sans-serif`;
    const labelTile = (x: number, y: number, label: string): void => {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x, y, ctx.measureText(label).width + 16, fontPx + 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 8, y + fontPx + 4);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    };
    if (reference) {
      const scale = Math.min(size / reference.width, size / reference.height);
      const w = Math.max(1, Math.round(reference.width * scale));
      const h = Math.max(1, Math.round(reference.height * scale));
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(reference.image, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
      labelTile(0, 0, reference.label);
    }
    // One view's pixels as drawn, read back before the drawing buffer is cleared.
    let readBack: (() => ImageData) | null = null;
    if (options.capture) {
      const scratch = document.createElement('canvas');
      scratch.width = scratch.height = size;
      const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;
      readBack = () => {
        scratchCtx.clearRect(0, 0, size, size);
        scratchCtx.drawImage(gl.domElement, 0, 0, size, size, 0, 0, size, size);
        return scratchCtx.getImageData(0, 0, size, size);
      };
    }
    const captures: ModelSheetCapture[] = [];
    let drawCalls = 0;
    let triangles = 0;
    options.views.forEach((view, n) => {
      const i = n + (reference ? 1 : 0);
      const az = (view.azimuth * Math.PI) / 180;
      const el = (Math.min(89.9, Math.max(-89.9, view.elevation)) * Math.PI) / 180;
      const dir = new Vector3(
        Math.sin(az) * Math.cos(el),
        Math.sin(el),
        Math.cos(az) * Math.cos(el)
      );
      camera.position.copy(sphere.center).addScaledVector(dir, distance);
      camera.up.set(0, 1, 0);
      camera.lookAt(sphere.center);
      camera.updateMatrixWorld();
      gl.setRenderTarget(null);
      gl.info.reset();
      gl.render(world, camera);
      drawCalls = Math.max(drawCalls, gl.info.render.calls);
      triangles = Math.max(triangles, gl.info.render.triangles);
      // Copy in the same task as the render: the drawing buffer is not preserved.
      const x = (i % columns) * size;
      const y = Math.floor(i / columns) * size;
      ctx.drawImage(gl.domElement, 0, 0, size, size, x, y, size, size);
      if (readBack) {
        const pixels = readBack();
        world.background = altClear;
        gl.render(world, camera);
        const mask = foregroundMask(pixels, readBack());
        world.background = clear;
        captures.push({ name: view.name, pixels, mask });
      }
      labelTile(x, y, `${view.name}  ${view.azimuth}°/${view.elevation}°`);
    });
    const extent = box.getSize(new Vector3());
    return {
      sheet,
      captures,
      info: {
        meshes,
        drawCalls,
        triangles,
        size: [round(extent.x), round(extent.y), round(extent.z)],
        center: [round(sphere.center.x), round(sphere.center.y), round(sphere.center.z)],
        lights: studio
          ? options.lights === 'studio'
            ? 'studio'
            : 'studio (the scene has none)'
          : `scene (${sceneLights})`,
      },
    };
  } finally {
    for (let i = restore.length - 1; i >= 0; i -= 1) restore[i]();
  }
}
