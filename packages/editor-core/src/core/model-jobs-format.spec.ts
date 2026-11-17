import { describe, expect, it } from 'vitest';

import {
  isJobRelativePath,
  parseModelFeedback,
  parseModelJob,
  parseModelJobIndex,
} from './model-jobs-format';
import { SAMPLE_FEEDBACK, SAMPLE_JOB } from './model-jobs-format.test-helpers';

/** The editor's copy of format v1 reads the CLI's example the same way (`model.spec.ts`). */
describe('model-jobs format (editor copy)', () => {
  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(SAMPLE_JOB));

  it('reads the sample job and feedback the CLI shares', () => {
    expect(parseModelJob(JSON.stringify(SAMPLE_JOB))).toEqual(SAMPLE_JOB);
    for (const line of SAMPLE_FEEDBACK.trim().split('\n'))
      expect(parseModelFeedback(line)).not.toHaveProperty('error');
  });

  it('refuses broken JSON, another version, a path out of the job, a pass of an unknown stage', () => {
    expect(parseModelJob('{ nope')).toMatchObject({ error: expect.stringContaining('not JSON') });
    expect(parseModelJob(JSON.stringify({ ...valid(), v: 2 }))).toMatchObject({
      error: expect.stringContaining('format 2'),
    });
    expect(parseModelJob(JSON.stringify({ ...valid(), reference: '../x.png' }))).toEqual({
      error: 'reference: not a path inside the job',
    });
    const k = valid();
    (k.passes as { stage: string }[])[0].stage = 'paint';
    expect(parseModelJob(JSON.stringify(k))).toMatchObject({
      error: expect.stringContaining('not a stage'),
    });
    const feedback = (patch: Record<string, unknown>) =>
      parseModelFeedback(
        JSON.stringify({ ...JSON.parse(SAMPLE_FEEDBACK.split('\n')[0]), ...patch })
      );
    expect(feedback({ image: 'feedback/../../x.png' })).toEqual({
      error: 'image: not a path inside the job',
    });
    expect(feedback({ marks: [{ view: 'iso', shape: 'point', point: [2, 0] }] })).toEqual({
      error: 'marks[0].point[0]: outside 0..1',
    });
    expect(isJobRelativePath('passes/03-form/sheet.png')).toBe(true);
    expect(isJobRelativePath('C:/x.png')).toBe(false);
  });

  it('reads index.json as the CLI writes it, and refuses a malformed row', () => {
    const row = {
      id: 'tower',
      title: 'Tower',
      status: 'running',
      target: 'res://scenes/prefabs/tower.prefab',
      passes: 1,
      stage: 'form',
      updatedAt: '2026-11-16T10:10:00.000Z',
      wait: SAMPLE_JOB.wait,
    };
    expect(parseModelJobIndex(JSON.stringify({ v: 1, jobs: [row] }))).toEqual({
      v: 1,
      jobs: [row],
    });
    expect(parseModelJobIndex(JSON.stringify({ v: 1, jobs: [{ ...row, passes: -1 }] }))).toEqual({
      error: 'jobs[0].passes: not a count',
    });
    expect(parseModelJobIndex(JSON.stringify({ v: 1, jobs: [{ ...row, id: '../x' }] }))).toEqual({
      error: 'jobs[0].id: not a [a-z0-9-] slug',
    });
  });
});
