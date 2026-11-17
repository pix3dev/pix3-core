/**
 * The example model job and feedback (`.plans/model-jobs.md` Stage 2): the SAME literal as
 * `SAMPLE_JOB` / `SAMPLE_FEEDBACK` in `packages/cli/src/model/model.spec.ts`, so both readers of
 * format v1 are checked on one example. Change them together.
 */

export const SAMPLE_JOB = {
  v: 1,
  id: 'tower',
  title: 'Tower',
  status: 'running',
  target: 'res://scenes/prefabs/tower.prefab',
  node: null,
  reference: 'reference.png',
  referenceSha256: 'ab',
  referenceBackground: null,
  views: 'iso,front',
  size: 512,
  stages: ['blockout', 'structure', 'form', 'material', 'bake'],
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:10:00.000Z',
  result: null,
  wait: { pid: 4242, since: '2026-11-16T10:10:00.000Z', expiresAt: '2026-11-16T10:19:00.000Z' },
  feedback: { 'f-1763287800000-k3x9': { deliveredAt: '2026-11-16T10:06:00.000Z', addressedBy: 3 } },
  passes: [
    {
      seq: 3,
      stage: 'form',
      at: '2026-11-16T10:08:00.000Z',
      note: 'lathe for the tower body',
      forced: null,
      params: {
        target: 'res://scenes/prefabs/tower.prefab',
        node: null,
        views: 'iso,front',
        size: 512,
        lights: 'auto',
        background: '#8f9aa6',
        frames: 2,
        referenceSha256: 'ab',
        referenceBackground: null,
      },
      sheet: {
        file: 'passes/03-form/sheet.png',
        views: ['reference', 'iso', 'front'],
        tile: 512,
        cols: 2,
      },
      report: 'passes/03-form/report.json',
      metrics: {
        luminanceP50: 0.33,
        nearBlack: 0.02,
        saturationMedian: 0.41,
        silhouetteIoU: 0.71,
        saturationRatio: null,
        triangles: 1840,
        drawCalls: 1,
        notCompared: null,
      },
    },
  ],
};

export const SAMPLE_FEEDBACK = `{"v":1,"id":"f-1763287800000-k3x9","at":"2026-11-16T10:05:00.000Z","pass":3,"text":"roof too flat","verdict":"changes","marks":[{"view":"front","shape":"rect","rect":[0.1,0.55,0.3,0.2]},{"view":"iso","shape":"point","point":[0.7,0.2]},{"view":"iso","shape":"path","path":[[0.6,0.1],[0.8,0.3]]}],"image":"feedback/f-1763287800000-k3x9.png"}
{"v":1,"id":"f-1763287900000-p2q1","at":"2026-11-16T10:20:00.000Z","pass":3,"text":"","verdict":"accept","marks":[]}
`;
