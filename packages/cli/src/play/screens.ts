/**
 * The screen gallery of `pix3 play --screens`: the states listed in `design/tests/screens.ts`,
 * each set up directly (its `RunOverrides`, its scene, a policy that walks to it), photographed
 * per locale × size, a contact sheet (`index.html`, its picture `sheet.png` with a box over every
 * flagged node, the same blurred as `sheet-blur.png`) and `screens.json` with each picture's checks
 * (`screen-checks.ts`). The runs themselves are `pix3 play`'s (`command.ts`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveEsbuild } from '../package-root.ts';
import type { ScreenChecks, ScreenViolation } from './screen-checks.ts';

export const SCREENS_FILE = 'design/tests/screens.ts';

/** One state of the game worth a picture (`design/tests/screens.ts` exports a list of them). */
export interface ScreenState {
  readonly name: string;
  /** `RunOverrides` of the run: config, storage, seed, ads, reducedMotion, locale. */
  readonly overrides: Record<string, unknown>;
  /** Another scene to boot (dev server only). */
  readonly scene?: string;
  /** A bot policy that walks to the state and ends with `done(true)` on it. */
  readonly policy?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The list as the file exported it, checked; exported for the spec. */
export const checkScreens = (value: unknown): ScreenState[] | { error: string } => {
  const where = `${SCREENS_FILE}:`;
  if (!Array.isArray(value) || value.length === 0)
    return { error: `${where} export default a non-empty list of { name, overrides } states` };
  const names = new Set<string>();
  const screens: ScreenState[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${where} entry ${index + 1}`;
    if (!isObject(entry)) return { error: `${at} is not an object` };
    const { name, overrides = {}, scene, policy } = entry;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name))
      return { error: `${at}: name is a file-name-safe word (letters, digits, _ and -)` };
    if (names.has(name)) return { error: `${at}: the name ${name} is taken` };
    names.add(name);
    if (!isObject(overrides)) return { error: `${at} (${name}): overrides is an object` };
    const single = ['record', 'replay'].filter(key => key in overrides);
    if (single.length > 0)
      return {
        error: `${at} (${name}): overrides take no ${single.join(', ')} (a screen is a picture)`,
      };
    if (scene !== undefined && typeof scene !== 'string')
      return { error: `${at} (${name}): scene is a res:// path` };
    if (policy !== undefined && (typeof policy !== 'string' || !policy.trim()))
      return { error: `${at} (${name}): policy is the name of a file in design/tests/bots` };
    screens.push({
      name,
      overrides,
      ...(scene !== undefined ? { scene } : {}),
      ...(policy !== undefined ? { policy: policy.trim() } : {}),
    });
  }
  return screens;
};

/** `design/tests/screens.ts` compiled (esbuild, its imports bundled) and imported. */
export const loadScreens = async (root: string): Promise<ScreenState[] | { error: string }> => {
  const file = join(root, SCREENS_FILE);
  if (!existsSync(file))
    return {
      error: `no ${SCREENS_FILE} (pix3 kit --update writes a starter; list the states to photograph there)`,
    };
  const specifier = resolveEsbuild();
  if (!specifier)
    return { error: `esbuild is not installed (npm install): ${SCREENS_FILE} cannot compile` };
  let exported: unknown;
  try {
    const esbuild = (await import(specifier)) as typeof import('esbuild');
    const built = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      logLevel: 'silent',
    });
    const code = built.outputFiles[0]?.text ?? '';
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )) as { default?: unknown };
    exported = module.default;
  } catch (error) {
    return { error: `${SCREENS_FILE} does not load: ${(error as Error).message}` };
  }
  return checkScreens(exported);
};

/** `--only a,b` over the list; an unknown name is an error. */
export const selectScreens = (
  screens: readonly ScreenState[],
  only: readonly string[]
): ScreenState[] | { error: string } => {
  if (only.length === 0) return [...screens];
  const unknown = only.filter(name => !screens.some(screen => screen.name === name));
  if (unknown.length > 0)
    return {
      error: `--only: no screen ${unknown.join(', ')} in ${SCREENS_FILE} (it has ${screens.map(s => s.name).join(', ')})`,
    };
  return screens.filter(screen => only.includes(screen.name));
};

/** One picture of the gallery: a state in one locale at one size. */
export interface ScreenPicture {
  readonly screen: string;
  readonly locale?: string;
  /** `390x844@2` */
  readonly size: string;
  /** The PNG; absent when the page gave none. */
  readonly file?: string;
  readonly status: 'ok' | 'error';
  readonly errors: readonly string[];
  /** What the policy took on the way with `bot.screenshot(name)`. */
  readonly shots: readonly { name: string; frame: number; path: string }[];
  /** Sizes and contrast on the picture (`screen-checks.ts`); warnings, the exit code ignores them. */
  readonly checks?: ScreenChecks | { error: string };
}

