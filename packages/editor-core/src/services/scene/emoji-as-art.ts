/**
 * Emoji are never game art — the inspector side of the rule.
 *
 * The detection and the words live in `@pix3/runtime` (`core/emoji-as-art.ts`): `pix3 validate`
 * reports `E_EMOJI_AS_ART` for a scene file with an emoji-only `label`/`text`, and the inspector
 * refuses the same value in a text field before it reaches the scene, so a designer cannot type
 * into the editor what `pix3 check` would then fail. One rule, one wording, two enforcers.
 */
import { describeEmojiAsArt } from '@pix3/runtime';

/**
 * The refusal an inspector text field shows for `value` in `propertyName`, or null when the value
 * may be written. Same rule and wording as `E_EMOJI_AS_ART`.
 */
export const emojiAsArtFieldError = (propertyName: string, value: unknown): string | null => {
  const finding = describeEmojiAsArt(propertyName, value);
  return finding ? `E_EMOJI_AS_ART: ${finding.message} Instead: ${finding.fix}.` : null;
};
