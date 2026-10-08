import type { ServiceContainer } from '@/fw/di';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

/** Resource id of the singleton game tab in Studio. */
const GAME_TAB_RESOURCE_ID = 'game-view-instance';

/**
 * Make `resourcePath` the active scene: focus (or open) its editor tab, so the viewport, selection
 * and camera state follow. Scripts first: a scene parsed before the project's `user:*` classes are
 * registered loads with its script components parked — it renders, but the game logic is dead.
 */
export const ensureSceneActive = async (
  container: ServiceContainer,
  resourcePath: string
): Promise<void> => {
  const scripts = container.getService<ProjectScriptLoaderService>(
    container.getOrCreateToken(ProjectScriptLoaderService)
  );
  await scripts.ensureReady();

  const tabs = container.getService<EditorTabService>(container.getOrCreateToken(EditorTabService));
  await tabs.focusOrOpenScene(resourcePath);
};

/** Path (relative, no scheme) of the scene the editor treats as the gameplay scene. */
const GAMEPLAY_SCENE_PATH = 'scenes/main.pix3scene';

const stripScheme = (path: string): string =>
  path
    .replace(/^res:\/\//i, '')
    .replace(/^\/+/, '')
    .toLowerCase();

/**
 * Which scene to open when a play command is asked to run "the current scene" and nothing is open.
 *
 * The order deliberately prefers the **gameplay** scene over the project's entry scene: recipe
 * projects boot a menu (`entryScene: scenes/menu.pix3scene` → `defaultExportScenePath`), and landing
 * a prototyping session on the menu is both what the user sees on the stage and — worse — what every
 * subsequent agent edit targets, since `appState.scenes.activeSceneId` is the editing surface.
 * (The retired in-editor agent's `ensureActiveScene` reasoned the same way.)
 *
 * The manifest's `defaultExportScenePath` is **not** in the order, on purpose: on a recipe project
 * that value *is* the menu. A project that genuinely ships no `scenes/main.pix3scene` and has no
 * scene open gets a failure naming the path it looked for, and the caller can still run the whole
 * flow through `game.start-main` — which is a better outcome than silently prototyping on a menu.
 */
export const resolveGameplayScenePath = (state: {
  scenes: { descriptors: Record<string, { filePath?: string } | undefined> };
}): string => {
  const descriptorPaths = Object.values(state.scenes.descriptors)
    .map(descriptor => descriptor?.filePath ?? '')
    .filter(path => path.length > 0);

  return (
    descriptorPaths.find(path => stripScheme(path) === GAMEPLAY_SCENE_PATH) ??
    descriptorPaths[0] ??
    // Nothing is open (the startup scene failed to open, or its tab was closed). Every shipped
    // template carries this path.
    `res://${GAMEPLAY_SCENE_PATH}`
  );
};

/** Reveal the surface the running game is drawn on: open/focus the Game tab. */
export const openGameSurface = async (container: ServiceContainer): Promise<void> => {
  const tabs = container.getService<EditorTabService>(container.getOrCreateToken(EditorTabService));
  await tabs.openResourceTab('game', GAME_TAB_RESOURCE_ID, {}, true);
};

/** Tear the game tab down after a stop. */
export const closeGameSurface = async (container: ServiceContainer): Promise<void> => {
  const tabs = container.getService<EditorTabService>(container.getOrCreateToken(EditorTabService));
  await tabs.closeTab(`game:${GAME_TAB_RESOURCE_ID}`);
};
