/**
 * Pure compiler for a **2D flipbook character** — ported from 1.x
 * (`pix3: src/services/library/character-compiler.ts`, the Store's `character2d` asset kind) for
 * `pix3 character-compile` (plan §F.5 (в)).
 *
 * Input: frame files already grouped into `variant + state` clips (the spec file does the
 * grouping; {@link scanNumberedSequences} is the generic first pass). Output: the files a
 * self-contained character needs, as data — the caller writes them and copies the frame files by
 * the returned plan.
 *
 * Layout follows the project's **managed sprite folder** convention, so the editor's Sprite Editor
 * shows the character as one card and can write frames back:
 *
 * ```text
 * sprites/<slug>/<slug>.pix3anim          clips named <variant>.<state> (sword.idle, bow.attack)
 * sprites/<slug>/sword_idle_0001.png      one file per frame, <clip-prefix>_<nnnn>
 * scenes/prefabs/<Name>.pix3scene         AnimatedSprite2D root carrying core:CharacterVisual2D
 * ```
 *
 * No timestamps, ids or randomness: the same input yields byte-identical output. Host-agnostic and
 * free of runtime imports (the CLI's Node-runnable code never loads the engine): the `.pix3anim`
 * shape is declared structurally below, and `compiler.spec.ts` holds it to the runtime's
 * `AnimationResource` interfaces, the frame naming to the editor's
 * `buildAnimationFrameResourcePath`, and the output to `pix3 validate` and a headless boot.
 */

import { stringify } from 'yaml';

// --- the `.pix3anim` shape this compiler writes (a subset of the runtime's AnimationResource) ---

export interface CharacterAnimationFrame {
  textureIndex: number;
  offset: { x: number; y: number };
  repeat: { x: number; y: number };
  durationMultiplier: number;
  anchor: { x: number; y: number };
  texturePath: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  collisionPolygon: { x: number; y: number }[];
  events: { signal: string; args: string }[];
  sourceSize: { width: number; height: number };
  points: { name: string; x: number; y: number; angle?: number }[];
}

export interface CharacterAnimationClip {
  name: string;
  frames: CharacterAnimationFrame[];
  fps: number;
  loop: boolean;
  playbackMode: 'normal' | 'ping-pong';
}

export interface CharacterAnimationResource {
  version: string;
  texturePath: string;
  clips: CharacterAnimationClip[];
}

// --- frame grouping ---------------------------------------------------------------------------

/** One source raster the caller has measured (decode is the host's job). */
export interface SourceFrameFile {
  /** Source-relative path (never absolute; never written into any output). */
  path: string;
  width: number;
  height: number;
}

export interface NumberedFrame extends SourceFrameFile {
  /** The numeric suffix parsed from the file name, as written (`0007` → 7). */
  number: number;
}

/** Files that share a directory and a name stem, ordered by their numeric suffix. */
export interface NumberedSequence {
  /** `<directory>/<stem>` — the identity a spec maps to a variant/state. */
  key: string;
  directory: string;
  stem: string;
  frames: NumberedFrame[];
  /** Numbers missing between the first and the last frame (the author decides what they mean). */
  gaps: number[];
  /** Numbers that occur more than once (e.g. `run_03.png` and `run_003.png`). */
  duplicates: number[];
  /** Distinct `WxH` sizes when the frames do not all share one. */
  mixedSizes: string[];
}

export interface SequenceScan {
  sequences: NumberedSequence[];
  /** Files without a numeric suffix — stills, sheets, covers; never silently a one-frame clip. */
  unnumbered: SourceFrameFile[];
}

const NUMBERED_STEM = /^(.*?)[ _\-.]*(\d+)$/;

/**
 * Group frame files by `<directory>/<stem>` and numeric suffix, numerically sorted. Generic on
 * purpose: nothing here knows any pack's naming; sequences need not start at 1 and gaps are
 * reported, not filled.
 */
