import { describe, expect, it } from 'vitest';

import { MODEL_VIEWS, parseModelViews } from './model-sheet';

describe('parseModelViews', () => {
  it('reads named views, azimuth:elevation pairs and all', () => {
    expect(parseModelViews('iso,30:-15')).toEqual([
      { name: 'iso', ...MODEL_VIEWS.iso },
      { name: '30:-15', azimuth: 30, elevation: -15 },
    ]);
    expect(parseModelViews('all')).toHaveLength(Object.keys(MODEL_VIEWS).length);
  });

  it('names the views it knows when one is unknown', () => {
    expect(parseModelViews('iso,diagonal')).toEqual({
      error: expect.stringContaining('unknown view "diagonal"'),
    });
  });
});
