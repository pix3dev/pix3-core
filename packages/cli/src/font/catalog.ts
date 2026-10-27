/**
 * The fonts `pix3 font add` ships into a project: the six display families of pix3-full's UI Kit
 * Forge (`src/services/uikit/ForgeTheme.ts` `FONTS` there), at the weight the forge uses each one,
 * as the Google Fonts woff2 subsets (Latin, plus Cyrillic where the family has it). The files live
 * in `packages/cli/fonts/` beside their licences — SIL OFL 1.1, Apache 2.0 for Luckiest Guy — and
 * were fetched on 2026-10-27 from fonts.googleapis.com (`css2?family=<family>:wght@<weight>`, the
 * `unicode-range` below is that stylesheet's) and the licences from github.com/google/fonts.
 *
 * Why the CLI carries them: a `Label2D` without a shipped face renders in whatever the machine has
 * (Arial on one, DejaVu on a headless Linux), so the game looks different everywhere
 * (core-tests/game7). A starter carries none — a face costs its bytes in every single-file build —
 * so the agent adds one when the game has text.
 */

export interface FontSubset {
  readonly subset: 'latin' | 'cyrillic';
  readonly unicodeRange: string;
}

export interface CatalogFont {
  readonly family: string;
  /** File-name form (`Lilita One` → `lilita-one`). */
  readonly slug: string;
  /** The one weight shipped; set `labelFontWeight` to it. */
  readonly weight: number;
  readonly subsets: readonly FontSubset[];
  /** The licence file beside the faces in `packages/cli/fonts/`, copied with them. */
  readonly licenseFile: string;
  readonly license: string;
  /** One line for `pix3 font`'s list. */
  readonly look: string;
}

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const CYRILLIC = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116';

const latinOnly: readonly FontSubset[] = [{ subset: 'latin', unicodeRange: LATIN }];
const latinCyrillic: readonly FontSubset[] = [
  { subset: 'latin', unicodeRange: LATIN },
  { subset: 'cyrillic', unicodeRange: CYRILLIC },
];

export const FONT_CATALOG: readonly CatalogFont[] = [
  {
    family: 'Nunito',
    slug: 'nunito',
    weight: 900,
    subsets: latinCyrillic,
    licenseFile: 'nunito-OFL.txt',
    license: 'SIL OFL 1.1',
    look: 'rounded, friendly; the safe default',
  },
  {
    family: 'Rubik',
    slug: 'rubik',
    weight: 800,
    subsets: latinCyrillic,
    licenseFile: 'rubik-OFL.txt',
    license: 'SIL OFL 1.1',
    look: 'soft geometric, compact numbers',
  },
  {
    family: 'Baloo 2',
    slug: 'baloo-2',
    weight: 800,
    subsets: latinOnly,
    licenseFile: 'baloo-2-OFL.txt',
    license: 'SIL OFL 1.1',
    look: 'chunky, bubbly',
  },
  {
    family: 'Fredoka',
    slug: 'fredoka',
    weight: 700,
    subsets: latinOnly,
    licenseFile: 'fredoka-OFL.txt',
    license: 'SIL OFL 1.1',
    look: 'round, playful',
  },
  {
    family: 'Lilita One',
    slug: 'lilita-one',
    weight: 400,
    subsets: latinOnly,
    licenseFile: 'lilita-one-OFL.txt',
    license: 'SIL OFL 1.1',
    look: 'heavy condensed display, titles and buttons',
  },
  {
    family: 'Luckiest Guy',
    slug: 'luckiest-guy',
    weight: 400,
    subsets: latinOnly,
    licenseFile: 'luckiest-guy-LICENSE.txt',
    license: 'Apache 2.0',
    look: 'cartoon all-caps display',
  },
];

/** The face file of one subset, in `packages/cli/fonts/` and in the project's `fonts/` alike. */
export const fontFileName = (font: CatalogFont, subset: FontSubset): string =>
  `${font.slug}-${font.weight}-${subset.subset}.woff2`;

/** A catalog font by family or slug, any case (`"lilita one"`, `lilita-one`). */
export const findCatalogFont = (name: string): CatalogFont | null => {
  const wanted = name.trim().toLowerCase();
  return (
    FONT_CATALOG.find(font => font.family.toLowerCase() === wanted || font.slug === wanted) ?? null
  );
};