export function scanNumberedSequences(files: readonly SourceFrameFile[]): SequenceScan {
  const byKey = new Map<string, NumberedSequence>();
  const unnumbered: SourceFrameFile[] = [];

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const directory = slash >= 0 ? normalized.slice(0, slash) : '';
    const fileName = normalized.slice(slash + 1);
    const dot = fileName.lastIndexOf('.');
    const stemWithNumber = dot > 0 ? fileName.slice(0, dot) : fileName;
    const match = NUMBERED_STEM.exec(stemWithNumber);
    if (!match || match[1].length === 0) {
      unnumbered.push(file);
      continue;
    }
    const stem = match[1];
    const key = directory ? `${directory}/${stem}` : stem;
    let sequence = byKey.get(key);
    if (!sequence) {
      sequence = { key, directory, stem, frames: [], gaps: [], duplicates: [], mixedSizes: [] };
      byKey.set(key, sequence);
    }
    sequence.frames.push({ ...file, path: normalized, number: Number.parseInt(match[2], 10) });
  }

  const sequences = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const sequence of sequences) {
    sequence.frames.sort((a, b) => a.number - b.number || a.path.localeCompare(b.path));
    const seen = new Set<number>();
    for (const frame of sequence.frames) {
      if (seen.has(frame.number) && !sequence.duplicates.includes(frame.number)) {
        sequence.duplicates.push(frame.number);
      }
      seen.add(frame.number);
    }
    const first = sequence.frames[0]?.number ?? 0;
    const last = sequence.frames[sequence.frames.length - 1]?.number ?? 0;
    for (let n = first; n <= last; n += 1) {
      if (!seen.has(n)) sequence.gaps.push(n);
    }
    const sizes = new Set(sequence.frames.map(f => `${f.width}x${f.height}`));
    sequence.mixedSizes = sizes.size > 1 ? [...sizes] : [];
  }

  return { sequences, unnumbered };
}

// --- compile ----------------------------------------------------------------------------------

export interface CharacterClipSpec {
  /** Clip-name prefix (`sword`); empty for a variant-less state (`die`). */
  variant: string;
  state: string;
  frames: readonly SourceFrameFile[];
  /** Defaults to {@link DEFAULT_CHARACTER_FPS} — a proposal for the author, not a recovered speed. */
  fps?: number;
  /** Defaults per {@link ONE_SHOT_STATES}. */
  loop?: boolean;
}

export interface CharacterCompileSpec {
  /** Display name; also the prefab file name. */
  name: string;
  /** Folder / file stem for the sprite folder (`goblin`). */
  slug: string;
  clips: readonly CharacterClipSpec[];
  /** Pair the prefab starts on; defaults to the first clip's. */
  defaultVariant?: string;
  defaultState?: string;
  /** Between variant and state in clip names. Default `.`. */
  separator?: string;
  /**
   * Frame anchor for every frame, normalized with y from the top (`AnimationFrame.anchor`): the
   * point of the canvas that lands on the node's position. For a character this is the feet — a
   * canvas whose last opaque row is 84 of 100 wants `{ x: 0.5, y: 0.85 }`, so positioning the node
   * places the character on the ground. Default `{ x: 0.5, y: 0.5 }` (canvas centre).
   */
  anchor?: { x: number; y: number };
  /** Project-relative directories. Defaults: `sprites`, `scenes/prefabs` (the starter layout). */
  spriteDirectory?: string;
  prefabDirectory?: string;
}

export interface CompiledCharacterFrameFile {
  /** Where the caller reads the raster from (spec-relative). */
  sourcePath: string;
  /** Project-relative path the `.pix3anim` references (no `res://`). */
  targetPath: string;
}

export interface CompiledCharacter {
  animationPath: string;
  animation: CharacterAnimationResource;
  /** `animation` serialized exactly as it should be written. */
  animationJson: string;
  prefabPath: string;
  prefabYaml: string;
  frameFiles: CompiledCharacterFrameFile[];
  /** Non-fatal findings for the author (mixed sizes, defaulted fps/loop). */
  warnings: string[];
}

