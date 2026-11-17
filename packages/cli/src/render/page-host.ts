// The page half of `pix3 render`: built into one browser IIFE (with the runtime and three.js) that
// sets `window.__PIX3_RENDER_HOST__`. The CLI serves it with the project's files and calls
// `renderScene` once. See `command.ts`.
import * as runtime from '@pix3/runtime';
import * as three from 'three';
import type { Object3D, Scene } from 'three';

import type { RenderRequest, RenderResult } from './types.ts';

interface PageWindow {
  __PIX3_RENDER_SCRIPTS__?: Record<string, Record<string, unknown>>;
}

async function renderScene(request: RenderRequest): Promise<RenderResult> {
  const views = runtime.parseModelViews(request.views);
  if ('error' in views) throw new Error(views.error);
  const resources = new runtime.ResourceManager('/');
  const audio = new runtime.AudioService();
  const registry = new runtime.ScriptRegistry();
  runtime.registerBuiltInScripts(registry);
  const scripts = (window as unknown as PageWindow).__PIX3_RENDER_SCRIPTS__ ?? {};
  for (const [file, exports] of Object.entries(scripts)) {
    runtime.registerProjectScriptExports(registry, exports, file);
  }
  const assets = new runtime.AssetLoader(resources, audio);
  const loader = new runtime.SceneLoader(assets, registry, resources);
  const manager = new runtime.SceneManager(loader);
  const renderer = new runtime.RuntimeRenderer({ antialias: true, shadows: true, pixelRatio: 1 });
  const host = document.createElement('div');
  host.style.cssText = `width:${request.size}px;height:${request.size}px`;
  document.body.appendChild(host);
  renderer.attach(host);
  const runner = new runtime.SceneRunner(manager, renderer, audio, assets);
  runner.setTimeMode({
    mode: 'manual',
    fixedDeltaSec: 1 / 60,
    renderEveryNTicks: 1e9,
    muteAudio: true,
  });
  await runner.loadAndStartScene(request.scene);
  for (let i = 0; i < Math.max(1, request.frames); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    runner.stepFrames(1);
  }

  const roots = runner.getLiveRootNodes();
  const merges: RenderResult['info']['merges'] = [];
  for (const root of roots) {
    root.traverse(o => {
      for (const c of (o as runtime.NodeBase).components ?? []) {
        if (!(c instanceof runtime.MergeStaticBehavior)) continue;
        const r = c.lastResult;
        merges.push({
          node: (o as runtime.NodeBase).nodeId,
          merged: r?.merged ?? 0,
          vertices: r?.vertices ?? 0,
          ms: Math.round(r?.ms ?? 0),
          cached: r?.cached ?? false,
        });
      }
    });
  }
  const world = roots[0]?.parent as Scene | null;
  if (!world) throw new Error(`${request.scene} has no nodes`);
  let targets: Object3D[] = roots.filter(node => node instanceof runtime.Node3D);
  if (request.node) {
    const node = runner.getLiveNodeById(request.node);
    if (!node) throw new Error(`no node "${request.node}" in ${request.scene}`);
    targets = [node];
  }
  const reference = request.reference ? await loadReference(request.reference.url) : undefined;
  const { sheet, info, captures } = runtime.renderModelSheet(
    renderer.getWebGLRenderer(),
    world,
    targets,
    {
      ...request,
      views,
      capture: true,
      reference: reference && {
        image: reference.image,
        width: reference.image.naturalWidth,
        height: reference.image.naturalHeight,
        label: request.reference!.label,
      },
    }
  );
  runner.stop();
  const look = runtime.measureLook(captures);
  const judged =
    reference &&
    runtime.judgeAgainstReference(reference.pixels, captures[0], request.reference!.background);
  return {
    sheet: sheet.toDataURL('image/png'),
    views: views.map(v => v.name),
    look: {
      ...look,
      views: Object.fromEntries(captures.map(c => [c.name, runtime.measureLook([c])])),
    },
    ...(judged && { reference: judged }),
    summary: {
      look: runtime.describeLook(look),
      ...(judged && { reference: runtime.describeReference(judged) }),
    },
    info: { ...info, merges },
  };
}

/** The reference image and its pixels, its longer side scaled to at most 512 px for measuring. */
async function loadReference(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => {
    throw new Error('the reference is not an image the browser can decode');
  });
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { image, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

(window as unknown as { __PIX3_RENDER_HOST__: unknown }).__PIX3_RENDER_HOST__ = {
  runtime,
  three,
  renderScene,
};