export interface ScreensReport {
  readonly out: string;
  /** `index.html` (the contact sheet, pictures by relative path) and its picture. */
  readonly html: string;
  /** The sheet with a box over every flagged node. */
  readonly sheet?: string;
  /** The sheet without the boxes, blurred: the squint test. */
  readonly blurred?: string;
  readonly pictures: readonly ScreenPicture[];
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Height of a tile on the sheet, CSS px: a phone screen readable, a dozen to a row. */
const TILE_HEIGHT = 480;

/** One line per finding: `tap-size btn-play 120×24 < 44`. */
export const describeViolation = (violation: ScreenViolation): string => {
  const what =
    violation.check === 'tap-size'
      ? `${violation.measured.width}×${violation.measured.height}`
      : violation.check === 'text-size'
        ? `${violation.measured} px`
        : `${violation.measured.median}:1 (worst quartile ${violation.measured.worstQuartile}:1)`;
  return `${violation.check} ${violation.node} ${what} < ${violation.threshold}`;
};

/** The checks' boxes over a tile, in % of the picture (hidden when the body is `plain`). */
const flagsHtml = (checks: ScreenPicture['checks']): string => {
  if (!checks || 'error' in checks) return '';
  const { width, height } = checks.viewport;
  if (!(width > 0) || !(height > 0)) return '';
  const pct = (value: number, of: number): string => `${((value / of) * 100).toFixed(3)}%`;
  return checks.violations
    .map(
      violation =>
        `<div class="flag ${violation.check}" title="${escapeHtml(describeViolation(violation))}" style="left:${pct(violation.box.x, width)};top:${pct(violation.box.y, height)};width:${pct(violation.box.width, width)};height:${pct(violation.box.height, height)}"></div>`
    )
    .join('');
};

/**
 * The contact sheet: a row per screen, a tile per picture (and the policy's shots after it), the
 * label in the corner as on `pix3 render`'s sheet; an errored tile is outlined red; a box over every
 * node a check flagged (red a tap target, orange a caption's size, magenta its contrast). Picture
 * paths are relative to `out`.
 */
export const screensSheetHtml = (
  pictures: readonly ScreenPicture[],
  relative: (path: string) => string
): string => {
  const tile = (src: string | undefined, label: string, error: boolean, flags = ''): string =>
    `<figure class="${error ? 'error' : ''}">${src ? `<img src="${escapeHtml(src)}">` : '<div class="none"></div>'}${flags}<figcaption>${escapeHtml(label)}</figcaption></figure>`;
  const rows = [...new Set(pictures.map(picture => picture.screen))].map(screen => {
    const tiles = pictures
      .filter(picture => picture.screen === screen)
      .flatMap(picture => {
        const label = [picture.locale, picture.size].filter(Boolean).join(' · ');
        return [
          tile(
            picture.file && relative(picture.file),
            picture.status === 'error' ? `${label} · error` : label,
            picture.status === 'error',
            flagsHtml(picture.checks)
          ),
          ...picture.shots.map(shot => tile(relative(shot.path), `${label} · ${shot.name}`, false)),
        ];
      });
    return `<section><h2>${escapeHtml(screen)}</h2><div class="row">${tiles.join('')}</div></section>`;
  });
  return `<!doctype html>
<meta charset="utf-8"><title>Screens</title>
<style>
body{margin:0;padding:16px;background:#8f9aa6;font:14px sans-serif;color:#fff;width:max-content}
h2{margin:0 0 8px;font-size:18px;font-weight:600;color:#1b1f24}
section{margin-bottom:20px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;width:max-content;max-width:2400px}
figure{margin:0;position:relative}
img,.none{height:${TILE_HEIGHT}px;display:block;border:1px solid rgba(0,0,0,.35)}
.none{width:${Math.round(TILE_HEIGHT * 0.46)}px;background:#3a3f46}
figcaption{position:absolute;left:0;top:0;background:rgba(0,0,0,.45);padding:4px 8px;white-space:nowrap}
.error img,.error .none{outline:3px solid #e5484d}
.flag{position:absolute;box-sizing:border-box;border:2px solid #ff1f3d}
.flag.text-size{border-color:#ff9f1a}
.flag.contrast{border-color:#ff2bd6;border-style:dashed}
.plain .flag{display:none}
</style>
${rows.join('\n')}
`;
};

export const formatScreensHuman = (report: ScreensReport): string => {
  const lines = [`screens: ${report.pictures.length} picture(s) in ${report.out}`];
  for (const picture of report.pictures) {
    const label = [picture.screen, picture.locale, picture.size].filter(Boolean).join(' ');
    lines.push(
      `  ${label}: ${picture.status === 'ok' ? 'ok' : 'ERROR'}${picture.file ? ` ${picture.file}` : ''}`
    );
    for (const error of picture.errors.slice(0, 3)) lines.push(`      error: ${error}`);
    for (const shot of picture.shots)
      lines.push(`      shot ${shot.name} (frame ${shot.frame}): ${shot.path}`);
    const checks = picture.checks;
    if (checks && 'error' in checks) lines.push(`      checks: ${checks.error}`);
    else if (checks) {
      lines.push(
        `      checks: ${checks.targets} target(s), ${checks.texts} caption(s)${checks.covered.length > 0 ? ` (${checks.covered.length} covered, not judged)` : ''}, ${checks.violations.length} warning(s)`
      );
      for (const violation of checks.violations)
        lines.push(`      warning: ${describeViolation(violation)}`);
      for (const caption of checks.covered)
        lines.push(`      covered: ${caption.node} under ${caption.by.node}`);
      for (const skipped of checks.notMeasured)
        lines.push(`      not measured: ${skipped.check} ${skipped.node} — ${skipped.reason}`);
    }
  }
  lines.push(`sheet: ${report.sheet ?? '(not drawn)'} — ${report.html}`);
  if (report.blurred) lines.push(`blurred: ${report.blurred}`);
  lines.push(`report: ${join(report.out, 'screens.json')}`);
  return `${lines.join('\n')}\n`;
};
