/**
 * The `virtual:pix3/*` modules the plugin generates for the player (`src/build/player-modules.ts`
 * is their source of truth; keep the two in step).
 */

declare module 'virtual:pix3/scene-manifest' {
  export const scenePaths: readonly string[];
  export const activeScenePath: string;
  /** `ResourceManager` base URL: `/<resRoot>/` in dev, `./` in a build. */
  export const resourceBase: string;
  export const projectName: string;
  export const runtimeViewportBaseSize: { readonly width: number; readonly height: number };
  /**
   * `pix3project.yaml` `app.backButton`, resolved for this page: `true` / `false` as written, else
   * `'top-level'` in a zip build (on unless the page is framed) and `false` in an html build and
   * on the dev server.
   */
  export const runtimeBackButton: boolean | 'top-level';
  export const runtimeQuality: {
    readonly antialias: boolean;
    readonly shadows: boolean;
    readonly maxPixelRatio: number;
  };
  /**
   * `pix3project.yaml` `storage.namespace` (else the project name as a slug): `scene.storage` keeps
   * the save under `pix3:<namespace>:save`. Null in a build that stripped the store.
   */
  export const runtimeStorageNamespace: string | null;
  export const runtimeFonts: readonly {
    readonly family: string;
    readonly path: string;
    readonly weight?: number | string;
    readonly style?: 'normal' | 'italic';
    readonly unicodeRange?: string;
  }[];
  export const runtimeLocalization: {
    readonly defaultLocale: string;
    readonly fallbackLocale?: string;
    readonly locales: readonly string[];
  } | null;
  /** `pix3project.yaml` `autoloads:`, normalised (the runtime's `AutoloadConfig`). */
  export const runtimeAutoloads: readonly {
    readonly singleton: string;
    readonly scriptPath: string;
    readonly enabled: boolean;
  }[];
  export const netKindTable: {
    readonly prefabs: readonly string[];
    readonly authored: readonly string[];
  };
}

declare module 'virtual:pix3/embedded-assets' {
  export const embeddedAssets: Record<
    string,
    | { readonly base64: string; readonly mimeType?: string }
    | { readonly text: string; readonly mimeType?: string }
  >;
}

declare module 'virtual:pix3/project-scripts' {
  /** Eager `import.meta.glob` over `scripts/` and `src/scripts/`, keyed by `/scripts/Foo.ts`. */
  export const modules: Record<string, Record<string, unknown>>;
}

declare module 'virtual:pix3/spine' {}

declare module 'virtual:pix3/postprocessing' {}

declare module 'virtual:pix3/network' {
  import type { SceneRunner } from '@pix3/runtime';
  export function installNetworkService(runner: SceneRunner): void;
}

declare module 'virtual:pix3/dev' {
  import type { AudioService, RuntimeRenderer, SceneRunner } from '@pix3/runtime';
  /** Dev: the URL's `?scene=` (`res://` stripped), or null. Build: always null. */
  export function devSceneOverride(): string | null;
  /** `?run=<json>` on the dev server — a test run's `RunOverrides` (`seed`, `reducedMotion`, `storage`, `config`); null in a build. */
  export function devRunOverrides(): import('@pix3/runtime').RunOverrides | null;
  /** Dev with the editor: the file revision the server stamped into the page; else null. */
  export function devPageRev(): number | null;
  /**
   * Dev, a page the editor opened (`?role=`): the editor link `player/dev/page-link.ts` opened
   * while the page loaded — its `loadId`, and the Play `gate` the player waits at. Else null.
   */
  export function devPageLink(): {
    readonly loadId: string;
    readonly gate: Promise<void> | null;
  } | null;
  /**
   * Dev: `RunOverrides.record` starts a recording, `.replay` sets one up (`player/dev/run-tape.ts`,
   * read back through `window.__PIX3_RUN_TAPE__`); nothing otherwise. Build: says it cannot.
   */
  export function installRunTape(
    runner: SceneRunner,
    run: import('@pix3/runtime').RunOverrides | null
  ): Promise<void>;
  /**
   * Dev: the debug overlay when the URL has `?debug`, else the "Pix3 editor" link, and
   * `state.loadTools` (the test host). Build: a no-op.
   * The argument is `player/debug/context.ts`'s `Pix3DebugContext` (an ambient module cannot
   * import it).
   */
  export function installDevTools(context: {
    readonly runner: SceneRunner;
    readonly renderer: RuntimeRenderer;
    readonly audio: AudioService;
    readonly state: {
      status: string;
      errors: string[];
      scene: string | null;
      debug?: { snapshot(): unknown };
      loadTools?: () => Promise<boolean>;
    };
  }): void;
}
