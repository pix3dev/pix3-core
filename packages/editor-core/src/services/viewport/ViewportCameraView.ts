import * as THREE from 'three';
import { Camera3D, NodeBase } from '@pix3/runtime';

/** A rectangle in the viewport's CSS pixels, origin top-left (what `clientX` and DOM speak). */
export interface CameraViewFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Gap between the camera frame and the viewport edge, in CSS pixels. */
export const CAMERA_VIEW_MARGIN = 24;

/**
 * The largest rectangle of `aspect` (width / height) that fits the viewport inside `margin`,
 * centred. This is the game's screen in the editor: the 3D camera renders into it with that aspect
 * and the 2D design frame fills it, as the player does on a screen of that shape.
 */
export function fitCameraViewFrame(
  viewport: { width: number; height: number },
  aspect: number,
  margin = CAMERA_VIEW_MARGIN
): CameraViewFrame | null {
  if (!(viewport.width > 0 && viewport.height > 0 && aspect > 0 && Number.isFinite(aspect))) {
    return null;
  }
  // A viewport too small for the margin still gets a frame (edge to edge).
  const m = Math.min(margin, viewport.width / 4, viewport.height / 4);
  const availW = viewport.width - m * 2;
  const availH = viewport.height - m * 2;
  let width = availW;
  let height = width / aspect;
  if (height > availH) {
    height = availH;
    width = height * aspect;
  }
  return {
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
    width,
    height,
  };
}

/**
 * Where the editor's 2D (orthographic) camera has to sit so the design frame (`viewportBaseSize`,
 * centred on the origin) covers `frame` exactly. `frustumHeight` is the ortho camera's
 * `top - bottom` at zoom 1 (the editor sets it per viewport size in `resize()`).
 */
export function cameraView2DFraming(
  frame: CameraViewFrame,
  viewport: { width: number; height: number },
  baseSize: { width: number; height: number },
  frustumHeight: number
): { x: number; y: number; zoom: number } {
  const worldPerPx = baseSize.height / frame.height;
  // The visible world height is frustumHeight / zoom and must equal the viewport height in world.
  const zoom = frustumHeight / (viewport.height * worldPerPx);
  // The design centre (world 0,0) lands on the frame centre; the camera looks at the viewport centre.
  const dxPx = viewport.width / 2 - (frame.x + frame.width / 2);
  const dyPx = viewport.height / 2 - (frame.y + frame.height / 2);
  return { x: dxPx * worldPerPx, y: -dyPx * worldPerPx, zoom };
}

/**
 * The camera the game would look through: the one picked in the camera dropdown when there is one,
 * else the first visible `Camera3D` in tree order — the rule `SceneRunner` applies at start.
 */
export function resolveCameraViewNode(
  rootNodes: readonly NodeBase[],
  pickedNodeId: string | null,
  nodeMap: ReadonlyMap<string, unknown>
): Camera3D | null {
  if (pickedNodeId) {
    const picked = nodeMap.get(pickedNodeId);
    if (picked instanceof Camera3D) return picked;
  }
  let firstAny: Camera3D | null = null;
  const walk = (nodes: readonly THREE.Object3D[]): Camera3D | null => {
    for (const node of nodes) {
      if (node instanceof Camera3D) {
        if (node.visible) return node;
        firstAny ??= node;
      }
      if (node.children.length > 0) {
        const found = walk(node.children.filter(child => child instanceof NodeBase));
        if (found) return found;
      }
    }
    return null;
  };
  return walk(rootNodes) ?? firstAny;
}

/**
 * Editor-owned copies of a game camera, one per projection. The viewport draws and picks through
 * a copy, never through the node's own camera: the copy carries a view offset that widens the
 * frustum from the camera frame to the whole canvas (the area outside the frame is the
 * passepartout), and the game camera must keep the projection the runtime would give it.
 */
export class CameraViewCameras {
  readonly perspective = new THREE.PerspectiveCamera();
  readonly orthographic = new THREE.OrthographicCamera();

  constructor(layers: readonly number[]) {
    for (const camera of [this.perspective, this.orthographic]) {
      camera.layers.disableAll();
      for (const layer of layers) camera.layers.enable(layer);
    }
  }

  /**
   * Copy `source`'s world pose and lens into the matching copy and widen it from `frame` to the
   * viewport. `source` must already carry the frame's aspect (`Camera3D.updateAspectRatio`).
   */
  sync(
    source: THREE.Camera,
    frame: CameraViewFrame,
    viewport: { width: number; height: number }
  ): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    source.updateWorldMatrix(true, false);
    let target: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (source instanceof THREE.OrthographicCamera) {
      target = this.orthographic;
      target.left = source.left;
      target.right = source.right;
      target.top = source.top;
      target.bottom = source.bottom;
    } else {
      target = this.perspective;
      const lens = source as THREE.PerspectiveCamera;
      target.fov = lens.fov ?? 50;
      target.aspect = frame.width / frame.height;
      target.filmGauge = lens.filmGauge ?? target.filmGauge;
      target.filmOffset = lens.filmOffset ?? 0;
    }
    const lens = source as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    target.near = lens.near ?? 0.1;
    target.far = lens.far ?? 1000;
    target.zoom = lens.zoom ?? 1;
    source.matrixWorld.decompose(target.position, target.quaternion, target.scale);
    target.updateMatrixWorld(true);
    // The frame is the camera's full image; the canvas is a window onto it that extends past it.
    target.setViewOffset(
      frame.width,
      frame.height,
      -frame.x,
      -frame.y,
      viewport.width,
      viewport.height
    );
    return target;
  }
}

/**
 * The DOM over the canvas in camera view: a dimmed passepartout around the frame, the frame's
 * outline and the camera's name. Pointer events pass through to the canvas.
 */
export class CameraViewOverlay {
  private root?: HTMLDivElement;
  private label?: HTMLDivElement;

  show(host: HTMLElement | undefined, frame: CameraViewFrame, cameraName: string): void {
    if (!host) return;
    if (!this.root) {
      const root = document.createElement('div');
      root.dataset.pix3OverlayHud = 'camera-view';
      Object.assign(root.style, {
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: '3',
        boxSizing: 'border-box',
        border: '1px solid rgba(245, 174, 57, 0.9)',
        // The passepartout: a huge spread shadow dims everything outside the frame.
        boxShadow: '0 0 0 100vmax rgba(5, 8, 10, 0.72)',
      } satisfies Partial<CSSStyleDeclaration>);
      const label = document.createElement('div');
      Object.assign(label.style, {
        position: 'absolute',
        left: '0',
        bottom: '100%',
        padding: '0 0 4px',
        color: 'rgba(245, 174, 57, 0.95)',
        fontFamily:
          '"Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        fontSize: '11px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
      } satisfies Partial<CSSStyleDeclaration>);
      root.appendChild(label);
      this.root = root;
      this.label = label;
    }
    if (this.root.parentElement !== host) host.appendChild(this.root);
    Object.assign(this.root.style, {
      left: `${frame.x}px`,
      top: `${frame.y}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
    });
    if (this.label && this.label.textContent !== cameraName) this.label.textContent = cameraName;
  }

  hide(): void {
    this.root?.remove();
  }
}
