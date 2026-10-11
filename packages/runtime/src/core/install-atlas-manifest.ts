import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';
import { createAtlasResolver, type AtlasManifest } from './atlas-frame-map';

/** Where a host that ships a pre-packed atlas puts it (the 2.x build packs none). */
export const ATLAS_MANIFEST_PATH = 'res://assets/.atlas/atlas-manifest.json';
export const ATLAS_SHEET_DIR = 'res://assets/.atlas/';

/**
 * For a host that ships a pre-packed atlas: if its
 * manifest is present, install a resolver so every eligible texture loads as a
 * view onto a bundled sheet (sheets are real res:// files — `loadTexture` loads
 * them like any texture, no preseeding needed). Call before
 * `SceneRunner.startScene`.
 *
 * Defensive: a missing/unreadable/invalid manifest leaves the loader un-atlased
 * (byte-identical to the pre-atlas path), so a game with no packed atlas — or a
 * malformed one — still starts.
 */
export async function installAtlasFromManifest(
  assetLoader: AssetLoader,
  resourceManager: ResourceManager
): Promise<boolean> {
  try {
    const text = await resourceManager.readText(ATLAS_MANIFEST_PATH);
    const manifest = JSON.parse(text) as AtlasManifest;
    if (!manifest || manifest.formatVersion !== 1 || !Array.isArray(manifest.sheets)) {
      return false;
    }
    const fileById = new Map(manifest.sheets.map(sheet => [sheet.id, sheet.file]));
    assetLoader.setAtlasResolver(
      createAtlasResolver(manifest, id => `${ATLAS_SHEET_DIR}${fileById.get(id) ?? `${id}.png`}`)
    );
    return true;
  } catch {
    return false;
  }
}
