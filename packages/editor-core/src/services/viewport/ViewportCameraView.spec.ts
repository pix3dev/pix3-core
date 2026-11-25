import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Camera3D, Node3D } from '@pix3/runtime';
import {
  CameraViewCameras,
  cameraView2DFraming,
  fitCameraViewFrame,
  resolveCameraViewNode,
} from './ViewportCameraView';

describe('fitCameraViewFrame', () => {
  it('fits a portrait design into a landscape viewport, centred, inside the margin', () => {
    const frame = fitCameraViewFrame({ width: 1000, height: 600 }, 1080 / 1920, 24)!;
    expect(frame.height).toBeCloseTo(552);
    expect(frame.width / frame.height).toBeCloseTo(1080 / 1920);
    expect(frame.y).toBeCloseTo(24);
    expect(frame.x + frame.width / 2).toBeCloseTo(500);
  });

  it('refuses an unmeasured viewport', () => {
    expect(fitCameraViewFrame({ width: 0, height: 600 }, 1)).toBeNull();
  });
});

describe('cameraView2DFraming', () => {
  it('maps the design frame onto the camera frame', () => {
    const viewport = { width: 1000, height: 600 };
    const base = { width: 1080, height: 1920 };
    const frame = fitCameraViewFrame(viewport, base.width / base.height)!;
    // The editor's 2D frustum at this viewport (expand mode: the base fits, height grows).
    const frustumHeight = base.height;
    const framing = cameraView2DFraming(frame, viewport, base, frustumHeight);
    // Visible world height across the viewport = frustumHeight / zoom; the frame covers base.height.
    const worldPerPx = frustumHeight / framing.zoom / viewport.height;
    expect(frame.height * worldPerPx).toBeCloseTo(base.height);
    expect(framing.x).toBeCloseTo(0);
    expect(framing.y).toBeCloseTo(0);
  });
});

describe('CameraViewCameras', () => {
  it('draws the camera frame exactly where the game camera would, widened to the canvas', () => {
    const node = new Camera3D({ id: 'cam', name: 'Cam', fov: 24 });
    node.position.set(0, 10, 5);
    node.lookAt(0, 0, 0);
    const viewport = { width: 1000, height: 600 };
    const frame = fitCameraViewFrame(viewport, 9 / 16)!;
    node.updateAspectRatio(frame.width / frame.height);
    const copy = new CameraViewCameras([0]).sync(node.camera, frame, viewport);

    // A world point the game camera puts on its frame's top-left corner…
    const game = node.camera as THREE.PerspectiveCamera;
    const corner = new THREE.Vector3(-1, 1, 0.5).unproject(game);
    // …lands on the frame's top-left in canvas pixels through the copy.
    const ndc = corner.clone().project(copy);
    const px = ((ndc.x + 1) / 2) * viewport.width;
    const py = ((1 - ndc.y) / 2) * viewport.height;
    expect(px).toBeCloseTo(frame.x, 3);
    expect(py).toBeCloseTo(frame.y, 3);
    expect((copy as THREE.PerspectiveCamera).fov).toBe(24);
  });
});

describe('resolveCameraViewNode', () => {
  it('prefers the picked camera, else the first visible one', () => {
    const root = new Node3D({ id: 'root', name: 'Root' });
    const hidden = new Camera3D({ id: 'a', name: 'A' });
    hidden.visible = false;
    const shown = new Camera3D({ id: 'b', name: 'B' });
    root.add(hidden, shown);
    const map = new Map<string, unknown>([
      ['a', hidden],
      ['b', shown],
    ]);
    expect(resolveCameraViewNode([root], null, map)).toBe(shown);
    expect(resolveCameraViewNode([root], 'a', map)).toBe(hidden);
  });
});
