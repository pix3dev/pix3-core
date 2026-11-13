import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { stringifySceneYaml } from './scene-yaml';

describe('stringifySceneYaml', () => {
  it('writes scalar arrays and xyz maps on one line, nested lists as blocks', () => {
    const doc = {
      root: [
        {
          id: 'a',
          groups: ['enemy', 'boss'],
          properties: {
            transform: { position: [1.5, -2, 0], rotationEuler: [0, 90, 0] },
            offset: { x: 1, y: 2 },
            cells: [
              [0, 1],
              [2, 3],
            ],
            tint: { x: 1, y: 'red' },
          },
          children: [],
        },
      ],
    };
    const yaml = stringifySceneYaml(doc);
    expect(yaml).toContain('groups: [enemy, boss]');
    expect(yaml).toContain('position: [1.5, -2, 0]');
    expect(yaml).toContain('rotationEuler: [0, 90, 0]');
    expect(yaml).toContain('offset: {x: 1, y: 2}');
    expect(yaml).toMatch(/cells:\n\s+- \[0, 1\]\n\s+- \[2, 3\]/);
    expect(yaml).toMatch(/tint:\n\s+x: 1\n\s+y: red/);
    expect(yaml).toContain('children: []');
    expect(yaml).not.toMatch(/^\s*- -?\d/m);
    expect(parse(yaml)).toEqual(doc);
  });
});