export const DEFAULT_CHARACTER_FPS = 12;
export const DEFAULT_SPRITE_DIRECTORY = 'sprites';
export const DEFAULT_PREFAB_DIRECTORY = 'scenes/prefabs';
/** States that end and hold their last frame unless the author says otherwise. */
export const ONE_SHOT_STATES: readonly string[] = ['attack', 'die', 'death', 'hit', 'hurt'];

export class CharacterCompileError extends Error {}

export function defaultLoopForState(state: string): boolean {
  return !ONE_SHOT_STATES.includes(state.trim().toLowerCase());
}

/**
 * A clip name as a file-name prefix: frames are `<clip>_<nnnn>.png` in the managed sprite folder
 * (the kit's `pix3anim.md`; the 1.x editor's `sanitizeFrameFilePrefix`, gone with its Create
 * animation).
 */
export function clipFilePrefix(clipName: string): string {
  const sanitized = clipName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'frame';
}

const toResourcePath = (projectPath: string): string => `res://${projectPath}`;

const trimSlashes = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'png';
}

/**
 * Compile a character. Throws {@link CharacterCompileError} on input that cannot become a valid
 * bundle (no clips, an empty clip, a duplicate variant/state pair, a default pair no clip
 * provides); everything else is a warning.
 */
export function compileCharacter(spec: CharacterCompileSpec): CompiledCharacter {
  const name = spec.name.trim();
  const slug = spec.slug.trim();
  if (!name || !slug) {
    throw new CharacterCompileError('name and slug are required.');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    throw new CharacterCompileError(`slug "${slug}" must be a plain folder name.`);
  }
  if (spec.clips.length === 0) {
    throw new CharacterCompileError('a character needs at least one clip.');
  }
  const separator = spec.separator && spec.separator.length > 0 ? spec.separator : '.';
  const spriteDirectory = trimSlashes(spec.spriteDirectory ?? DEFAULT_SPRITE_DIRECTORY);
  const prefabDirectory = trimSlashes(spec.prefabDirectory ?? DEFAULT_PREFAB_DIRECTORY);
  for (const directory of [spriteDirectory, prefabDirectory]) {
    if (directory.split('/').some(part => part === '..' || part === '.')) {
      throw new CharacterCompileError(`"${directory}" must be a path inside the project.`);
    }
  }
  const folder = spriteDirectory ? `${spriteDirectory}/${slug}` : slug;
  const animationPath = `${folder}/${slug}.pix3anim`;
  const animationResourcePath = toResourcePath(animationPath);

  const anchor = spec.anchor ?? { x: 0.5, y: 0.5 };
  if (![anchor.x, anchor.y].every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new CharacterCompileError('anchor must be finite numbers.');
  }
  const warnings: string[] = [];
  const frameFiles: CompiledCharacterFrameFile[] = [];
  const clips: CharacterAnimationClip[] = [];
  const clipNames = new Set<string>();

  for (const clipSpec of spec.clips) {
    const variant = clipSpec.variant.trim();
    const state = clipSpec.state.trim();
    if (!state) {
      throw new CharacterCompileError('every clip needs a state.');
    }
    const clipName = variant ? `${variant}${separator}${state}` : state;
    if (clipNames.has(clipName)) {
      throw new CharacterCompileError(`duplicate clip "${clipName}".`);
    }
    clipNames.add(clipName);
    if (clipSpec.frames.length === 0) {
      throw new CharacterCompileError(`clip "${clipName}" has no frames.`);
    }
    if (clipSpec.fps !== undefined && !(Number.isFinite(clipSpec.fps) && clipSpec.fps > 0)) {
      throw new CharacterCompileError(`clip "${clipName}": fps must be a positive number.`);
    }

    const sizes = new Set(clipSpec.frames.map(f => `${f.width}x${f.height}`));
    if (sizes.size > 1) {
      warnings.push(
        `${clipName}: frames differ in size (${[...sizes].join(', ')}); sizeMode native keeps each frame's own size.`
      );
    }
    if (clipSpec.fps === undefined) {
      warnings.push(`${clipName}: fps defaulted to ${DEFAULT_CHARACTER_FPS}.`);
    }
    const loop = clipSpec.loop ?? defaultLoopForState(state);
    if (clipSpec.loop === undefined) {
      warnings.push(`${clipName}: loop defaulted to ${loop}.`);
    }

    const prefix = clipFilePrefix(clipName);
    const frames: CharacterAnimationFrame[] = clipSpec.frames.map((frame, index) => {
      const number = String(index + 1).padStart(4, '0');
      const targetPath = `${folder}/${prefix}_${number}.${extensionOf(frame.path)}`;
      frameFiles.push({ sourcePath: frame.path, targetPath });
      return {
        textureIndex: 0,
        offset: { x: 0, y: 0 },
        repeat: { x: 1, y: 1 },
        durationMultiplier: 1,
        anchor: { x: anchor.x, y: anchor.y },
        texturePath: toResourcePath(targetPath),
        boundingBox: { x: 0, y: 0, width: frame.width, height: frame.height },
        collisionPolygon: [],
        events: [],
        sourceSize: { width: frame.width, height: frame.height },
        points: [],
      };
    });

    clips.push({
      name: clipName,
      fps: clipSpec.fps ?? DEFAULT_CHARACTER_FPS,
      loop,
      playbackMode: 'normal',
      frames,
    });
  }

  // Two clips whose names sanitize to one prefix would write the same frame files.
  const targets = new Map<string, string>();
  for (const file of frameFiles) {
    const previous = targets.get(file.targetPath);
    if (previous !== undefined && previous !== file.sourcePath) {
      throw new CharacterCompileError(
        `two frames would be written to ${file.targetPath} (clip names that differ only in punctuation or case).`
      );
    }
    targets.set(file.targetPath, file.sourcePath);
  }

  const defaultVariant = (spec.defaultVariant ?? spec.clips[0].variant).trim();
  const defaultState = (spec.defaultState ?? spec.clips[0].state).trim();
  const defaultClipName = defaultVariant
    ? `${defaultVariant}${separator}${defaultState}`
    : defaultState;
  const defaultClip = clips.find(clip => clip.name === defaultClipName);
  if (!defaultClip) {
    throw new CharacterCompileError(
      `default pair ${defaultVariant || '<none>'}/${defaultState} has no clip (have: ${[...clipNames].join(', ')}).`
    );
  }
  const size = defaultClip.frames[0].sourceSize;

  const animation: CharacterAnimationResource = { version: '1.0.0', texturePath: '', clips };
  const animationJson = `${JSON.stringify(animation, null, 2)}\n`;

  // The character IS the sprite: one AnimatedSprite2D root carrying the component. Selecting the
  // character then selects the drawn quad (the viewport frames it and shows the pivot — the feet —
  // at the node position); a Group2D wrapper would frame a centred box the frame anchor pushes off
  // the art. Items in hand go under the sprite with core:PointAttachment.
  const prefab = {
    version: '1.0.0',
    metadata: { name, description: `${name} — 2D character (variant/state flipbook)` },
    root: [
      {
        id: slug,
        type: 'AnimatedSprite2D',
        name,
        properties: {
          animationResourcePath,
          currentClip: defaultClipName,
          isPlaying: true,
          sizeMode: 'native',
          width: size.width,
          height: size.height,
          transform: { position: [0, 0], scale: [1, 1], rotation: 0 },
        },
        components: [
          {
            id: `${slug}-character`,
            type: 'core:CharacterVisual2D',
            enabled: true,
            config: { variant: defaultVariant, state: defaultState, separator },
          },
        ],
        children: [],
      },
    ],
  };

  const prefabFile = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.pix3scene`;
  return {
    animationPath,
    animation,
    animationJson,
    prefabPath: prefabDirectory ? `${prefabDirectory}/${prefabFile}` : prefabFile,
    prefabYaml: stringify(prefab, { lineWidth: 0 }),
    frameFiles,
    warnings,
  };
}

// --- frame sizes ------------------------------------------------------------------------------

/**
 * Width and height of a PNG from its IHDR chunk, or null for anything else. The CLI's
 * Node-runnable code does not load the engine, so this is the one format it reads itself; the
 * spec compares it with the runtime's `readImageHeaderSize`.
 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
  if (!isPng) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
