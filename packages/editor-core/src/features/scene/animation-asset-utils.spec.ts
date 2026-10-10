import { describe, expect, it } from 'vitest';

import {
  deriveAnimationAssetStem,
  getAnimationAssetDirectory,
  isManagedSpriteFolder,
  normalizeAnimationAssetPath,
} from './animation-asset-utils';

describe('animation asset utils', () => {
  it('normalizes folder-based animation asset paths', () => {
    expect(normalizeAnimationAssetPath('res://src/assets/animations/player')).toBe(
      'res://src/assets/animations/player/player.pix3anim'
    );
    expect(normalizeAnimationAssetPath('src/assets/animations/player')).toBe(
      'res://src/assets/animations/player/player.pix3anim'
    );
  });

  it('preserves explicit pix3anim paths and derives a stable stem', () => {
    const explicitPath = 'res://src/assets/animations/player/player.pix3anim';
    expect(normalizeAnimationAssetPath(explicitPath)).toBe(explicitPath);
    expect(deriveAnimationAssetStem(explicitPath)).toBe('player');
    expect(getAnimationAssetDirectory(explicitPath)).toBe('res://src/assets/animations/player');
  });

  it('recognises a managed sprite folder only when every frame lives beside the resource', () => {
    const assetPath = 'res://sprites/hero/hero.pix3anim';

    expect(
      isManagedSpriteFolder(assetPath, [
        'res://sprites/hero/idle_0001.png',
        'res://sprites/hero/run_0001.png',
      ])
    ).toBe(true);
    // One frame reaching outside the folder makes the whole thing unmanaged.
    expect(
      isManagedSpriteFolder(assetPath, [
        'res://sprites/hero/idle_0001.png',
        'res://sprites/shared/shadow.png',
      ])
    ).toBe(false);
    // A nested subfolder is outside too.
    expect(isManagedSpriteFolder(assetPath, ['res://sprites/hero/idle/0001.png'])).toBe(false);
    // Nothing to judge → not managed.
    expect(isManagedSpriteFolder(assetPath, [])).toBe(false);
    // Scheme-less frame paths normalize to res:// before comparison.
    expect(isManagedSpriteFolder(assetPath, ['sprites/hero/idle_0001.png'])).toBe(true);
  });
});
