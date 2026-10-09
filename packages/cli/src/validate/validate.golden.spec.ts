// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import type { Diagnostic } from './diagnostics.ts';
import { validateProject } from './validate.ts';

/**
 * Golden test against false errors (plan §5 A): every scene and prefab a template ships must pass
 * `pix3 validate` — both levels — with zero errors. A template is validated the way a user meets
 * it: scaffolded by `pix3 new` (placeholders substituted, manifest written), then validated as a
 * whole project, so unused-asset and prefab checks see the real tree. Warnings are allowed and
 * printed, so a new one is visible in the test output rather than silently accepted.
 */

/** The 1.x recipes, kept as fixture projects in the template layout (`.plans/templates.md`). */
const CORPUS_ROOT = fileURLToPath(
  new URL('../../../runtime/fixtures/scene-corpus', import.meta.url)
);
const scratch = mkdtempSync(join(tmpdir(), 'pix3-validate-golden-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const summarize = (label: string, diagnostics: readonly Diagnostic[]): void => {
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  if (warnings.length === 0) return;
  console.info(
    `${label}: ${warnings.length} warning(s)\n${warnings
      .map(w => `  ${w.file}${w.line ? `:${w.line}` : ''} ${w.code} ${w.message}`)
      .join('\n')}`
  );
};

const errorLines = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics
    .filter(d => d.severity === 'error')
    .map(d => `${d.file}${d.line ? `:${d.line}` : ''} ${d.code} ${d.message}`);

describe('pix3 validate golden: shipped templates have no errors', () => {
  // The starters `npm create pix3` ships, and the 1.x recipes kept as fixture projects (the
  // coverage these goldens had before create-pix3 went down to blank starters).
  const starters = listTemplates();
  const templates = [...starters, ...listTemplates(CORPUS_ROOT)];

  it('finds the starters and the fixture corpus', () => {
    expect(starters.map(t => t.id)).toEqual(['2d', '3d']);
    expect(templates.length - starters.length).toBeGreaterThanOrEqual(5);
  });

  for (const template of templates) {
    it(`${template.id} validates clean (levels 1 and 2)`, async () => {
      const dir = join(scratch, template.id);
      createProject({ template, dir, projectName: 'Golden' });
      const report = await validateProject({ projectRoot: dir });
      summarize(template.id, report.diagnostics);
      expect(report.files.length).toBeGreaterThan(0);
      expect(errorLines(report.diagnostics)).toEqual([]);
      // Level 2 must actually have hydrated every scene, user scripts included.
      expect(report.level2).toMatchObject({ state: 'ran', filesSkipped: 0 });
      expect(report.notes).toEqual([]);
    });
  }
});
