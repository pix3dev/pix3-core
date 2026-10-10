/**
 * One `pix3project.yaml` `autoloads:` entry: a script singleton built once per game session and
 * kept across `changeScene` (`core/autoloads.ts`; scripts reach it with `scene.getAutoload`).
 */
export interface AutoloadConfig {
  /** Project script whose class, named like the file, is the singleton (`scripts/GameState.ts`). */
  scriptPath: string;
  /** The name `scene.getAutoload(name)` finds it by. */
  singleton: string;
  /** False: declared but not built. Default true. */
  enabled: boolean;
}

export interface ProjectManifest {
  version: string;
  autoloads: AutoloadConfig[];
  metadata?: Record<string, unknown>;
}
