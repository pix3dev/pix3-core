import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  bleedFindings,
  clippedFindings,
  spriteFindings,
  type PixelFinding,
} from '../image/pixel-checks.ts';
import { measurePixels, type PixelFacts } from '../image/pixel-facts.ts';
import { decodePng } from '../image/png.ts';
import { diagnostic, type Diagnostic } from './diagnostics.ts';
import { toProjectPath, type ProjectFiles } from './project.ts';
import { formatPath, isRecord } from './yaml-doc.ts';

/**
 * The pixel warnings of `pix3 validate` (`W_SPRITE_NO_ALPHA`, `W_FRAME_CLIPPED`,
 * `W_FRAME_BLEED`; plan `.plans/jam-takeaways.md` E2), only for PNGs a scene or a `.pix3anim`
 * uses. Each PNG is decoded once and its {@link PixelFacts} kept in `.pix3/cache/pixels.json`
 * by modification time and size, so a re-run decodes only what changed. `--no-pixels` skips it.
 */

/** Bumped whenever {@link PixelFacts} changes shape or meaning: the cache starts over. */
const CACHE_VERSION = 1;
const PIXEL_CACHE_FILE = '.pix3/cache/pixels.json';

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  /** Null: not a PNG this reader decodes (16-bit, interlaced) — no checks, not retried. */
  readonly facts: PixelFacts | null;
}

class FactsCache {
  private readonly entries: Record<string, CacheEntry> = {};
  private readonly used = new Set<string>();
  private changed = false;

  constructor(private readonly project: ProjectFiles) {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (isRecord(data) && data.version === CACHE_VERSION && isRecord(data.files)) {
        this.entries = data.files as Record<string, CacheEntry>;
      }
    } catch {
      // no cache yet, or an unreadable one: start over
    }
  }

  private get path(): string {
    return join(this.project.root, PIXEL_CACHE_FILE);
  }

  facts(file: string): PixelFacts | null {
    this.used.add(file);
    let stat;
    try {
      stat = statSync(this.project.absolute(file));
    } catch {
      return null;
    }
    const cached: unknown = this.entries[file];
    if (
      isRecord(cached) &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      (cached.facts === null || (isRecord(cached.facts) && Array.isArray(cached.facts.strays)))
    ) {
      return cached.facts as PixelFacts | null;
    }
    let facts: PixelFacts | null = null;
    try {
      facts = measurePixels(decodePng(readFileSync(this.project.absolute(file))));
    } catch {
      // a PNG the browser reads and this decoder does not: nothing to say about its pixels
    }
    this.entries[file] = { mtimeMs: stat.mtimeMs, size: stat.size, facts };
    this.changed = true;
    return facts;
  }

  /** Writes the cache when it changed; entries of files that are gone are dropped. */
  save(): void {
    for (const file of Object.keys(this.entries)) {
      if (!this.used.has(file) && !this.project.has(file)) {
        delete this.entries[file];
        this.changed = true;
      }
    }
    if (!this.changed) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Through a temporary file: two runs at once never leave half a cache behind.
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: CACHE_VERSION, files: this.entries })}\n`
      );
      renameSync(temporary, this.path);
    } catch {
      // a read-only checkout: the next run measures again
    }
  }
}

const isPngPath = (path: string): boolean => /\.png$/i.test(path);

interface FrameRef {
  readonly file: string;
  readonly path: string;
}

/** The PNG frames of each sequence-mode clip of a `.pix3anim` (spritesheet frames are UV rects). */
const animationClips = (project: ProjectFiles, file: string): FrameRef[][] => {
  let data: unknown;
  try {
    data = JSON.parse(project.readText(file));
  } catch {
    return []; // E_ANIM_JSON says so
  }
  if (!isRecord(data) || !Array.isArray(data.clips)) return [];
  return data.clips.map((clip, clipIndex) => {
    if (!isRecord(clip) || !Array.isArray(clip.frames)) return [];
    const frames: FrameRef[] = [];
    clip.frames.forEach((frame, frameIndex) => {
      if (!isRecord(frame) || typeof frame.texturePath !== 'string') return;
      const target = toProjectPath(frame.texturePath);
      if (!target || !isPngPath(target) || !project.has(target)) return;
      frames.push({
        file: target,
        path: formatPath(['clips', clipIndex, 'frames', frameIndex, 'texturePath']),
      });
    });
    return frames;
  });
};

/**
 * `sceneImages`: PNG → the scene files that use it; `animations`: the `.pix3anim` files whose
 * frames to check.
 */
export const checkPixels = (
  project: ProjectFiles,
  sceneImages: ReadonlyMap<string, readonly string[]>,
  animations: readonly string[]
): Diagnostic[] => {
  const cache = new FactsCache(project);
  const out: Diagnostic[] = [];
  const alphaChecked = new Set<string>();
  const report = (file: string, finding: PixelFinding, where: string, path?: string): void => {
    out.push(
      diagnostic({
        code: finding.code,
        file,
        path,
        message: `${where}: ${finding.message}`,
        fix: finding.fix,
      })
    );
  };

  for (const [image, scenes] of [...sceneImages].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isPngPath(image)) continue;
    const facts = cache.facts(image);
    alphaChecked.add(image);
    if (!facts) continue;
    for (const finding of spriteFindings(facts)) {
      const more = scenes.length > 1 ? ` (and ${scenes.length - 1} more)` : '';
      report(image, finding, `${image}, used by ${scenes[0]}${more}`);
    }
  }

  for (const animation of animations) {
    for (const clip of animationClips(project, animation)) {
      const facts = clip.map(frame => cache.facts(frame.file));
      const known = clip.flatMap((frame, i) => (facts[i] ? [{ frame, facts: facts[i] }] : []));
      const clipped = clippedFindings(known.map(entry => entry.facts));
      known.forEach(({ frame, facts: frameFacts }, i) => {
        const findings = [...bleedFindings(frameFacts), ...clipped[i]];
        if (!alphaChecked.has(frame.file)) {
          findings.unshift(...spriteFindings(frameFacts));
          alphaChecked.add(frame.file);
        }
        for (const finding of findings)
          report(animation, finding, `frame ${frame.file}`, frame.path);
      });
    }
  }
  cache.save();
  return out;
};
