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
  export const runtimeQuality: {
    readonly antialias: boolean;
    readonly shadows: boolean;
    readonly maxPixelRatio: number;
  };
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
    { readonly base64: string; readonly mimeType?: string }
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
