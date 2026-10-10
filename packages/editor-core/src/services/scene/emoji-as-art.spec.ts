import { describe, expect, it } from 'vitest';
import {
  describeEmojiAsArt,
  findEmojiArtInSceneYaml,
  isEmojiOnlyText,
  isTextProperty,
} from '@pix3/runtime';

import { emojiAsArtFieldError } from './emoji-as-art';

describe('isEmojiOnlyText', () => {
  it('flags a label that is nothing but a picture', () => {
    expect(isEmojiOnlyText('🪙')).toBe(true);
    expect(isEmojiOnlyText('  🪙  ')).toBe(true);
    expect(isEmojiOnlyText('⭐⭐⭐')).toBe(true);
    // Compound emoji: skin tone, ZWJ sequences, keycaps.
    expect(isEmojiOnlyText('👍🏽')).toBe(true);
    expect(isEmojiOnlyText('👩‍🚀')).toBe(true);
    expect(isEmojiOnlyText('✅')).toBe(true);
  });

  /**
   * The carve-out that keeps this enforceable: an emoji inside a sentence is punctuation a person
   * wrote, not a sprite standing in for art. Refusing those would make the guard something to work
   * around rather than something to follow.
   */
  it('leaves an emoji inside real text alone', () => {
    expect(isEmojiOnlyText('Счёт: 10 🪙')).toBe(false);
    expect(isEmojiOnlyText('Play ▶')).toBe(false);
    expect(isEmojiOnlyText('🪙 x3')).toBe(false);
  });

  /**
   * `Extended_Pictographic` also covers the symbol glyphs AGENTS.md already bans as icons, which is
   * the behaviour we want: a play button whose whole label is ▶ is the same defect as a coin that
   * is 🪙. Arrows used as text are NOT pictographic and stay allowed.
   */
  it('treats a lone symbol glyph as a picture, but not an arrow used as text', () => {
    expect(isEmojiOnlyText('▶')).toBe(true);
    expect(isEmojiOnlyText('⏸')).toBe(true);
    expect(isEmojiOnlyText('→')).toBe(false);
    expect(isEmojiOnlyText('←')).toBe(false);
  });

  it('does not mistake ordinary text for a picture', () => {
    expect(isEmojiOnlyText('SCORE 0')).toBe(false);
    expect(isEmojiOnlyText('Играть')).toBe(false);
    expect(isEmojiOnlyText('')).toBe(false);
    expect(isEmojiOnlyText('$100')).toBe(false);
    expect(isEmojiOnlyText('→')).toBe(false);
    expect(isEmojiOnlyText('日本語')).toBe(false);
  });
});

describe('isTextProperty', () => {
  it('covers the properties that get drawn as text, and nothing else', () => {
    expect(isTextProperty('label')).toBe(true);
    expect(isTextProperty('properties.label')).toBe(true);
    expect(isTextProperty('text')).toBe(true);
    // A node NAME or an asset path with an emoji in it is none of this guard's business.
    expect(isTextProperty('name')).toBe(false);
    expect(isTextProperty('texturePath')).toBe(false);
  });
});

describe('emojiAsArtFieldError', () => {
  it('refuses an emoji-only label with the words of E_EMOJI_AS_ART', () => {
    const error = emojiAsArtFieldError('label', '🪙');
    const finding = describeEmojiAsArt('label', '🪙');
    expect(finding).not.toBeNull();
    expect(error).toContain('E_EMOJI_AS_ART');
    expect(error).toContain(finding?.message);
    expect(error).toContain(finding?.fix);
    expect(error).toMatch(/ColorRect2D/);
    // The 1.x agent tools are gone: the refusal names none of them.
    expect(error).not.toMatch(/generate_asset|set_property/);
  });

  it('says nothing for real text, a non-text property, or a non-string value', () => {
    expect(emojiAsArtFieldError('label', 'Счёт: 10 🪙')).toBeNull();
    expect(emojiAsArtFieldError('name', '🪙')).toBeNull();
    expect(emojiAsArtFieldError('label', 42)).toBeNull();
  });
});

describe('findEmojiArtInSceneYaml', () => {
  /**
   * Scene YAML is the path around every property setter: a file write of a whole `.pix3scene` never
   * touches the inspector. This is the measured shape of the defect that started the rule.
   */
  it('finds emoji art written straight into a scene file, all of it', () => {
    const yaml = `
  - id: coin
    type: Button2D
    properties:
      label: 🪙
      labelFontSize: 140
  - id: star
    type: Label2D
    properties:
      text: "⭐"
  - id: score
    type: Label2D
    properties:
      label: SCORE 0
`;
    expect(findEmojiArtInSceneYaml(yaml)).toEqual([
      { property: 'label', value: '🪙' },
      { property: 'text', value: '⭐' },
    ]);
  });

  it('stays quiet on a scene with no emoji art', () => {
    expect(findEmojiArtInSceneYaml('      label: SCORE 0\n      text: "Играть"\n')).toEqual([]);
  });
});
