import {
  AssetLoader,
  ATLAS_MANIFEST_PATH,
  AudioService,
  installAtlasFromManifest,
  registerBuiltInScripts,
  registerProjectScriptExports,
  ResourceManager,
  RuntimeRenderer,
  SceneLoader,
  SceneManager,
  SceneRunner,
  ScriptRegistry,
} from '@pix3/runtime';
import { embeddedAssets } from 'virtual:pix3/embedded-assets';
import { installNetworkService } from 'virtual:pix3/network';
import { modules as projectScriptModules } from 'virtual:pix3/project-scripts';
import {
  activeScenePath,
  resourceBase,
  runtimeFonts,
  runtimeLocalization,
  runtimeQuality,
  runtimeViewportBaseSize,
  scenePaths,
} from 'virtual:pix3/scene-manifest';
// Registers the optional Spine runtime (lazily in dev, statically in a build that uses it).
// Must run before the first scene load.
import 'virtual:pix3/spine';
// Same arrangement for `postprocessing`: registered statically when a single-file build places
// a PostProcess node, the runtime's own code-split import otherwise.
import 'virtual:pix3/postprocessing';

/**
 * `@pix3/vite-plugin/player` (plan §B.5): the game's entry. A project's `src/main.ts` is
 * `import { startGame } from '@pix3/vite-plugin/player'; startGame('#app');` — in dev the scenes
 * and assets are fetched from the dev server, in a build they are embedded (html) or sit beside
 * `index.html` (zip). Port of the 1.x `runtime/src/main.ts` + `register-project-scripts.ts`.
 *
 * `window.__PIX3_PLAYER__` is the gate's witness: `status`, `frames` (loop iterations), `errors`.
 */

export interface Pix3PlayerState {
  status: 'booting' | 'running' | 'failed';
  /** Frames the runner's loop has run. */
  frames: number;
  errors: string[];
  /** The scene the player booted into. */
  scene: string | null;
  runner: SceneRunner | null;
}

declare global {
  interface Window {
    __PIX3_PLAYER__?: Pix3PlayerState;
  }
}

export interface StartGameOptions {
  /** `res://`-relative scene to boot instead of the manifest's entry scene. */
  readonly scene?: string;
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const installState = (): Pix3PlayerState => {
  const existing = window.__PIX3_PLAYER__;
  if (existing) return existing;
  const state: Pix3PlayerState = {
    status: 'booting',
    frames: 0,
    errors: [],
    scene: null,
    runner: null,
  };
  window.__PIX3_PLAYER__ = state;
  window.addEventListener('error', event => {
    state.errors.push(event.message || describe(event.error));
  });
  window.addEventListener('unhandledrejection', event => {
    state.errors.push(`unhandledrejection: ${describe(event.reason)}`);
  });
  return state;
};

/** Boot the game into `target` (a selector or an element; `#app` by default). */
export async function startGame(
  target: string | HTMLElement = '#app',
  options: StartGameOptions = {}
): Promise<SceneRunner> {
  const state = installState();
  try {
    const app = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
    if (!app) throw new Error(`Missing ${typeof target === 'string' ? target : 'mount'} container`);

    const resourceManager = new ResourceManager(resourceBase, embeddedAssets);
    const audioService = new AudioService();
    const scriptRegistry = new ScriptRegistry();
    registerBuiltInScripts(scriptRegistry);
    for (const [file, exports] of Object.entries(projectScriptModules)) {
      registerProjectScriptExports(scriptRegistry, exports, file.replace(/^\/+/, ''));
    }

    const assetLoader = new AssetLoader(resourceManager, audioService);
    const sceneLoader = new SceneLoader(assetLoader, scriptRegistry, resourceManager);
    // No SceneSaver: a player never writes scenes back out, and one would pin every node class
    // and `yaml.stringify` into the bundle (CLAUDE.md «Playable export size»).
    const sceneManager = new SceneManager(sceneLoader);

    const scenePath = options.scene || activeScenePath || scenePaths[0];
    if (!scenePath) throw new Error('No scenes found in this project.');
    state.scene = scenePath;

    const renderer = new RuntimeRenderer({
      antialias: runtimeQuality.antialias,
      shadows: runtimeQuality.shadows,
      pixelRatio: Math.min(window.devicePixelRatio || 1, runtimeQuality.maxPixelRatio),
    });
    renderer.attach(app);

    const runner = new SceneRunner(
      sceneManager,
      renderer,
      audioService,
      assetLoader,
      runtimeViewportBaseSize
    );
    state.runner = runner;
    // The loop runs on rAF; counting its iterations here is what `__PIX3_PLAYER__.frames` reports.
    runner.setFrameScheduler({
      request: callback =>
        requestAnimationFrame(time => {
          state.frames++;
          callback(time);
        }),
      cancel: handle => cancelAnimationFrame(handle),
    });
    // Multiplayer (D5): owned by the runner, inert until a script connects; the generated module
    // is a no-op when nothing in the project mentions the network.
    installNetworkService(runner);
    runner.setBatching2DEnabled(true);
    runner.setProjectFonts(runtimeFonts.length > 0 ? runtimeFonts : null);
    if (runtimeLocalization) {
      runner.setLocalizationConfig({
        defaultLocale: runtimeLocalization.defaultLocale,
        fallbackLocale: runtimeLocalization.fallbackLocale,
        locales: runtimeLocalization.locales,
      });
    }
    // A single-file build has no sibling files: probing for an atlas manifest it did not embed can
    // never succeed, and in a sandboxed container it is a visible network error on every run.
    if (
      !resourceManager.hasEmbeddedResources ||
      resourceManager.hasEmbeddedResource(ATLAS_MANIFEST_PATH)
    ) {
      await installAtlasFromManifest(assetLoader, resourceManager);
    }
    // `loadAndStartScene` reads, parses and runs the graph directly; `startScene` would clone it
    // through the serializer, which a player does not need (and must not bundle).
    await runner.loadAndStartScene(scenePath);
    state.status = 'running';
    return runner;
  } catch (error) {
    state.status = 'failed';
    state.errors.push(describe(error));
    console.error('[pix3] Failed to start the game:', error);
    throw error;
  }
}
